import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ContextEngine } from "./engine.js";
import type { AppcodeDocInput } from "./types.js";
import { BackgroundIndexer } from "./worker.js";

export interface HttpOptions {
  token?: string;
  worker?: BackgroundIndexer;
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

function parseAppcodeDoc(raw: unknown): AppcodeDocInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "Invalid document entry");
  }
  const d = raw as Record<string, unknown>;
  const source = typeof d.source === "string" ? d.source : "";
  const docId = typeof d.docId === "string" ? d.docId : typeof d.doc_id === "string" ? d.doc_id : "";
  const title = typeof d.title === "string" ? d.title : "";
  const content = typeof d.content === "string" ? d.content : "";
  const metadata =
    d.metadata && typeof d.metadata === "object" && !Array.isArray(d.metadata)
      ? (d.metadata as Record<string, unknown>)
      : undefined;
  return {
    source,
    docId,
    title,
    content,
    uri: typeof d.uri === "string" ? d.uri : typeof d.path === "string" ? d.path : undefined,
    stage: typeof d.stage === "string" ? d.stage : undefined,
    metadata,
    priority: typeof d.priority === "number" ? d.priority : undefined,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : typeof d.updated_at === "string" ? d.updated_at : undefined,
  };
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
 *   POST   /appcodes/:appcode/ingest   {docs}
 *   GET    /appcodes/:appcode/context-pack?budget_tokens=&stage=&sources=&query=
 *   GET    /appcodes/:appcode/documents?stage=&source=&limit=
 *   POST   /worker/tick                {repo?, force?}
 *   GET    /worker/status
 */
export function createHttpServer(engine: ContextEngine, opts: HttpOptions = {}): Server {
  const token = opts.token ?? process.env.CONTEXT_ENGINE_TOKEN;
  const worker = opts.worker ?? new BackgroundIndexer(engine);
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
            version: "0.2.0",
            db: "ok",
            repos,
            dataDir: engine.config.dataDir,
          });
        } catch (err) {
          return send(res, 503, {
            ok: false,
            name: "mirevox-context-engine",
            version: "0.2.0",
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
      if (parts[0] === "appcodes" && parts.length === 3) {
        const appcode = need(parts[1], "appcode");
        if (parts[2] === "ingest" && method === "POST") {
          const body = await readJson(req);
          const rawDocs = Array.isArray(body.docs)
            ? body.docs
            : Array.isArray(body.documents)
              ? body.documents
              : null;
          if (!rawDocs) throw new HttpError(400, "Missing required parameter: docs");
          const docs = rawDocs.map(parseAppcodeDoc);
          return send(res, 200, engine.ingestAppcodeDocuments(appcode, docs));
        }
        if (parts[2] === "context-pack" && method === "GET") {
          const rawBudget = q.get("budget_tokens");
          let budgetTokens: number | undefined;
          if (rawBudget) {
            budgetTokens = Number(rawBudget);
            if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
              throw new HttpError(400, `Invalid budget_tokens: ${rawBudget}`);
            }
          }
          const sourcesParam = q
            .getAll("sources")
            .flatMap((s) => s.split(","))
            .map((s) => s.trim())
            .filter(Boolean);
          return send(
            res,
            200,
            engine.getAppcodeContextPack(appcode, {
              budgetTokens,
              stage: q.get("stage") || undefined,
              sources: sourcesParam.length > 0 ? sourcesParam : undefined,
              query: q.get("query") || undefined,
            }),
          );
        }
        if (parts[2] === "documents" && method === "GET") {
          const rawLimit = q.get("limit");
          let limit: number | undefined;
          if (rawLimit) {
            limit = Number(rawLimit);
            if (!Number.isFinite(limit)) throw new HttpError(400, `Invalid limit: ${rawLimit}`);
          }
          return send(
            res,
            200,
            engine.listAppcodeDocuments(appcode, {
              stage: q.get("stage") || undefined,
              source: q.get("source") || undefined,
              limit,
              includeContent: q.get("include_content") === "1" || q.get("include_content") === "true",
            }),
          );
        }
      }
      if (parts[0] === "worker" && parts.length === 2) {
        if (parts[1] === "tick" && method === "POST") {
          const body = await readJson(req);
          const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined;
          const force = body.force === true;
          return send(res, 200, await worker.tick({ repo, force }));
        }
        if (parts[1] === "status" && method === "GET") {
          return send(res, 200, worker.status());
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
        : /Refusing to (read|ingest) secret/i.test(msg)
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
