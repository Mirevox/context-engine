import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ContextEngine } from "./engine.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: (err as Error).message ?? String(err) }] };
}

function run<T>(fn: () => T) {
  try {
    return json(fn());
  } catch (err) {
    return fail(err);
  }
}

export function createMcpServer(engine: ContextEngine): McpServer {
  const server = new McpServer({ name: "mirevox-context-engine", version: "0.1.0" });
  const repoArg = z.string().describe("Repo id, registered name, or absolute path");

  server.registerTool(
    "list_repos",
    {
      title: "List repos",
      description: "List registered repos with indexed commit, current HEAD and staleness.",
      inputSchema: {},
    },
    async () => run(() => engine.listRepos()),
  );

  server.registerTool(
    "register_repo",
    {
      title: "Register repo",
      description: "Register a local git repo (absolute path) and index it at HEAD so all clients share its cache.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a local git checkout"),
        name: z.string().optional().describe("Display name (default: directory name)"),
        index: z.boolean().optional().describe("Index immediately (default true)"),
      },
    },
    async ({ path, name, index }) => run(() => engine.registerRepo(path, { name, index })),
  );

  server.registerTool(
    "get_repo_summary",
    {
      title: "Repo summary",
      description:
        "Cached extractive overview of a repo (languages, layout, key files) at its current HEAD commit. Reindexes automatically if HEAD moved.",
      inputSchema: { repo: repoArg },
    },
    async ({ repo }) => run(() => engine.repoSummary(repo)),
  );

  server.registerTool(
    "search_context",
    {
      title: "Search context",
      description:
        "Keyword search over cached file summaries, symbols and paths. Searches all registered repos unless `repo` is given. Returns summaries, not file contents.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text or identifier query"),
        repo: z.string().optional().describe("Limit to one repo (id, name or path)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
      },
    },
    async ({ query, repo, limit }) => run(() => engine.search(query, { repo, limit })),
  );

  server.registerTool(
    "get_file_context",
    {
      title: "File context",
      description:
        "Cached summary and symbols for one file at the repo's HEAD commit; optionally include raw content from git.",
      inputSchema: {
        repo: repoArg,
        path: z.string().min(1).describe("Repo-relative file path"),
        include_content: z.boolean().optional().describe("Also return file content (truncated)"),
        max_chars: z.number().int().min(100).max(200000).optional().describe("Content cap (default 8000)"),
      },
    },
    async ({ repo, path, include_content, max_chars }) =>
      run(() => engine.fileContext(repo, path, { includeContent: include_content, maxChars: max_chars })),
  );

  server.registerTool(
    "cache_stats",
    {
      title: "Cache stats",
      description: "Persisted cache hit/miss counters, invalidations, reindexes, and cache size, plus this session's counters.",
      inputSchema: {},
    },
    async () => run(() => engine.stats()),
  );

  server.registerTool(
    "reindex_repo",
    {
      title: "Reindex repo",
      description: "Rebuild the cache for a repo at its current HEAD. force=true (default) discards cached summaries for HEAD.",
      inputSchema: {
        repo: repoArg,
        force: z.boolean().optional().describe("Recompute all summaries (default true)"),
      },
    },
    async ({ repo, force }) => run(() => engine.reindexRepo(repo, force ?? true)),
  );

  return server;
}

export async function serveMcpStdio(engine: ContextEngine): Promise<void> {
  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
}
