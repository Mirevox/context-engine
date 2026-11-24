import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ContextEngine } from "./engine.js";
import { BackgroundIndexer } from "./worker.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: (err as Error).message ?? String(err) }] };
}

async function run<T>(fn: () => T | Promise<T>) {
  try {
    return json(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function createMcpServer(engine: ContextEngine, worker = new BackgroundIndexer(engine)): McpServer {
  const server = new McpServer({ name: "mirevox-context-engine", version: "0.2.0" });
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
      description:
        "Persisted cache hit/miss counters, invalidations, reindexes, token savings, and cache size, plus this session's counters.",
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

  server.registerTool(
    "ingest_appcode_documents",
    {
      title: "Ingest appcode documents",
      description:
        "Summarize, SHA-256 deduplicate, and store cross-source documents (Confluence, SharePoint, Jira, Git, tests) under an appcode.",
      inputSchema: {
        appcode: z.string().min(1).describe("Application code identifier"),
        docs: z
          .array(
            z.object({
              source: z.string().min(1).describe("Source kind (e.g. confluence, sharepoint, jira, git, testing)"),
              docId: z.string().min(1).describe("Document identifier within source"),
              title: z.string().min(1).describe("Document title"),
              content: z.string().describe("Raw document content"),
              uri: z.string().optional().describe("Optional document URI or path"),
              stage: z.string().optional().describe("Optional lifecycle stage"),
              metadata: z.record(z.string(), z.unknown()).optional().describe("Optional structured metadata"),
              priority: z.number().int().optional().describe("Optional priority weight"),
              updatedAt: z.string().optional().describe("Optional ISO timestamp"),
            }),
          )
          .describe("Documents to ingest"),
      },
    },
    async ({ appcode, docs }) => run(() => engine.ingestAppcodeDocuments(appcode, docs)),
  );

  server.registerTool(
    "get_appcode_context_pack",
    {
      title: "Get appcode context pack",
      description:
        "Pack the highest-scoring summarized documents for an appcode strictly inside budget_tokens and record token savings.",
      inputSchema: {
        appcode: z.string().min(1).describe("Application code identifier"),
        budget_tokens: z.number().int().min(1).max(200000).optional().describe("Token budget (default 1500)"),
        stage: z.string().optional().describe("Filter by lifecycle stage"),
        sources: z.array(z.string()).optional().describe("Filter by source kinds"),
        query: z.string().optional().describe("Optional focus query for ranking/filtering"),
      },
    },
    async ({ appcode, budget_tokens, stage, sources, query }) =>
      run(() =>
        engine.getAppcodeContextPack(appcode, {
          budgetTokens: budget_tokens,
          stage,
          sources,
          query,
        }),
      ),
  );

  server.registerTool(
    "list_appcode_documents",
    {
      title: "List appcode documents",
      description: "List cached document summaries for an appcode with optional stage, source, and limit filters.",
      inputSchema: {
        appcode: z.string().min(1).describe("Application code identifier"),
        stage: z.string().optional().describe("Filter by lifecycle stage"),
        source: z.string().optional().describe("Filter by source kind"),
        limit: z.number().int().min(1).max(500).optional().describe("Max documents (default 100)"),
      },
    },
    async ({ appcode, stage, source, limit }) =>
      run(() => engine.listAppcodeDocuments(appcode, { stage, source, limit })),
  );

  server.registerTool(
    "run_background_index",
    {
      title: "Run background index",
      description: "Trigger one background indexer tick across registered repos (or one target repo).",
      inputSchema: {
        repo: z.string().optional().describe("Optional repo id, name, path, or remote URL"),
        force: z.boolean().optional().describe("Force full recompute (default false)"),
      },
    },
    async ({ repo, force }) => run(() => worker.tick({ repo, force })),
  );

  return server;
}

export async function serveMcpStdio(engine: ContextEngine, worker?: BackgroundIndexer): Promise<void> {
  const server = createMcpServer(engine, worker);
  await server.connect(new StdioServerTransport());
}
