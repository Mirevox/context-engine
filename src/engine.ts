import { Cache } from "./cache.js";
import { loadConfig, type ConfigOverrides, type EngineConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { headSha, readFileAt } from "./git.js";
import { Indexer } from "./indexer.js";
import { Registry } from "./registry.js";
import { isSecretPath, summarizeFile, tokenize } from "./summarizer.js";
import type {
  CacheStats,
  FileContext,
  IndexResult,
  RegisteredRepo,
  RepoSummary,
  SearchHit,
} from "./types.js";

export interface RepoStatus extends RegisteredRepo {
  headCommit: string | null;
  stale: boolean;
  error?: string;
}

export interface FreshResult {
  repo: RegisteredRepo;
  commitSha: string;
  /** Present when the repo had to be (re)indexed to serve this request. */
  indexed?: IndexResult;
}

/** Facade shared by the CLI, MCP server and HTTP server. */
export class ContextEngine {
  readonly config: EngineConfig;
  readonly db: Db;
  readonly cache: Cache;
  readonly registry: Registry;
  readonly indexer: Indexer;

  constructor(overrides: ConfigOverrides = {}) {
    this.config = loadConfig(overrides);
    this.db = openDb(this.config.dbPath);
    this.cache = new Cache(this.db, this.config.dbPath);
    this.registry = new Registry(this.db);
    this.indexer = new Indexer(this.db, this.cache, this.registry, this.config);
  }

  close(): void {
    this.db.close();
  }

  registerRepo(path: string, opts: { name?: string; index?: boolean } = {}): { repo: RegisteredRepo; indexed?: IndexResult } {
    const repo = this.registry.register(path, opts.name);
    if (opts.index === false) return { repo };
    const indexed = this.ensureFresh(repo.id).indexed;
    return { repo: this.registry.get(repo.id)!, indexed };
  }

  unregisterRepo(ref: string): RegisteredRepo {
    const repo = this.registry.unregister(ref);
    this.cache.deleteRepo(repo.id);
    return repo;
  }

  listRepos(): RepoStatus[] {
    return this.registry.list().map((repo) => {
      try {
        const head = headSha(repo.path);
        return { ...repo, headCommit: head, stale: repo.lastIndexedCommit !== head };
      } catch (err) {
        return { ...repo, headCommit: null, stale: true, error: (err as Error).message.split("\n")[0] };
      }
    });
  }

  /**
   * Commit-aware invalidation: compare git HEAD with the last indexed SHA and
   * reindex when they differ. A matching SHA with data present is a cache hit.
   */
  ensureFresh(ref: string): FreshResult {
    const repo = this.registry.resolve(ref);
    const sha = headSha(repo.path);
    const cached = this.cache.getRepoSummary(repo.id, sha);
    if (repo.lastIndexedCommit === sha && cached) {
      this.cache.bump("repoHits");
      return { repo, commitSha: sha };
    }
    this.cache.bump("repoMisses");
    if (repo.lastIndexedCommit && repo.lastIndexedCommit !== sha) this.cache.bump("invalidations");
    const indexed = this.indexer.index(repo);
    return { repo: this.registry.get(repo.id)!, commitSha: sha, indexed };
  }

  reindexRepo(ref: string, force = true): IndexResult {
    const repo = this.registry.resolve(ref);
    const result = this.indexer.index(repo, { force });
    return result;
  }

  repoSummary(ref: string): RepoSummary {
    const fresh = this.ensureFresh(ref);
    const s = this.cache.getRepoSummary(fresh.repo.id, fresh.commitSha)!;
    return {
      repo: fresh.repo,
      commitSha: fresh.commitSha,
      fileCount: s.fileCount,
      languages: s.languages,
      topPaths: s.topPaths,
      overview: s.overview,
      cacheHit: !fresh.indexed,
    };
  }

  search(query: string, opts: { repo?: string; limit?: number } = {}): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    if (opts.limit !== undefined && !Number.isFinite(opts.limit)) {
      throw new Error(`Invalid limit: ${String(opts.limit)}`);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const repos = opts.repo ? [this.registry.resolve(opts.repo)] : this.registry.list();
    const phrase = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    for (const r of repos) {
      const fresh = this.ensureFresh(r.id);
      for (const f of this.cache.listFiles(fresh.repo.id, fresh.commitSha)) {
        const pathL = f.path.toLowerCase();
        const symL = f.symbols.join(" ").toLowerCase();
        const sumL = f.summary.toLowerCase();
        const kw = new Set(f.keywords.split(" "));
        let score = 0;
        for (const t of terms) {
          if (pathL.includes(t)) score += 3;
          if (symL.includes(t)) score += 4;
          if (sumL.includes(t)) score += 1.5;
          if (kw.has(t)) score += 1;
        }
        if (phrase.length > 3 && (sumL.includes(phrase) || pathL.includes(phrase))) score += 3;
        if (score > 0) {
          hits.push({
            repoId: fresh.repo.id,
            repoName: fresh.repo.name,
            path: f.path,
            commitSha: fresh.commitSha,
            language: f.language,
            snippet: f.summary,
            symbols: f.symbols.slice(0, 10),
            score: Number(score.toFixed(2)),
          });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score || a.repoName.localeCompare(b.repoName) || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  }

  fileContext(ref: string, path: string, opts: { includeContent?: boolean; maxChars?: number } = {}): FileContext {
    const fresh = this.ensureFresh(ref);
    const normalized = path.replace(/^\.?\//, "");
    if (isSecretPath(normalized)) throw new Error(`Refusing to read secret-shaped path: ${normalized}`);
    let rec = this.cache.getFile(fresh.repo.id, fresh.commitSha, normalized);
    let cacheHit = !!rec;
    let content: Buffer | null = null;
    if (!rec) {
      // Path was not indexed (too large, skipped type, ...) but may exist in the commit.
      content = readFileAt(fresh.repo.path, fresh.commitSha, normalized);
      if (!content) throw new Error(`File not found at ${fresh.commitSha.slice(0, 12)}: ${normalized}`);
      const s = summarizeFile(normalized, content.toString("utf8"));
      rec = {
        repoId: fresh.repo.id,
        commitSha: fresh.commitSha,
        path: normalized,
        language: s.language,
        byteSize: content.length,
        summary: s.summary,
        symbols: s.symbols,
        keywords: s.keywords,
        blobSha: "",
        contentHash: "",
        indexedAt: new Date().toISOString(),
      };
      cacheHit = false;
    }
    const out: FileContext = {
      repoId: fresh.repo.id,
      repoName: fresh.repo.name,
      commitSha: fresh.commitSha,
      path: rec.path,
      language: rec.language,
      byteSize: rec.byteSize,
      summary: rec.summary,
      symbols: rec.symbols,
      cacheHit: cacheHit && !fresh.indexed,
    };
    if (opts.includeContent) {
      content ??= readFileAt(fresh.repo.path, fresh.commitSha, normalized);
      const max = opts.maxChars ?? 8000;
      const text = content?.toString("utf8") ?? "";
      out.content = text.slice(0, max);
      out.truncated = text.length > max;
    }
    return out;
  }

  stats(): CacheStats {
    return this.cache.stats();
  }
}
