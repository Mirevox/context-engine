export type RepoId = string;

export interface RegisteredRepo {
  id: RepoId;
  name: string;
  path: string;
  remoteUrl?: string | null;
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
  rawBytesAvoided: number;
  summaryBytesServed: number;
  tokensSaved: number;
  contextPacksServed: number;
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

export interface AppcodeDocInput {
  source: string;
  docId: string;
  title: string;
  content: string;
  uri?: string;
  stage?: string;
  metadata?: Record<string, unknown>;
  priority?: number;
  updatedAt?: string;
}

export interface AppcodeDocument {
  appcode: string;
  source: string;
  docId: string;
  title: string;
  uri: string;
  stage: string;
  contentHash: string;
  rawBytes: number;
  summary: string;
  summaryBytes: number;
  content?: string;
  symbols: string[];
  keywords: string;
  metadata: Record<string, unknown>;
  priority: number;
  updatedAt: string;
}

export interface AppcodeIngestResult {
  appcode: string;
  ingested: number;
  deduplicated: number;
  documents: AppcodeDocument[];
}

export interface AppcodeContextPackItem {
  source: string;
  docId: string;
  title: string;
  uri: string;
  stage: string;
  summary: string;
  symbols: string[];
  rawBytes: number;
  summaryBytes: number;
  tokens: number;
  priority: number;
  score: number;
  updatedAt: string;
}

export interface AppcodeContextPack {
  appcode: string;
  stage: string | null;
  sources: string[];
  query: string | null;
  budgetTokens: number;
  usedTokens: number;
  totalCandidates: number;
  omittedCount: number;
  rawBytesTotal: number;
  summaryBytesServed: number;
  rawBytesAvoided: number;
  tokensSaved: number;
  items: AppcodeContextPackItem[];
}

export interface WorkerTickOptions {
  repo?: string;
  force?: boolean;
}

export interface WorkerRepoResult {
  repoId: RepoId;
  repoName: string;
  status: "indexed" | "fresh" | "error";
  commitSha?: string;
  reason?: IndexResult["reason"];
  filesIndexed?: number;
  filesReused?: number;
  durationMs?: number;
  error?: string;
}

export interface WorkerTickResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  skippedOverlap: boolean;
  processed: number;
  indexed: number;
  fresh: number;
  errors: number;
  results: WorkerRepoResult[];
}

export interface WorkerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number | null;
  tickCount: number;
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: WorkerTickResult | null;
}
