import type { Db } from "./db.js";
import { inTransaction } from "./db.js";
import type { CacheCounters, CacheStats, FileRecord, RepoId } from "./types.js";

export const SUMMARIZER_VERSION = 1;

export type CounterKey = keyof CacheCounters;
const COUNTER_KEYS: CounterKey[] = [
  "fileHits",
  "fileMisses",
  "repoHits",
  "repoMisses",
  "invalidations",
  "reindexes",
  "rawBytesAvoided",
  "summaryBytesServed",
  "tokensSaved",
  "contextPacksServed",
];

export interface CachedFile extends FileRecord {
  blobSha: string;
  keywords: string;
}

export interface CachedRepoSummary {
  repoId: RepoId;
  commitSha: string;
  overview: string;
  languages: Record<string, number>;
  topPaths: string[];
  fileCount: number;
}

interface FileRow {
  repo_id: string;
  commit_sha: string;
  path: string;
  language: string;
  byte_size: number;
  summary: string;
  symbols: string;
  keywords: string;
  blob_sha: string;
  indexed_at: string;
}

function toFile(r: FileRow): CachedFile {
  return {
    repoId: r.repo_id,
    commitSha: r.commit_sha,
    path: r.path,
    language: r.language,
    byteSize: r.byte_size,
    summary: r.summary,
    symbols: JSON.parse(r.symbols) as string[],
    keywords: r.keywords,
    blobSha: r.blob_sha,
    contentHash: r.blob_sha,
    indexedAt: r.indexed_at,
  };
}

/**
 * Summary cache keyed by (repoId, commitSha, path). Hit/miss and token-savings
 * counters are persisted in SQLite (shared by every client) and mirrored per-process.
 */
export class Cache {
  readonly session: CacheCounters = emptyCounters();

  constructor(
    private readonly db: Db,
    readonly dbPath: string,
  ) {}

  bump(key: CounterKey, n = 1): void {
    if (n === 0) return;
    this.session[key] += n;
    this.db
      .prepare(
        "INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value",
      )
      .run(key, n);
  }

  /** Persist raw-vs-summary byte avoidance and estimated token savings atomically. */
  recordSavings(
    rawBytesTotal: number,
    summaryBytesServed: number,
    opts: { contextPacksServed?: number } = {},
  ): { rawBytesAvoided: number; summaryBytesServed: number; tokensSaved: number } {
    const avoided = Math.max(0, rawBytesTotal - summaryBytesServed);
    const savedTokens = Math.floor(avoided / 4);
    inTransaction(this.db, () => {
      this.bump("summaryBytesServed", summaryBytesServed);
      this.bump("rawBytesAvoided", avoided);
      this.bump("tokensSaved", savedTokens);
      if (opts.contextPacksServed) {
        this.bump("contextPacksServed", opts.contextPacksServed);
      }
    });
    return {
      rawBytesAvoided: avoided,
      summaryBytesServed,
      tokensSaved: savedTokens,
    };
  }

  /** Counted lookup: exact (repo, commit, path) key. */
  getFile(repoId: RepoId, commitSha: string, path: string): CachedFile | undefined {
    const row = this.peekFile(repoId, commitSha, path);
    this.bump(row ? "fileHits" : "fileMisses");
    return row;
  }

