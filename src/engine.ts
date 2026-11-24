import { createHash } from "node:crypto";
import { Cache, SUMMARIZER_VERSION } from "./cache.js";
import { loadConfig, type ConfigOverrides, type EngineConfig } from "./config.js";
import { inTransaction, openDb, type Db } from "./db.js";
import { headSha, readFileAt } from "./git.js";
import { Indexer } from "./indexer.js";
import { Registry } from "./registry.js";
import { isSecretPath, looksBinary, summarizeDocument, summarizeFile, tokenize } from "./summarizer.js";
import type {
  AppcodeContextPack,
  AppcodeContextPackItem,
  AppcodeDocInput,
  AppcodeDocument,
  AppcodeIngestResult,
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

interface AppcodeDocRow {
  appcode: string;
  source: string;
  doc_id: string;
  title: string;
  uri: string;
  stage: string;
  content_hash: string;
  raw_bytes: number;
  summary: string;
  summary_bytes: number;
  content?: string;
  symbols: string;
  keywords: string;
  metadata: string;
  priority: number;
  updated_at: string;
}

function toAppcodeDoc(r: AppcodeDocRow, includeContent = false): AppcodeDocument {
  const doc: AppcodeDocument = {
    appcode: r.appcode,
    source: r.source,
    docId: r.doc_id,
    title: r.title,
    uri: r.uri,
    stage: r.stage,
    contentHash: r.content_hash,
    rawBytes: r.raw_bytes,
    summary: r.summary,
    summaryBytes: r.summary_bytes,
    symbols: JSON.parse(r.symbols) as string[],
    keywords: r.keywords,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    priority: r.priority,
    updatedAt: r.updated_at,
  };
  if (includeContent) {
    doc.content = r.content ?? r.summary;
  }
  return doc;
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
    if (!force) {
      const fresh = this.ensureFresh(ref);
      return (
        fresh.indexed ?? {
          repoId: fresh.repo.id,
          commitSha: fresh.commitSha,
          filesIndexed: 0,
          filesReused: 0,
          filesSkipped: 0,
          durationMs: 0,
          reason: "fresh",
        }
      );
    }
    const repo = this.registry.resolve(ref);
    const sha = headSha(repo.path);
    if (repo.lastIndexedCommit && repo.lastIndexedCommit !== sha) this.cache.bump("invalidations");
    return this.indexer.index(repo, { force: true });
  }

  repoSummary(ref: string): RepoSummary {
    const fresh = this.ensureFresh(ref);
    const s = this.cache.getRepoSummary(fresh.repo.id, fresh.commitSha)!;
    const rawBytes = this.cache.sumFileBytes(fresh.repo.id, fresh.commitSha);
    const summaryBytes = Buffer.byteLength(s.overview, "utf8");
    this.cache.recordSavings(rawBytes, summaryBytes);
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
      let fresh: FreshResult;
      try {
        fresh = this.ensureFresh(r.id);
      } catch {
        // One broken checkout must not abort cross-repo search (listRepos isolates similarly).
        continue;
      }
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
    if (opts.maxChars !== undefined && !Number.isFinite(opts.maxChars)) {
      throw new Error(`Invalid max_chars: ${String(opts.maxChars)}`);
    }
    let rec = this.cache.getFile(fresh.repo.id, fresh.commitSha, normalized);
    let cacheHit = !!rec;
    let content: Buffer | null = null;
    if (!rec) {
      // Path was not indexed (too large, skipped type, ...) but may exist in the commit.
      content = readFileAt(fresh.repo.path, fresh.commitSha, normalized);
      if (!content) throw new Error(`File not found at ${fresh.commitSha.slice(0, 12)}: ${normalized}`);
      if (looksBinary(content)) throw new Error(`File not indexed (binary): ${normalized}`);
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
      if (content && looksBinary(content)) throw new Error(`File not indexed (binary): ${normalized}`);
      const max = opts.maxChars ?? 8000;
      const text = content?.toString("utf8") ?? "";
      out.content = text.slice(0, max);
      out.truncated = text.length > max;
    } else {
      const summaryBytes = Buffer.byteLength(rec.summary, "utf8");
      this.cache.recordSavings(rec.byteSize, summaryBytes);
    }
    return out;
  }

  /**
   * Summarize, deduplicate by SHA-256 content hash, and persist non-Git/cross-source
   * artifacts keyed by (appcode, source, doc_id). Rejects secret-shaped docIds or URIs.
   */
  ingestAppcodeDocuments(appcode: string, docs: AppcodeDocInput[]): AppcodeIngestResult {
    const cleanAppcode = appcode.trim();
    if (!cleanAppcode) throw new Error("Missing required parameter: appcode");
    if (!Array.isArray(docs)) throw new Error("Invalid docs: expected an array");

    for (const d of docs) {
      if (!d || typeof d !== "object") throw new Error("Invalid document entry");
      if (!d.source || typeof d.source !== "string") throw new Error("Missing required parameter: source");
      if (!d.docId || typeof d.docId !== "string") throw new Error("Missing required parameter: docId");
      if (!d.title || typeof d.title !== "string") throw new Error("Missing required parameter: title");
      if (typeof d.content !== "string") throw new Error("Missing required parameter: content");
      const normalizedDocId = d.docId.replace(/^\.?\//, "");
      if (isSecretPath(normalizedDocId)) {
        throw new Error(`Refusing to ingest secret-shaped path: ${d.docId}`);
      }
      if (d.uri) {
        const normalizedUri = d.uri.replace(/^\.?\//, "");
        if (isSecretPath(normalizedUri)) {
          throw new Error(`Refusing to ingest secret-shaped path: ${d.uri}`);
        }
      }
    }

    let ingested = 0;
    let deduplicated = 0;
    const documents: AppcodeDocument[] = [];

    inTransaction(this.db, () => {
      const findExactStmt = this.db.prepare(
        "SELECT * FROM appcode_documents WHERE appcode = ? AND source = ? AND doc_id = ?",
      );
      const findHashStmt = this.db.prepare(
        "SELECT * FROM appcode_documents WHERE appcode = ? AND content_hash = ? AND summarizer_version = ? LIMIT 1",
      );
      const upsertStmt = this.db.prepare(
        `INSERT INTO appcode_documents
         (appcode, source, doc_id, title, uri, stage, content_hash, raw_bytes, summary, summary_bytes, content, symbols, keywords, metadata, priority, updated_at, summarizer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(appcode, source, doc_id) DO UPDATE SET
           title = excluded.title,
           uri = excluded.uri,
           stage = excluded.stage,
           content_hash = excluded.content_hash,
           raw_bytes = excluded.raw_bytes,
           summary = excluded.summary,
           summary_bytes = excluded.summary_bytes,
           content = excluded.content,
           symbols = excluded.symbols,
           keywords = excluded.keywords,
           metadata = excluded.metadata,
           priority = excluded.priority,
           updated_at = excluded.updated_at,
           summarizer_version = excluded.summarizer_version`,
      );

      for (const d of docs) {
        const source = d.source.trim();
        const docId = d.docId.trim();
        const title = d.title.trim();
        const uri = (d.uri ?? "").trim();
        const stage = (d.stage ?? "").trim();
        const priority = typeof d.priority === "number" && Number.isFinite(d.priority) ? Math.trunc(d.priority) : 0;
        const updatedAt = d.updatedAt?.trim() || new Date().toISOString();
        const metaJson = JSON.stringify(d.metadata ?? {});
        const contentHash = createHash("sha256").update(d.content).digest("hex");
        const rawBytes = Buffer.byteLength(d.content, "utf8");

        const existingExact = findExactStmt.get(cleanAppcode, source, docId) as AppcodeDocRow | undefined;
        if (existingExact && existingExact.content_hash === contentHash) {
          if (
            existingExact.title !== title ||
            existingExact.uri !== uri ||
            existingExact.stage !== stage ||
            existingExact.metadata !== metaJson ||
            existingExact.priority !== priority
          ) {
            upsertStmt.run(
              cleanAppcode,
              source,
              docId,
              title,
              uri,
              stage,
              contentHash,
              rawBytes,
              existingExact.summary,
              existingExact.summary_bytes,
              existingExact.content ?? d.content.slice(0, 65_536),
              existingExact.symbols,
              existingExact.keywords,
              metaJson,
              priority,
              updatedAt,
              SUMMARIZER_VERSION,
            );
            documents.push(toAppcodeDoc(findExactStmt.get(cleanAppcode, source, docId) as unknown as AppcodeDocRow));
          } else {
            documents.push(toAppcodeDoc(existingExact));
          }
          deduplicated++;
          continue;
        }

        const existingByHash = findHashStmt.get(cleanAppcode, contentHash, SUMMARIZER_VERSION) as
          | AppcodeDocRow
          | undefined;
        if (existingByHash && !existingExact) {
          deduplicated++;
          documents.push(toAppcodeDoc(existingByHash));
          continue;
        }

        const sum = existingByHash
          ? {
              summary: existingByHash.summary,
              symbols: JSON.parse(existingByHash.symbols) as string[],
              keywords: existingByHash.keywords,
            }
          : summarizeDocument(title, d.content, source);
        const summaryBytes = Buffer.byteLength(sum.summary, "utf8");

        upsertStmt.run(
          cleanAppcode,
          source,
          docId,
          title,
          uri,
          stage,
          contentHash,
          rawBytes,
          sum.summary,
          summaryBytes,
          d.content.slice(0, 65_536),
          JSON.stringify(sum.symbols),
          sum.keywords,
          metaJson,
          priority,
          updatedAt,
          SUMMARIZER_VERSION,
        );
        ingested++;
        documents.push(toAppcodeDoc(findExactStmt.get(cleanAppcode, source, docId) as unknown as AppcodeDocRow));
      }
    });

    return {
      appcode: cleanAppcode,
      ingested,
      deduplicated,
      documents,
    };
  }

  listAppcodeDocuments(
    appcode: string,
    opts: { stage?: string; source?: string; limit?: number; includeContent?: boolean } = {},
  ): AppcodeDocument[] {
    const cleanAppcode = appcode.trim();
    if (!cleanAppcode) throw new Error("Missing required parameter: appcode");
    if (opts.limit !== undefined && !Number.isFinite(opts.limit)) {
      throw new Error(`Invalid limit: ${String(opts.limit)}`);
    }
    const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 100), 500));

    const clauses = ["appcode = ?", "summarizer_version = ?"];
    const params: (string | number)[] = [cleanAppcode, SUMMARIZER_VERSION];
    if (opts.stage) {
      clauses.push("stage = ?");
      params.push(opts.stage);
    }
    if (opts.source) {
      clauses.push("source = ?");
      params.push(opts.source);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM appcode_documents WHERE ${clauses.join(" AND ")}
         ORDER BY priority DESC, updated_at DESC, source ASC, doc_id ASC LIMIT ?`,
      )
      .all(...params) as unknown as AppcodeDocRow[];
    return rows.map((r) => toAppcodeDoc(r, opts.includeContent === true));
  }

  getAppcodeContextPack(
    appcode: string,
    opts: { budgetTokens?: number; stage?: string; sources?: string[]; query?: string } = {},
  ): AppcodeContextPack {
    const cleanAppcode = appcode.trim();
    if (!cleanAppcode) throw new Error("Missing required parameter: appcode");
    if (opts.budgetTokens !== undefined && (!Number.isFinite(opts.budgetTokens) || opts.budgetTokens <= 0)) {
      throw new Error(`Invalid budget_tokens: ${String(opts.budgetTokens)}`);
    }
    const budgetTokens = Math.max(1, Math.trunc(opts.budgetTokens ?? 1500));

    const clauses = ["appcode = ?", "summarizer_version = ?"];
    const params: (string | number)[] = [cleanAppcode, SUMMARIZER_VERSION];
    if (opts.stage) {
      clauses.push("stage = ?");
      params.push(opts.stage);
    }
    const sources = (opts.sources ?? []).map((s) => s.trim()).filter(Boolean);
    if (sources.length > 0) {
      clauses.push(`source IN (${sources.map(() => "?").join(", ")})`);
      params.push(...sources);
    }

    const rows = this.db
      .prepare(`SELECT * FROM appcode_documents WHERE ${clauses.join(" AND ")}`)
      .all(...params) as unknown as AppcodeDocRow[];
    const docs = rows.map((r) => toAppcodeDoc(r));

    const query = opts.query?.trim() || null;
    const terms = query ? tokenize(query) : [];
    const phrase = query ? query.toLowerCase() : "";

    const scored: { doc: AppcodeDocument; score: number }[] = [];
    for (const doc of docs) {
      let score = doc.priority;
      if (terms.length > 0) {
        const titleL = doc.title.toLowerCase();
        const docIdL = doc.docId.toLowerCase();
        const uriL = doc.uri.toLowerCase();
        const symL = doc.symbols.join(" ").toLowerCase();
        const sumL = doc.summary.toLowerCase();
        const kw = new Set(doc.keywords.split(" "));
        let qScore = 0;
        for (const t of terms) {
          if (titleL.includes(t) || symL.includes(t)) qScore += 4;
          if (docIdL.includes(t) || uriL.includes(t)) qScore += 3;
          if (sumL.includes(t)) qScore += 1.5;
          if (kw.has(t)) qScore += 1;
        }
        if (phrase.length > 3 && (titleL.includes(phrase) || sumL.includes(phrase))) qScore += 3;
        if (qScore <= 0) continue;
        score = Number((qScore * 10 + doc.priority).toFixed(2));
      }
      scored.push({ doc, score });
    }

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.doc.priority - a.doc.priority ||
        b.doc.updatedAt.localeCompare(a.doc.updatedAt) ||
        a.doc.source.localeCompare(b.doc.source) ||
        a.doc.docId.localeCompare(b.doc.docId),
    );

    const items: AppcodeContextPackItem[] = [];
    let usedTokens = 0;
    let omittedCount = 0;
    let rawBytesTotal = 0;
    let summaryBytesServed = 0;

    for (const { doc, score } of scored) {
      const tokens = Math.max(1, Math.ceil(doc.summaryBytes / 4));
      if (usedTokens + tokens > budgetTokens) {
        omittedCount++;
        continue;
      }
      usedTokens += tokens;
      rawBytesTotal += doc.rawBytes;
      summaryBytesServed += doc.summaryBytes;
      items.push({
        source: doc.source,
        docId: doc.docId,
        title: doc.title,
        uri: doc.uri,
        stage: doc.stage,
        summary: doc.summary,
        symbols: doc.symbols.slice(0, 10),
        rawBytes: doc.rawBytes,
        summaryBytes: doc.summaryBytes,
        tokens,
        priority: doc.priority,
        score,
        updatedAt: doc.updatedAt,
      });
    }

    const savings = this.cache.recordSavings(rawBytesTotal, summaryBytesServed, { contextPacksServed: 1 });

    return {
      appcode: cleanAppcode,
      stage: opts.stage ?? null,
      sources,
      query,
      budgetTokens,
      usedTokens,
      totalCandidates: scored.length,
      omittedCount,
      rawBytesTotal,
      summaryBytesServed: savings.summaryBytesServed,
      rawBytesAvoided: savings.rawBytesAvoided,
      tokensSaved: savings.tokensSaved,
      items,
    };
  }

  stats(): CacheStats {
    return this.cache.stats();
  }
}
