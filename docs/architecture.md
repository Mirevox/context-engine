# Mirevox `context-engine` — Architecture

- **Package**: `@mirevox/context-engine` v0.1.0
- **Runtime**: TypeScript (ESM), Node.js `>= 22.5.0`, built-in `node:sqlite`
- **Entry Points**: `dist/cli.js` (CLI / MCP stdio / HTTP server), `dist/index.js` (programmatic library)

---

## 1. System Overview

`context-engine` separates **transport adapters** (CLI, MCP stdio, HTTP JSON) from a single synchronous **domain facade** (`ContextEngine`), backed by local read-only Git inspection and a shared SQLite cache in WAL mode.

```text
  Cursor / VS Code / Agents       Scripts / Humans          Local Services / Router
             |                            |                            |
        MCP (stdio)                      CLI                      HTTP JSON
        (src/mcp.ts)                 (src/cli.ts)                (src/http.ts)
             \                            |                            /
              +---------------------------+---------------------------+
                                          |
                                          v
                            +---------------------------+
                            |  ContextEngine (facade)   |
                            |      (src/engine.ts)      |
                            +-------------+-------------+
                                          |
           +------------------+-----------+-----------+------------------+
           |                  |                       |                  |
           v                  v                       v                  v
    +-------------+    +-------------+         +-------------+    +-------------+
    |  Registry   |    |   Indexer   |-------->| Summarizer  |    |    Cache    |
    | registry.ts |    | indexer.ts  |         |summarizer.ts|    |  cache.ts   |
    +------+------+    +------+------+         +-------------+    +------+------+
           |                  |                                          |
           |                  v                                          |
           |           +-------------+                                   |
           |           |     Git     | (read-only execFileSync)          |
           |           |   git.ts    |---> Local Git Repositories        |
           |           +-------------+                                   |
           |                                                             |
           +--------------------------> +--------------------------------+
                                        |
                                        v
                                 +-------------+
                                 |   SQLite    |  (src/db.ts + src/config.ts)
                                 |cache.sqlite |  WAL + busy_timeout=5000
                                 +-------------+
```

---

## 2. Module Responsibilities

| Module | File | Responsibility |
|---|---|---|
| **Types** | `src/types.ts` | Shared domain interfaces: `RegisteredRepo`, `FileRecord`, `CacheCounters`, `CacheStats`, `SearchHit`, `RepoSummary`, `FileContext`, `IndexResult`. |
| **Config** | `src/config.ts` | Resolves writable `dataDir` (`--data-dir` → `$MIREVOX_CONTEXT_DIR` → `~/.mirevox/context-engine` → `./.mirevox-context`), sets `dbPath = <dataDir>/cache.sqlite`, and applies limits (`maxFileBytes = 200_000`, `maxFilesPerRepo = 5000`, `keepCommits = 3`). |
| **DB** | `src/db.ts` | Opens `DatabaseSync` (`node:sqlite`), applies concurrency pragmas (`WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`), runs idempotent DDL schema creation, and exports `inTransaction()` using `BEGIN IMMEDIATE`. |
| **Git** | `src/git.ts` | Read-only local Git wrapper via `execFileSync("git", ["-C", cwd, ...])`: `repoRoot`, `headSha`, `listTree` (`ls-tree -r -l -z`), batched `readBlobs` (`cat-file --batch`), and single-file `readFileAt` (`git show <sha>:<path>`). |
| **Registry** | `src/registry.ts` | Manages registered local repos in `repos` table. Generates deterministic 12-char SHA-1 IDs from `realpath(repoRoot)`, enforces unique display names, resolves references by `id`, `name`, or filesystem `path`, and updates `last_indexed_commit` / `file_count`. |
| **Summarizer** | `src/summarizer.ts` | Pure, deterministic extractive analyzer (no LLM, no I/O). Provides `languageOf`, `shouldIndex`, `looksBinary`, `extractSymbols`, `leadingDoc`, `splitIdentifier`, `tokenize`, `summarizeFile` (420-char cap), and `summarizeRepo` (language histogram, directory layout, ranked `topPaths`, compact `overview`). |
| **Cache** | `src/cache.ts` | CRUD and retention layer over `files`, `repo_summaries`, and `counters` tables. Tags all reads/writes with `SUMMARIZER_VERSION = 1`. Supports exact `(repo_id, commit_sha, path)` lookup, cross-commit `(repo_id, path, blob_sha)` lookup (`findByBlob`), commit pruning (`prune`), and dual persisted + per-process session counters. |
| **Indexer** | `src/indexer.ts` | Orchestrates indexing a repo at `HEAD`: enumerates tree, filters/caps entries, reuses unchanged files via `peekFile` / `findByBlob`, reads remaining blobs in batches of `300`, skips NUL-containing binaries, writes file summaries + repo overview, prunes old commits, and updates counters. |
| **Engine** | `src/engine.ts` | Transport-agnostic `ContextEngine` facade implementing `registerRepo`, `unregisterRepo`, `listRepos`, `ensureFresh`, `reindexRepo`, `repoSummary`, weighted keyword `search`, `fileContext` (with on-demand Git fallback + optional truncated content), and `stats`. |
| **MCP** | `src/mcp.ts` | Wraps `ContextEngine` in `@modelcontextprotocol/sdk` `McpServer` over `StdioServerTransport` with Zod schemas and JSON text responses (`isError: true` on thrown errors). *(See Section 6 for tool inventory and `register_repo` delta.)* |
| **HTTP** | `src/http.ts` | Zero-framework `node:http` JSON server with 1 MB body cap, optional `CONTEXT_ENGINE_TOKEN` Bearer auth (exempting `GET /health`), 9 REST-style endpoints, and deterministic HTTP error status mapping (`400`, `401`, `404`, `413`, `500`). |
| **CLI** | `src/cli.ts` | Commander-based `context-engine` binary exposing `register`, `unregister`, `index`, `status`, `query`, `serve-mcp`, and `serve-http` with `--data-dir` and `--json`, plus graceful `SIGINT`/`SIGTERM` shutdown. |
| **Library Index** | `src/index.ts` | Re-exports public classes, helper functions, server factories, and types for programmatic embedding. |

