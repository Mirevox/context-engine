import type { ContextEngine } from "./engine.js";
import type { WorkerRepoResult, WorkerStatus, WorkerTickOptions, WorkerTickResult } from "./types.js";

/**
 * Offline background indexer that refreshes stale repos without blocking the event loop.
 * Enforces single-flight overlap protection (`isRunning`), yields with `setImmediate`
 * between repositories, and isolates per-repo failures.
 */
export class BackgroundIndexer {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number | null = null;
  private tickCount = 0;
  private lastTickAt: string | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private lastResult: WorkerTickResult | null = null;

  constructor(private readonly engine: ContextEngine) {}

  async tick(opts: WorkerTickOptions = {}): Promise<WorkerTickResult> {
    if (this.isRunning) {
      const now = new Date().toISOString();
      return {
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        skippedOverlap: true,
        processed: 0,
        indexed: 0,
        fresh: 0,
        errors: 0,
        results: [],
      };
    }

    this.isRunning = true;
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const results: WorkerRepoResult[] = [];
    let indexed = 0;
    let fresh = 0;
    let errors = 0;

    try {
      const targets = opts.repo ? [this.engine.registry.resolve(opts.repo)] : this.engine.registry.list();
      for (const repo of targets) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          if (opts.force) {
            const res = this.engine.reindexRepo(repo.id, true);
            indexed++;
            results.push({
              repoId: repo.id,
              repoName: repo.name,
              status: "indexed",
              commitSha: res.commitSha,
              reason: res.reason,
              filesIndexed: res.filesIndexed,
              filesReused: res.filesReused,
              durationMs: res.durationMs,
            });
          } else {
            const f = this.engine.ensureFresh(repo.id);
            if (f.indexed) {
              indexed++;
              results.push({
                repoId: repo.id,
                repoName: repo.name,
                status: "indexed",
                commitSha: f.indexed.commitSha,
                reason: f.indexed.reason,
                filesIndexed: f.indexed.filesIndexed,
                filesReused: f.indexed.filesReused,
                durationMs: f.indexed.durationMs,
              });
            } else {
              fresh++;
              results.push({
                repoId: repo.id,
                repoName: repo.name,
                status: "fresh",
                commitSha: f.commitSha,
                reason: "fresh",
              });
            }
          }
        } catch (err) {
          errors++;
          const msg = ((err as Error).message ?? String(err)).split("\n")[0] ?? "Unknown error";
          results.push({
            repoId: repo.id,
            repoName: repo.name,
            status: "error",
            error: msg,
          });
        }
      }

      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      const out: WorkerTickResult = {
        startedAt,
        finishedAt,
        durationMs: finishedMs - startedMs,
        skippedOverlap: false,
        processed: results.length,
        indexed,
        fresh,
        errors,
        results,
      };
      this.tickCount++;
      this.lastTickAt = finishedAt;
      this.lastDurationMs = out.durationMs;
      this.lastError = errors > 0 ? `${errors} repo(s) failed` : null;
      this.lastResult = out;
      return out;
    } catch (err) {
      this.lastError = ((err as Error).message ?? String(err)).split("\n")[0] ?? "Unknown error";
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  start(intervalMs: number, opts: WorkerTickOptions = {}): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`Invalid worker interval: ${String(intervalMs)}`);
    }
    this.stop();
    this.intervalMs = Math.trunc(intervalMs);
    this.timer = setInterval(() => {
      void this.tick(opts).catch((err) => {
        this.lastError = ((err as Error).message ?? String(err)).split("\n")[0] ?? "Worker tick error";
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.intervalMs = null;
  }

  status(): WorkerStatus {
    return {
      enabled: this.timer !== null,
      running: this.isRunning,
      intervalMs: this.intervalMs,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      lastResult: this.lastResult,
    };
  }
}