  peekFile(repoId: RepoId, commitSha: string, path: string): CachedFile | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM files WHERE repo_id = ? AND commit_sha = ? AND path = ? AND summarizer_version = ?",
      )
      .get(repoId, commitSha, path, SUMMARIZER_VERSION) as FileRow | undefined;
    return row ? toFile(row) : undefined;
  }

  /** A summary from any earlier commit for identical content (same blob at same path). */
  findByBlob(repoId: RepoId, path: string, blobSha: string): CachedFile | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM files WHERE repo_id = ? AND path = ? AND blob_sha = ? AND summarizer_version = ? LIMIT 1",
      )
      .get(repoId, path, blobSha, SUMMARIZER_VERSION) as FileRow | undefined;
    return row ? toFile(row) : undefined;
  }

  putFile(f: CachedFile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files
         (repo_id, commit_sha, path, language, byte_size, summary, symbols, keywords, blob_sha, summarizer_version, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.repoId,
        f.commitSha,
        f.path,
        f.language,
        f.byteSize,
        f.summary,
        JSON.stringify(f.symbols),
        f.keywords,
        f.blobSha,
        SUMMARIZER_VERSION,
        f.indexedAt,
      );
  }

  listFiles(repoId: RepoId, commitSha: string): CachedFile[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE repo_id = ? AND commit_sha = ? AND summarizer_version = ? ORDER BY path")
      .all(repoId, commitSha, SUMMARIZER_VERSION) as unknown as FileRow[];
    return rows.map(toFile);
  }

  sumFileBytes(repoId: RepoId, commitSha: string): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(byte_size), 0) AS total FROM files WHERE repo_id = ? AND commit_sha = ? AND summarizer_version = ?",
      )
      .get(repoId, commitSha, SUMMARIZER_VERSION) as { total: number };
    return r.total;
  }

  countFiles(repoId: RepoId, commitSha: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ? AND commit_sha = ? AND summarizer_version = ?")
      .get(repoId, commitSha, SUMMARIZER_VERSION) as { n: number };
    return r.n;
  }

  getRepoSummary(repoId: RepoId, commitSha: string): CachedRepoSummary | undefined {
    const r = this.db
      .prepare("SELECT * FROM repo_summaries WHERE repo_id = ? AND commit_sha = ? AND summarizer_version = ?")
      .get(repoId, commitSha, SUMMARIZER_VERSION) as
      | { overview: string; languages: string; top_paths: string; file_count: number }
      | undefined;
    if (!r) return undefined;
    return {
      repoId,
      commitSha,
      overview: r.overview,
      languages: JSON.parse(r.languages) as Record<string, number>,
      topPaths: JSON.parse(r.top_paths) as string[],
      fileCount: r.file_count,
    };
  }

  putRepoSummary(s: CachedRepoSummary): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO repo_summaries
         (repo_id, commit_sha, overview, languages, top_paths, file_count, summarizer_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.repoId,
        s.commitSha,
        s.overview,
        JSON.stringify(s.languages),
        JSON.stringify(s.topPaths),
        s.fileCount,
        SUMMARIZER_VERSION,
        new Date().toISOString(),
      );
  }

  /** Drop cached data for commits older than the newest `keep` summaries. */
  prune(repoId: RepoId, keep: number): void {
    inTransaction(this.db, () => {
      const old = this.db
        .prepare(
          "SELECT commit_sha FROM repo_summaries WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
        )
        .all(repoId, keep) as { commit_sha: string }[];
      for (const { commit_sha } of old) {
        this.db.prepare("DELETE FROM files WHERE repo_id = ? AND commit_sha = ?").run(repoId, commit_sha);
        this.db.prepare("DELETE FROM repo_summaries WHERE repo_id = ? AND commit_sha = ?").run(repoId, commit_sha);
      }
    });
  }

  deleteRepo(repoId: RepoId): void {
    this.db.prepare("DELETE FROM files WHERE repo_id = ?").run(repoId);
    this.db.prepare("DELETE FROM repo_summaries WHERE repo_id = ?").run(repoId);
  }

  /** Remove everything cached for a repo (all commits). */
  clearRepo(repoId: RepoId): void {
    this.deleteRepo(repoId);
  }

  counters(): CacheCounters {
    const out = emptyCounters();
    const rows = this.db.prepare("SELECT key, value FROM counters").all() as { key: string; value: number }[];
    for (const { key, value } of rows) {
      if ((COUNTER_KEYS as string[]).includes(key)) out[key as CounterKey] = value;
    }
    return out;
  }

  resetCounters(): void {
    this.db.exec("DELETE FROM counters");
    for (const k of COUNTER_KEYS) this.session[k] = 0;
  }

  stats(): CacheStats {
    const c = this.counters();
    const hits = c.fileHits + c.repoHits;
    const misses = c.fileMisses + c.repoMisses;
    const repos = (this.db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n;
    const files = (this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    return {
      ...c,
      hits,
      misses,
      hitRate: hits + misses === 0 ? 0 : Number((hits / (hits + misses)).toFixed(4)),
      repos,
      files,
      dbPath: this.dbPath,
      session: { ...this.session },
    };
  }
}

export function emptyCounters(): CacheCounters {
  return {
    fileHits: 0,
    fileMisses: 0,
    repoHits: 0,
    repoMisses: 0,
    invalidations: 0,
    reindexes: 0,
    rawBytesAvoided: 0,
    summaryBytesServed: 0,
    tokensSaved: 0,
    contextPacksServed: 0,
  };
}
