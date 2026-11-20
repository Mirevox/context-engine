import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ContextEngine } from "./engine.js";

export interface HttpOptions {
  token?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Binding beyond loopback without a bearer token would expose local corpora; fail closed. */
export function assertSafeBind(host: string, token = process.env.CONTEXT_ENGINE_TOKEN): void {
  if (!LOOPBACK.has(host) && !token) {
    throw new Error(`Refusing to bind ${host} without CONTEXT_ENGINE_TOKEN (use 127.0.0.1 or set a token)`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

function need(v: string | null | undefined, name: string): string {
  if (!v) throw new HttpError(400, `Missing required parameter: ${name}`);
  return v;
}

/**
 * JSON API:
 *   GET    /health
 *   GET    /repos                      POST /repos {path,name?}
 *   DELETE /repos/:ref
 *   GET    /repos/:ref/summary         POST /repos/:ref/reindex {force?}
 *   GET    /search?q=&repo=&limit=
 *   GET    /file?repo=&path=&content=1&max_chars=
 *   GET    /stats
 */
export function createHttpServer(engine: ContextEngine, opts: HttpOptions = {}): Server {
  const token = opts.token ?? process.env.CONTEXT_ENGINE_TOKEN;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      let parts: string[];
      try {
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new HttpError(400, "Malformed URI encoding");
      }
      const q = url.searchParams;

      if (token && url.pathname !== "/health") {
        if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, "Unauthorized");
      }

      if (method === "GET" && parts[0] === "health" && parts.length === 1) {
        try {
          engine.db.prepare("SELECT 1 AS ok").get();
          const repos = engine.registry.list().length;
          return send(res, 200, {
            ok: true,
            name: "mirevox-context-engine",
            db: "ok",
            repos,
            dataDir: engine.config.dataDir,
          });
        } catch (err) {
          return send(res, 503, {
            ok: false,
            name: "mirevox-context-engine",
            db: "error",
            error: ((err as Error).message ?? String(err)).split("\n")[0],
          });
        }
      }
      if (parts[0] === "repos") {
        if (parts.length === 1 && method === "GET") return send(res, 200, engine.listRepos());
        if (parts.length === 1 && method === "POST") {
          const body = await readJson(req);
          const path = need(typeof body.path === "string" ? body.path : null, "path");
          const name = typeof body.name === "string" ? body.name : undefined;
          return send(res, 201, engine.registerRepo(path, { name, index: body.index !== false }));
        }
        if (parts.length === 2 && method === "DELETE") return send(res, 200, engine.unregisterRepo(parts[1]!));
        if (parts.length === 3 && parts[2] === "summary" && method === "GET") {
          return send(res, 200, engine.repoSummary(parts[1]!));
        }
        if (parts.length === 3 && parts[2] === "reindex" && method === "POST") {
          const body = await readJson(req);
          return send(res, 200, engine.reindexRepo(parts[1]!, body.force !== false));
        }
      }
      if (method === "GET" && parts[0] === "search" && parts.length === 1) {
        const rawLimit = q.get("limit");
        let limit: number | undefined;
        if (rawLimit) {
          limit = Number(rawLimit);
          if (!Number.isFinite(limit)) throw new HttpError(400, `Invalid limit: ${rawLimit}`);
        }
        return send(res, 200, engine.search(need(q.get("q"), "q"), { repo: q.get("repo") ?? undefined, limit }));
      }
      if (method === "GET" && parts[0] === "file" && parts.length === 1) {
        const rawMax = q.get("max_chars");
        let maxChars: number | undefined;
        if (rawMax) {
          maxChars = Number(rawMax);
          if (!Number.isFinite(maxChars)) throw new HttpError(400, `Invalid max_chars: ${rawMax}`);
        }
        return send(
          res,
          200,
          engine.fileContext(need(q.get("repo"), "repo"), need(q.get("path"), "path"), {
            includeContent: q.get("content") === "1" || q.get("content") === "true",
            maxChars,
          }),
        );
      }
      if (method === "GET" && parts[0] === "stats" && parts.length === 1) return send(res, 200, engine.stats());
      throw new HttpError(404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      const msg = ((err as Error).message ?? String(err)).split("\n")[0] ?? "Internal error";
      const status = /^Unknown repo|not found/i.test(msg)
        ? 404
        : /Refusing to read secret/i.test(msg)
          ? 403
          : /Ambiguous repo/i.test(msg)
            ? 409
            : /Not a (directory|git)|already registered|Invalid |Missing |File not indexed/i.test(msg)
              ? 400
              : 500;
      send(res, status, { error: msg });
    }
  });
}
