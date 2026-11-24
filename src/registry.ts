import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inTransaction, type Db } from "./db.js";
import { headSha, originRemoteUrl, repoRoot } from "./git.js";
import type { RegisteredRepo, RepoId } from "./types.js";

interface RepoRow {
  id: string;
  name: string;
  path: string;
  remote_url?: string | null;
  registered_at: string;
  last_indexed_commit: string | null;
  last_indexed_at: string | null;
  file_count: number;
}

export interface CanonicalRepoIdentity {
  id: RepoId;
  remoteUrl: string | null;
}

const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:"]);

function toRepo(r: RepoRow): RegisteredRepo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    remoteUrl: r.remote_url ?? null,
    registeredAt: r.registered_at,
    lastIndexedCommit: r.last_indexed_commit,
    lastIndexedAt: r.last_indexed_at,
    fileCount: r.file_count,
  };
}

export function repoIdForPath(absPath: string): RepoId {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 12);
}

/**
 * Normalize an origin remote URL (HTTPS, SSH, git://, or SCP-like git@host:owner/repo.git)
 * into `host/owner/repo`. Rejects local `file://` URLs and bare filesystem paths -> `null`.
 */
export function normalizeRemoteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^file:\/\//i.test(trimmed)) return null;
  if (/^([./~]|\\|[A-Za-z]:[/\\])/.test(trimmed)) return null;

  let host = "";
  let rawPath = "";

  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!REMOTE_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    host = parsed.hostname.toLowerCase();
    rawPath = parsed.pathname;
  } else {
    const scp = /^(?:([^@/\s]+)@)?([A-Za-z0-9.-]+):\/?(.+)$/.exec(trimmed);
    if (!scp) return null;
    const hasUser = Boolean(scp[1]);
    host = scp[2]!.toLowerCase();
    rawPath = scp[3]!;
    // Reject single-letter drive names or ambiguous bare tokens without domain/user.
    if (host.length <= 1 || (!hasUser && !host.includes("."))) return null;
    if (rawPath.includes("\\")) return null;
  }

  if (!host) return null;
  const cleanPath = rawPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");

  if (!cleanPath || !cleanPath.includes("/") || cleanPath.split("/").some((seg) => !seg || seg === "." || seg === "..")) {
    return null;
  }
  return `${host}/${cleanPath}`.toLowerCase();
}

export function repoIdForRemote(canonical: string): RepoId {
  return createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}

export function resolveCanonicalRepo(rootRealPath: string): CanonicalRepoIdentity {
  const raw = originRemoteUrl(rootRealPath);
  const remoteUrl = normalizeRemoteUrl(raw);
  const id = remoteUrl ? repoIdForRemote(remoteUrl) : repoIdForPath(rootRealPath);
  return { id, remoteUrl };
}

export class Registry {
  constructor(private readonly db: Db) {}

  register(inputPath: string, name?: string): RegisteredRepo {
    const abs = resolve(inputPath);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`Not a directory: ${abs}`);
    }
    let root: string;
    try {
      root = realpathSync(repoRoot(abs));
      headSha(root);
    } catch {
      throw new Error(`Not a git repository with at least one commit: ${abs}`);
    }
    const { id, remoteUrl } = resolveCanonicalRepo(root);

    return inTransaction(this.db, () => {
      const byId = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
      const byPath = this.db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as RepoRow | undefined;

      if (byId) {
        const finalName = name ?? byId.name;
        if (finalName !== byId.name) this.assertNameFree(finalName);
        if (byPath && byPath.id !== byId.id) {
          this.db.prepare("DELETE FROM files WHERE repo_id = ?").run(byPath.id);
          this.db.prepare("DELETE FROM repo_summaries WHERE repo_id = ?").run(byPath.id);
          this.db.prepare("DELETE FROM repos WHERE id = ?").run(byPath.id);
        }
        this.db
          .prepare("UPDATE repos SET name = ?, path = ?, remote_url = ? WHERE id = ?")
          .run(finalName, root, remoteUrl, id);
        return this.get(id)!;
      }

      if (byPath) {
        const oldId = byPath.id;
        const finalName = name ?? byPath.name;
        if (finalName !== byPath.name) this.assertNameFree(finalName);
        this.db
          .prepare("UPDATE repos SET id = ?, name = ?, remote_url = ? WHERE id = ?")
          .run(id, finalName, remoteUrl, oldId);
        if (oldId !== id) {
          this.db.prepare("DELETE FROM files WHERE repo_id = ?").run(id);
          this.db.prepare("UPDATE files SET repo_id = ? WHERE repo_id = ?").run(id, oldId);
          this.db.prepare("DELETE FROM repo_summaries WHERE repo_id = ?").run(id);
          this.db.prepare("UPDATE repo_summaries SET repo_id = ? WHERE repo_id = ?").run(id, oldId);
        }
        return this.get(id)!;
      }

      const finalName = name ?? this.uniqueName(basename(root));
      this.assertNameFree(finalName);
      this.db
        .prepare("INSERT INTO repos (id, name, path, remote_url, registered_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, finalName, root, remoteUrl, new Date().toISOString());
      return this.get(id)!;
    });
  }

  private assertNameFree(name: string): void {
    if (this.db.prepare("SELECT 1 FROM repos WHERE name = ?").get(name)) {
      throw new Error(`A repo named "${name}" is already registered; choose another --name`);
    }
  }

  private uniqueName(base: string): string {
    let name = base;
    let i = 2;
    while (this.db.prepare("SELECT 1 FROM repos WHERE name = ?").get(name)) name = `${base}-${i++}`;
    return name;
  }

  get(id: RepoId): RegisteredRepo | undefined {
    const r = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
    return r ? toRepo(r) : undefined;
  }

  list(): RegisteredRepo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY name").all() as unknown as RepoRow[]).map(toRepo);
  }

  /** Resolve by id, name, filesystem path, or remote URL. */
  resolve(ref: string): RegisteredRepo {
    const byId = this.get(ref);
    if (byId) return byId;
    const byName = this.db.prepare("SELECT * FROM repos WHERE name = ?").all(ref) as unknown as RepoRow[];
    if (byName.length > 1) {
      throw new Error(`Ambiguous repo name "${ref}" matches ${byName.length} repos; pass an id or path`);
    }
    if (byName.length === 1) return toRepo(byName[0]!);

    const abs = resolve(ref);
    const candidates = [abs];
    try {
      candidates.push(realpathSync(abs));
    } catch {
      /* not a path */
    }
    for (const p of candidates) {
      const byPath = this.db.prepare("SELECT * FROM repos WHERE path = ?").get(p) as RepoRow | undefined;
      if (byPath) return toRepo(byPath);
    }

    const norm = normalizeRemoteUrl(ref);
    const remoteLookup = norm ?? ref.trim().toLowerCase();
    if (remoteLookup) {
      const byRemote = this.db
        .prepare("SELECT * FROM repos WHERE remote_url = ?")
        .get(remoteLookup) as RepoRow | undefined;
      if (byRemote) return toRepo(byRemote);
    }

    throw new Error(`Unknown repo "${ref}". Register it first (context-engine register <path>).`);
  }

  unregister(ref: string): RegisteredRepo {
    const repo = this.resolve(ref);
    this.db.prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
    return repo;
  }

  markIndexed(id: RepoId, commitSha: string, fileCount: number): void {
    this.db
      .prepare("UPDATE repos SET last_indexed_commit = ?, last_indexed_at = ?, file_count = ? WHERE id = ?")
      .run(commitSha, new Date().toISOString(), fileCount, id);
  }
}