---

## 3. SQLite Schema (`cache.sqlite`)

Defined in `src/db.ts` and initialized automatically on `openDb(dbPath)`:

```sql
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  last_indexed_commit TEXT,
  last_indexed_at TEXT,
  file_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  summary TEXT NOT NULL,
  symbols TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '',
  blob_sha TEXT NOT NULL,
  summarizer_version INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, path)
);

CREATE INDEX IF NOT EXISTS idx_files_blob ON files (repo_id, path, blob_sha);

CREATE TABLE IF NOT EXISTS repo_summaries (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  overview TEXT NOT NULL,
  languages TEXT NOT NULL,
  top_paths TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  summarizer_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
```

### Schema Design Choices
- **Composite commit-aware primary keys:** `(repo_id, commit_sha, path)` on `files` and `(repo_id, commit_sha)` on `repo_summaries` guarantee that two commits never overwrite each other silently and allow instant verification against live `HEAD`.
- **Blob reuse index (`idx_files_blob`):** Enables O(log N) lookup of previously summarized identical blobs `(repo_id, path, blob_sha)` when a new commit changes only a subset of files.
- **Versioned derivation (`summarizer_version`):** Queries filter by `summarizer_version = 1`; bumping `SUMMARIZER_VERSION` forces clean recomputation without requiring manual database deletion.
- **Atomic shared telemetry (`counters`):** Uses `INSERT ... ON CONFLICT(key) DO UPDATE SET value = value + excluded.value` so multiple processes safely aggregate `fileHits`, `fileMisses`, `repoHits`, `repoMisses`, `invalidations`, and `reindexes`.

---

## 4. Commit-SHA Invalidation & Incremental Reuse Flow

Every read path (`repoSummary`, `search`, `fileContext`) enters through `ContextEngine.ensureFresh(ref)`:

1. **Resolve HEAD:** Runs `git rev-parse --verify HEAD` against the registered `repo.path`.
2. **Fast-path cache hit:** Checks `repo.lastIndexedCommit === sha` AND `cache.getRepoSummary(repo.id, sha)` exists at `SUMMARIZER_VERSION`.
   - **Hit:** Increments `repoHits` and returns immediately — zero tree enumeration, zero blob reads.
