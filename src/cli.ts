#!/usr/bin/env node
import { Command } from "commander";
import { ContextEngine } from "./engine.js";
import { assertSafeBind, createHttpServer } from "./http.js";
import { serveMcpStdio } from "./mcp.js";

const program = new Command();
program
  .name("context-engine")
  .description("Shared multi-repo context engine: commit-aware extractive summaries cached in SQLite.")
  .version("0.1.0")
  .option("-d, --data-dir <dir>", "data directory (default: $MIREVOX_CONTEXT_DIR, ~/.mirevox/context-engine, ./.mirevox-context)")
  .option("--json", "print JSON output");

function engine(): ContextEngine {
  return new ContextEngine({ dataDir: program.opts<{ dataDir?: string }>().dataDir });
}

function out(data: unknown, human: () => string): void {
  console.log(program.opts<{ json?: boolean }>().json ? JSON.stringify(data, null, 2) : human());
}

function action<A extends unknown[]>(fn: (e: ContextEngine, ...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    let e: ContextEngine | undefined;
    try {
      e = engine();
      await fn(e, ...args);
    } catch (err) {
      console.error(`error: ${(err as Error).message.split("\n")[0]}`);
      process.exitCode = 1;
    } finally {
      e?.close();
    }
  };
}

const short = (s: string | null) => (s ? s.slice(0, 10) : "-");

program
  .command("register <path>")
  .description("register a local git repo and index it at HEAD")
  .option("-n, --name <name>", "display name")
  .option("--no-index", "register without indexing")
  .action(
    action((e, path: string, o: { name?: string; index: boolean }) => {
      const r = e.registerRepo(path, { name: o.name, index: o.index });
      out(r, () => {
        const i = r.indexed;
        return `registered ${r.repo.name} (${r.repo.id}) at ${r.repo.path}` +
          (i ? `\nindexed ${short(i.commitSha)}: ${i.filesIndexed} summarized, ${i.filesReused} reused in ${i.durationMs}ms` : "");
      });
    }),
  );

program
  .command("unregister <repo>")
  .description("remove a repo and its cached data (id, name or path)")
  .action(
    action((e, repo: string) => {
      const r = e.unregisterRepo(repo);
      out(r, () => `unregistered ${r.name} (${r.id})`);
    }),
  );

program
  .command("index [repo]")
  .description("index a repo (or all repos) at HEAD; reindexes only if HEAD changed unless --force")
  .option("-f, --force", "recompute all summaries")
  .action(
    action((e, repo: string | undefined, o: { force?: boolean }) => {
      const targets = repo ? [e.registry.resolve(repo)] : e.registry.list();
      const results = targets.map((r) => {
        if (o.force) return { name: r.name, ...e.reindexRepo(r.id, true) };
        const fresh = e.ensureFresh(r.id);
        return fresh.indexed
          ? { name: r.name, ...fresh.indexed }
          : { name: r.name, repoId: r.id, commitSha: fresh.commitSha, reason: "fresh" as const };
      });
      out(results, () =>
        results.length === 0
          ? "no repos registered"
          : results
              .map((r) =>
                "filesIndexed" in r
                  ? `${r.name}: ${short(r.commitSha)} (${r.reason}) ${r.filesIndexed} summarized, ${r.filesReused} reused`
                  : `${r.name}: ${short(r.commitSha)} up to date`,
              )
              .join("\n"),
      );
    }),
  );

program
  .command("status")
  .description("show registered repos, freshness and cache stats")
  .action(
    action((e) => {
      const repos = e.listRepos();
      const stats = e.stats();
      out({ repos, stats }, () => {
        const lines = [`data: ${e.config.dataDir}`, `repos: ${repos.length}`];
        for (const r of repos) {
          lines.push(
            `  ${r.name} [${r.id}] ${r.path}\n    indexed=${short(r.lastIndexedCommit)} head=${short(r.headCommit)} files=${r.fileCount} ${r.stale ? "STALE" : "fresh"}${r.error ? ` (${r.error})` : ""}`,
          );
        }
        lines.push(
          `cache: ${stats.files} files, hits=${stats.hits} misses=${stats.misses} hitRate=${(stats.hitRate * 100).toFixed(1)}% invalidations=${stats.invalidations} reindexes=${stats.reindexes}`,
        );
        return lines.join("\n");
      });
    }),
  );

program
  .command("query <text>")
  .description("search cached context across repos")
  .option("-r, --repo <repo>", "limit to one repo")
  .option("-l, --limit <n>", "max results", "10")
  .action(
    action((e, text: string, o: { repo?: string; limit: string }) => {
      const limit = Number(o.limit);
      if (!Number.isFinite(limit)) throw new Error(`Invalid limit: ${o.limit}`);
      const hits = e.search(text, { repo: o.repo, limit });
      out(hits, () =>
        hits.length === 0
          ? "no matches"
          : hits.map((h) => `${h.score.toFixed(1)}  ${h.repoName}:${h.path}\n      ${h.snippet}`).join("\n"),
      );
    }),
  );

program
  .command("serve-mcp")
  .description("serve MCP over stdio")
  .action(async () => {
    try {
      await serveMcpStdio(engine());
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("serve-http")
  .description("serve the JSON HTTP API")
  .option("-p, --port <port>", "port (or $CONTEXT_ENGINE_PORT)", process.env.CONTEXT_ENGINE_PORT ?? "7437")
  .option("--host <host>", "bind address (or $CONTEXT_ENGINE_HOST)", process.env.CONTEXT_ENGINE_HOST ?? "127.0.0.1")
  .action(async (o: { port: string; host: string }) => {
    try {
      assertSafeBind(o.host);
      const e = engine();
      const server = createHttpServer(e);
      const port = Number(o.port);
      if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid port: ${o.port}`);
      server.listen(port, o.host, () => {
        console.error(`context-engine HTTP listening on http://${o.host}:${port} (data: ${e.config.dataDir})`);
      });
      const stop = () =>
        server.close(() => {
          e.close();
          process.exit(0);
        });
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
