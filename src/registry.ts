import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Db } from "./db.js";
import { headSha, repoRoot } from "./git.js";
import type { RegisteredRepo, RepoId } from "./types.js";

interface RepoRow {
  id: string;
  name: string;
  path: string;
  registered_at: string;
  last_indexed_commit: string | null;
  last_indexed_at: string | null;
  file_count: number;
}

function toRepo(r: RepoRow): RegisteredRepo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    registeredAt: r.registered_at,
    lastIndexedCommit: r.last_indexed_commit,
    lastIndexedAt: r.last_indexed_at,
    fileCount: r.file_count,
  };
}

export function repoIdForPath(absPath: string): RepoId {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 12);
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
    const id = repoIdForPath(root);
    const existing = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
    const finalName = name ?? existing?.name ?? this.uniqueName(basename(root));
    if (existing) {
      this.db.prepare("UPDATE repos SET name = ? WHERE id = ?").run(finalName, id);
    } else {
      this.assertNameFree(finalName);
      this.db
        .prepare("INSERT INTO repos (id, name, path, registered_at) VALUES (?, ?, ?, ?)")
        .run(id, finalName, root, new Date().toISOString());
    }
    return this.get(id)!;
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

  /** Resolve by id, name, or filesystem path. */
  resolve(ref: string): RegisteredRepo {
    const byId = this.get(ref);
    if (byId) return byId;
    const byName = this.db.prepare("SELECT * FROM repos WHERE name = ?").get(ref) as RepoRow | undefined;
    if (byName) return toRepo(byName);
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