3. **Commit miss / invalidation:**
   - Increments `repoMisses`.
   - If `repo.lastIndexedCommit` was non-null and differed from `sha`, increments `invalidations`.
   - Calls `Indexer.index(repo)`.
4. **Incremental blob reuse inside `Indexer.index()`:**
   - Runs `git ls-tree -r -l -z <sha>` to obtain `{ path, blobSha, size }` for all tracked blobs.
   - Filters via `shouldIndex(path)` and `size <= maxFileBytes`, sorts lexicographically, and slices to `maxFilesPerRepo`.
   - Pass 1 (single `BEGIN IMMEDIATE` transaction): for each entry (unless `force === true`), checks:
     1. `cache.peekFile(repo.id, sha, path)` → already present at `sha` (`reused++`).
     2. `cache.findByBlob(repo.id, path, blobSha)` → identical blob summarized at a prior commit; copies summary record under the new `commitSha` (`reused++`).
     3. Otherwise queues in `toCompute`.
   - Pass 2 (chunks of `300`): fetches only `toCompute` blobs via a single `git cat-file --batch` call per chunk, filters out binary buffers (`looksBinary`), runs `summarizeFile()`, and writes rows inside a transaction (`indexed++`).
   - Pass 3: synthesizes `repo_summaries` via `summarizeRepo()` (incorporating `package.json` description or README leading paragraph), updates `repos.last_indexed_commit`, prunes commits beyond `keepCommits` (default `3`), and bumps `fileHits` (+reused), `fileMisses` (+indexed), and `reindexes` (+1).

---

## 5. Multi-Client Concurrency & Shared Data Directory

Multiple clients (e.g., two IDE MCP stdio processes + a CLI session + an HTTP server) share one `<dataDir>/cache.sqlite`:
- **WAL mode (`journal_mode = WAL`)** allows concurrent readers while a writer commits.
- **`busy_timeout = 5000`** lets competing writers wait up to 5 seconds instead of failing immediately with `SQLITE_BUSY`.
- **`BEGIN IMMEDIATE`** acquires the write lock up front on batch inserts and pruning, preventing read-to-write upgrade deadlocks.
- Each process keeps an in-memory `cache.session` counter snapshot alongside the SQLite-persisted totals so operators can inspect both lifetime shared reuse and per-session behavior.

---

## 6. Interface Surface & Shipped Implementation Notes

### MCP Tools (`src/mcp.ts`)
- **Implemented in `src/mcp.ts` (6 tools):** `list_repos`, `get_repo_summary`, `search_context`, `get_file_context`, `cache_stats`, `reindex_repo`.
- **Specified v1 tool pending registration in `src/mcp.ts`:** `register_repo` (already implemented on `ContextEngine.registerRepo`, CLI `register`, and HTTP `POST /repos`; flagged in `docs/acceptance.md` for validation/fix).

### HTTP Endpoints (`src/http.ts`)
- `GET /health`
- `GET /repos`, `POST /repos`, `DELETE /repos/:ref`
- `GET /repos/:ref/summary`, `POST /repos/:ref/reindex`
- `GET /search?q=&repo=&limit=`
- `GET /file?repo=&path=&content=1&max_chars=`
- `GET /stats`

### CLI Subcommands (`src/cli.ts`)
- `register <path> [-n|--name] [--no-index]`
- `unregister <repo>`
- `index [repo] [-f|--force]`
- `status`
- `query <text> [-r|--repo] [-l|--limit]`
- `serve-mcp`
- `serve-http [-p|--port 7437] [--host 127.0.0.1]`

---

## 7. Security Boundaries & Mirevox Composition

- **Trust boundary (v1):** Single local OS user / trusted local host. Cached summaries are derived from source trees and carry the same sensitivity as the underlying repositories.
- **No default egress:** Indexing, summarization, and serving perform zero outbound network calls.
- **Transport safety:** MCP uses stdio (OS user permissions); HTTP defaults to `127.0.0.1` and supports a shared `CONTEXT_ENGINE_TOKEN` Bearer token (not per-user RBAC).
- **Mirevox composition:** Designed to run standalone or be attached as an MCP/HTTP tool provider behind Mirevox `smart-router`, or queried by `stage-gate` and `shadow-versioning` for compact repository metadata without sharing a database.
