import type { Cache, CachedFile } from "./cache.js";
import type { EngineConfig } from "./config.js";
import { inTransaction, type Db } from "./db.js";
import { headSha, listTree, readBlobs, readFileAt, type TreeEntry } from "./git.js";
import type { Registry } from "./registry.js";
import { leadingDoc, looksBinary, shouldIndex, summarizeFile, summarizeRepo } from "./summarizer.js";
import type { IndexResult, RegisteredRepo } from "./types.js";

const BATCH = 300;

export interface IndexOptions {
  force?: boolean;
  reason?: IndexResult["reason"];
}

export class Indexer {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly registry: Registry,
    private readonly config: EngineConfig,
  ) {}

  /**
   * Index a repo at its current HEAD. Files already cached for this commit, or whose
   * blob is unchanged since an earlier indexed commit, are reused instead of re-summarized.
   */
  index(repo: RegisteredRepo, opts: IndexOptions = {}): IndexResult {
    const started = Date.now();
    const sha = headSha(repo.path);
    const allEntries = listTree(repo.path, sha);
    const entries = allEntries
      .filter((e) => shouldIndex(e.path) && e.size <= this.config.maxFileBytes)
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, this.config.maxFilesPerRepo);

    if (opts.force) {
      this.db.prepare("DELETE FROM files WHERE repo_id = ? AND commit_sha = ?").run(repo.id, sha);
      this.db.prepare("DELETE FROM repo_summaries WHERE repo_id = ? AND commit_sha = ?").run(repo.id, sha);
    }

    let reused = 0;
    let skipped = Math.max(0, allEntries.length - entries.length);
    let indexed = 0;
    const toCompute: TreeEntry[] = [];

    inTransaction(this.db, () => {
      for (const e of entries) {
        if (!opts.force) {
          if (this.cache.peekFile(repo.id, sha, e.path)) {
            reused++;
            continue;
          }
          const prior = this.cache.findByBlob(repo.id, e.path, e.blobSha);
          if (prior) {
            this.cache.putFile({ ...prior, commitSha: sha, indexedAt: new Date().toISOString() });
            reused++;
            continue;
          }
        }
        toCompute.push(e);
      }
    });

    for (let i = 0; i < toCompute.length; i += BATCH) {
      const chunk = toCompute.slice(i, i + BATCH);
      const blobs = readBlobs(repo.path, [...new Set(chunk.map((e) => e.blobSha))]);
      inTransaction(this.db, () => {
        for (const e of chunk) {
          const buf = blobs.get(e.blobSha);
          if (!buf || looksBinary(buf)) {
            skipped++;
            continue;
          }
          const s = summarizeFile(e.path, buf.toString("utf8"));
          const rec: CachedFile = {
            repoId: repo.id,
            commitSha: sha,
            path: e.path,
            language: s.language,
            byteSize: buf.length,
            summary: s.summary,
            symbols: s.symbols,
            keywords: s.keywords,
            blobSha: e.blobSha,
            contentHash: e.blobSha,
            indexedAt: new Date().toISOString(),
          };
          this.cache.putFile(rec);
          indexed++;
        }
      });
    }

    const files = this.cache.listFiles(repo.id, sha);
    const readme = files.find((f) => /^readme(\.\w+)?$/i.test(f.path));
    let readmeText: string | undefined;
    if (readme) {
      const buf = readFileAt(repo.path, sha, readme.path);
      if (buf) readmeText = leadingDoc("markdown", buf.toString("utf8"));
    }
    let packageDescription: string | undefined;
    if (files.some((f) => f.path === "package.json")) {
      try {
        const pkg = JSON.parse(readFileAt(repo.path, sha, "package.json")?.toString("utf8") ?? "{}") as {
          description?: string;
        };
        packageDescription = pkg.description;
      } catch {
        /* ignore malformed package.json */
      }
    }
    const overview = summarizeRepo({
      name: repo.name,
      files,
      readme: readmeText,
      packageDescription,
    });
    inTransaction(this.db, () => {
      this.cache.putRepoSummary({
        repoId: repo.id,
        commitSha: sha,
        overview: overview.overview,
        languages: overview.languages,
        topPaths: overview.topPaths,
        fileCount: files.length,
      });
      this.registry.markIndexed(repo.id, sha, files.length);
      this.cache.prune(repo.id, this.config.keepCommits);

      this.cache.bump("fileHits", reused);
      this.cache.bump("fileMisses", indexed);
      this.cache.bump("reindexes");
    });

    return {
      repoId: repo.id,
      commitSha: sha,
      filesIndexed: indexed,
      filesReused: reused,
      filesSkipped: skipped,
      durationMs: Date.now() - started,
      reason:
        opts.reason ??
        (opts.force ? "forced" : repo.lastIndexedCommit === null ? "initial" : "head-changed"),
    };
  }
}
