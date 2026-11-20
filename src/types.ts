export type RepoId = string;

export interface RegisteredRepo {
  id: RepoId;
  name: string;
  path: string;
  registeredAt: string;
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  fileCount: number;
}

export interface FileRecord {
  repoId: RepoId;
  commitSha: string;
  path: string;
  language: string;
  byteSize: number;
  summary: string;
  symbols: string[];
  contentHash: string;
  indexedAt: string;
}

export interface CacheCounters {
  fileHits: number;
  fileMisses: number;
  repoHits: number;
  repoMisses: number;
  invalidations: number;
  reindexes: number;
}

export interface CacheStats extends CacheCounters {
  /** Aggregate hit/miss across file and repo lookups. */
  hits: number;
  misses: number;
  hitRate: number;
  repos: number;
  files: number;
  dbPath: string;
  session: CacheCounters;
}

export interface SearchHit {
  repoId: RepoId;
  repoName: string;
  path: string;
  commitSha: string;
  language: string;
  snippet: string;
  symbols: string[];
  score: number;
}

export interface RepoSummary {
  repo: RegisteredRepo;
  commitSha: string;
  fileCount: number;
  languages: Record<string, number>;
  topPaths: string[];
  overview: string;
  cacheHit: boolean;
}

export interface FileContext {
  repoId: RepoId;
  repoName: string;
  commitSha: string;
  path: string;
  language: string;
  byteSize: number;
  summary: string;
  symbols: string[];
  cacheHit: boolean;
  content?: string;
  truncated?: boolean;
}

export interface IndexResult {
  repoId: RepoId;
  commitSha: string;
  filesIndexed: number;
  filesReused: number;
  filesSkipped: number;
  durationMs: number;
  reason: "initial" | "head-changed" | "forced" | "fresh";
}
