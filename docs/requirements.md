# Mirevox `context-engine` — Locked v1 Requirements (FR / NFR)

- **Product**: `@mirevox/context-engine` v0.1.0 (`https://github.com/Mirevox/context-engine`)
- **License**: Apache-2.0
- **Runtime**: TypeScript on Node.js `>= 22.5.0` (built-in `node:sqlite`)
- **Scope**: Multi-repo local Git registration, commit-SHA-aware SQLite extractive summary cache, shared data directory, and MCP / HTTP / CLI interfaces.

---

## 1. Functional Requirements (FR)

### `FR-01` — Multi-Repo Local Git Registration & Resolution
The system MUST allow registering, listing, resolving, and unregistering multiple existing local Git repositories.
- **Rules**:
  - Registration validates that the target path exists, is a directory, resolves inside a Git repository (`git rev-parse --show-toplevel`), and has at least one commit (`git rev-parse --verify HEAD`).
  - Canonical `id` is deterministic: first 12 hex characters of `SHA-1(realpath(repoRoot))`.
  - Display `name` defaults to the directory basename, auto-suffixed (`-2`, `-3`, ...) if colliding; explicit duplicate names MUST be rejected with a clear error.
  - Re-registering an already-registered repo path updates its display name without duplicating the row.
  - Repositories MUST be resolvable by `id`, `name`, or filesystem `path` (normalized via `resolve` / `realpath`).
  - Unregistering removes the repo record and deletes all cached `files` and `repo_summaries` rows for that `repo_id`.
- **Acceptance Criteria**:
  1. Registering two distinct local Git repos succeeds and assigns distinct 12-char IDs and unique names; `listRepos()` returns both sorted by `name` with live `headCommit` and boolean `stale`.
  2. Registering a non-directory or non-Git directory fails cleanly with an actionable error.
  3. Resolving a registered repo by its `id`, `name`, or absolute/relative `path` returns the exact same `RegisteredRepo`.
  4. Unregistering a repo removes it from `repos` and leaves zero rows for its `repo_id` in `files` and `repo_summaries`.

### `FR-02` — Shared Data Directory & Multi-Client Cache Reuse
The system MUST support a configurable data directory so separate CLI invocations, MCP server processes, and HTTP servers reuse the same SQLite database (`cache.sqlite`).
- **Rules**:
  - Data directory precedence: explicit `--data-dir` / config override → `MIREVOX_CONTEXT_DIR` environment variable → `~/.mirevox/context-engine` → `./.mirevox-context` fallback if home is not writable.
  - Directory is created recursively if missing and verified writable before opening SQLite.
  - SQLite runs in WAL mode (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`) with `BEGIN IMMEDIATE` write transactions.
- **Acceptance Criteria**:
  1. Process A registers and indexes a repo using `--data-dir <shared>`; Process B opened against the same `--data-dir <shared>` immediately sees the registered repo and serves `get_repo_summary` with `cacheHit: true` and `reindexes` unchanged.
  2. Setting `MIREVOX_CONTEXT_DIR` directs the engine to store and read `<MIREVOX_CONTEXT_DIR>/cache.sqlite` without passing `--data-dir`.

### `FR-03` — Deterministic Extractive Summarization (No LLM Required)
The system MUST generate deterministic file and repository summaries purely from tracked file contents using local extractive rules (zero LLM calls, zero embeddings, zero network requests).
- **Rules**:
  - File summary (`summarizeFile`): detects language (30+ extensions plus `Dockerfile` and `Makefile`), counts lines, extracts leading comments/docstrings/Markdown paragraph (first 60 lines), extracts up to 40 top-level symbols/headings (TS/JS, Python, Go, Rust, Java/Kotlin/C#, Ruby, Shell, Markdown H1–H3; top-level keys/name/description for JSON), extracts up to 30 stopword-filtered split-identifier keywords, and formats a summary capped at `420` characters.
  - Repo summary (`summarizeRepo`): aggregates file counts per language, top-8 top-level directory counts, top-10 ranked `topPaths` (prioritizing README, entrypoints, root files, penalizing tests/fixtures), and composes a compact `overview` using `package.json` description or README intro.
  - Cached rows store `summarizer_version` (v1 = `1`) so future algorithm changes do not return stale-format summaries.
- **Acceptance Criteria**:
  1. Indexing the same repository commit twice with `--force` yields identical `summary`, `symbols`, `keywords`, `languages`, `topPaths`, and `overview`.
  2. Every cached file `summary.length <= 420`.
  3. Summarizing a TypeScript, Python, JSON, and Markdown fixture extracts expected exported symbols/headings and runs with zero network access and zero API keys.

### `FR-04` — Commit-SHA-Aware Cache Invalidation & Blob Reuse
The system MUST detect when a repository's Git `HEAD` moves and automatically invalidate/reindex without serving stale commit data as current, while reusing unchanged file summaries by Git blob SHA.
- **Rules**:
  - `ensureFresh(ref)` reads current `headSha(repo.path)`.
  - If `repo.lastIndexedCommit === sha` and `repo_summaries` has a row for `(repo.id, sha)` at current `SUMMARIZER_VERSION`: increment `repoHits` and return cached data (no Git tree walk).
  - If `HEAD` moved or summary is missing: increment `repoMisses`; if previously indexed at a different SHA, increment `invalidations`; run `indexer.index(repo)`.
  - During non-forced indexing, any file whose `(repo_id, path, blob_sha)` exists in `files` from a prior commit is copied to the new `commit_sha` without re-reading its blob or re-running `summarizeFile`, incrementing `filesReused`.
  - After indexing, prune cached `files` and `repo_summaries` older than the newest `keepCommits` commits (default `3`).
  - Explicit `reindexRepo(ref, force = true)` deletes existing cached rows for `(repo.id, sha)` and recomputes all eligible files.
- **Acceptance Criteria**:
  1. Calling `repoSummary` twice at commit `SHA1` returns `cacheHit: false` on cold run (or after `--no-index` register) and `cacheHit: true` on the second call, incrementing `repoHits` by 1.
  2. Making a new commit `SHA2` that modifies 1 of N tracked files causes the next `repoSummary` to return `commitSha === SHA2`, `cacheHit: false`, `invalidations` incremented by 1, `filesIndexed === 1`, and `filesReused === N - 1`.
  3. After 5 distinct commits are indexed with default `keepCommits = 3`, SQLite retains summaries/files for only the 3 newest commits for that repo.

### `FR-05` — File Filtering, Binary Detection & Resource Bounds
The system MUST skip non-source junk, binary files, and oversized files to prevent monorepo blowups.
- **Rules**:
  - `shouldIndex(path)` skips directories `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`), minified assets (`*.min.js`, `*.min.css`), and binary/media/archive/database/map extensions.
  - Files exceeding `maxFileBytes` (default `200,000` bytes) are skipped; per-repo indexed file count is capped at `maxFilesPerRepo` (default `5,000`, sorted deterministically by path).
  - Blobs containing NUL bytes (`0x00`) in the first 8,000 bytes (`looksBinary`) are skipped.
  - Skipped file count is reported in `IndexResult.filesSkipped`.
- **Acceptance Criteria**:
  1. A repo containing `node_modules/`, a `> 200 KB` file, a lockfile, and a binary file with NUL bytes indexes only the valid source files and reports accurate `filesSkipped > 0`.
  2. None of the skipped junk files appear in `files` table rows or `search_context` results.

### `FR-06` — Keyword Context Search Across One or All Repos
The system MUST support deterministic keyword search over cached summaries, symbols, paths, and keywords across all registered repos or scoped to a single repo.
- **Rules**:
  - Query is tokenized via `tokenize()` (identifier splitting + stopword removal); empty token set returns `[]`.
  - Target repos are refreshed via `ensureFresh()` before scanning so search never returns stale commits.
  - Weighted scoring per token: `+4` symbol match, `+3` path match, `+1.5` summary match, `+1` keyword exact match; plus `+3` substring phrase bonus when `phrase.length > 3`.
  - Results are sorted deterministically by `score DESC`, `repoName ASC`, `path ASC`, and capped by `limit` (default `10`, clamped to `[1, 100]`).
  - Returns `SearchHit[]` with summaries and up to 10 symbols (not raw file bodies).
- **Acceptance Criteria**:
  1. Searching a known symbol name returns the defining file ranked above incidental mentions, with `commitSha` matching `HEAD`.
  2. Passing `repo` restricts hits strictly to that repository; omitting `repo` returns matches across all registered repos.
  3. `limit` is honored and clamped within `[1, 100]`.

### `FR-07` — File Context Inspection (Summary + Optional Content)
The system MUST return cached summary metadata for a specific `(repo, path)` at `HEAD`, with optional truncated raw file content read from Git.
- **Rules**:
  - Calls `ensureFresh(ref)` and normalizes leading `./` or `/`.
  - Looks up cached record via `cache.getFile()` (updating `fileHits` / `fileMisses`).
  - If the file was not indexed (e.g., exceeded size cap or skipped type) but exists in Git at `HEAD`, falls back to `git show <sha>:<path>`, summarizes on the fly, and returns `cacheHit: false`.
  - Missing paths throw a "File not found" error (mapped to MCP `isError: true` / HTTP `404`).
  - When `include_content` is true, returns content truncated to `max_chars` (default `8000`) and sets `truncated: boolean`.
- **Acceptance Criteria**:
  1. `get_file_context` for an indexed file on a warm repo returns `cacheHit: true`, `summary`, `symbols`, `language`, `byteSize`, and `commitSha === HEAD`.
  2. Passing `include_content: true, max_chars: 100` returns `content.length <= 100` and `truncated: true` when the file exceeds 100 chars.
  3. Requesting a non-existent path fails with a clear not-found error.

### `FR-08` — Persisted & Session Cache Telemetry
The system MUST expose cache hit/miss and maintenance counters persisted across processes in SQLite alongside per-process session counters.
- **Rules**:
  - Tracked counters: `fileHits`, `fileMisses`, `repoHits`, `repoMisses`, `invalidations`, `reindexes`.
  - Aggregate fields: `hits = fileHits + repoHits`, `misses = fileMisses + repoMisses`, `hitRate = hits / (hits + misses)` (4 decimal places, `0` when total is 0), `repos`, `files`, `dbPath`, `session`.
- **Acceptance Criteria**:
  1. Counter increments performed by Process A are reflected in `stats()` returned by Process B using the same `dataDir`, while `session` reflects only Process B's activity.

### `FR-09` — MCP Stdio Server Interface (7 Tools)
The system MUST expose an MCP server over stdio (`@modelcontextprotocol/sdk`, server name `mirevox-context-engine`) validating inputs with Zod and returning structured JSON text content (or `{ isError: true }` on failures).
- **Required Tools**:
  1. `list_repos` — `{}` → `RepoStatus[]`
  2. `register_repo` — `{ path, name?, index? }` → `{ repo, indexed? }`
  3. `get_repo_summary` — `{ repo }` → `RepoSummary`
  4. `search_context` — `{ query, repo?, limit? }` → `SearchHit[]`
  5. `get_file_context` — `{ repo, path, include_content?, max_chars? }` → `FileContext`
  6. `cache_stats` — `{}` → `CacheStats`
  7. `reindex_repo` — `{ repo, force? }` → `IndexResult`
- **Acceptance Criteria**:
  1. An MCP client connecting over stdio lists all 7 tools with valid input schemas.
  2. Calling each tool against a registered fixture repo returns parseable JSON matching the domain types.
  3. Calling a tool with an unknown repo returns `{ isError: true }` without crashing the server.

### `FR-10` — Local HTTP JSON API
The system MUST expose an HTTP JSON API (`createHttpServer` / `serve-http`) defaulting to loopback `127.0.0.1:7437`.
- **Required Routes**:
  - `GET /health` → `200 { ok: true, name: "mirevox-context-engine" }` (unauthenticated)
  - `GET /repos` → `200 RepoStatus[]`
  - `POST /repos` `{ path, name?, index? }` → `201 { repo, indexed? }`
  - `DELETE /repos/:ref` → `200 RegisteredRepo`
  - `GET /repos/:ref/summary` → `200 RepoSummary`
  - `POST /repos/:ref/reindex` `{ force? }` → `200 IndexResult`
  - `GET /search?q=&repo=&limit=` → `200 SearchHit[]`
  - `GET /file?repo=&path=&content=1&max_chars=` → `200 FileContext`
  - `GET /stats` → `200 CacheStats`
- **Auth & Limits**:
  - When `token` option or `CONTEXT_ENGINE_TOKEN` env var is set, all non-`/health` routes MUST require `Authorization: Bearer <token>` or return `401 Unauthorized`.
  - JSON request bodies > 1,000,000 bytes return `413`; invalid JSON or missing required params return `400`; unknown repo/file returns `404`.
- **Acceptance Criteria**:
  1. All 9 endpoints return expected status codes and JSON payloads against a fixture repo.
  2. With `CONTEXT_ENGINE_TOKEN=secret`, `GET /health` returns `200`, unauthenticated `GET /stats` returns `401`, and `Authorization: Bearer secret` returns `200`.

### `FR-11` — CLI Interface
The system MUST provide a `context-engine` CLI (`dist/cli.js`) supporting `--data-dir <dir>` (and documented alias if advertised in README) and `--json` global options.
- **Required Commands**: `register <path> [-n|--name] [--no-index]`, `unregister <repo>`, `index [repo] [-f|--force]`, `status`, `query <text> [-r|--repo] [-l|--limit]`, `serve-mcp`, `serve-http [-p|--port] [--host]`.
- **Acceptance Criteria**:
  1. Every command returns exit code `0` on success and `1` with `error: ...` on stderr for invalid inputs.
  2. Passing `--json` outputs valid JSON to stdout for `register`, `unregister`, `index`, `status`, and `query`.

### `FR-12` — Local Security & Secret-Hygiene Guardrails
The system MUST execute Git commands safely and prevent unintended exposure of secrets or local corpora.
- **Rules**:
  - All Git invocations MUST use `execFileSync("git", ["-C", cwd, ...])` with argument arrays (never shell string interpolation).
  - Default operation makes zero outbound network connections and sends no telemetry.
  - HTTP server binds to `127.0.0.1` by default.
  - **Council security guardrail (hardening target)**: Secret-shaped filenames (`.env`, `.env.*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `id_rsa`) MUST be excluded from indexing so secret values never enter `cache.sqlite`, and binding HTTP to a non-loopback host without `CONTEXT_ENGINE_TOKEN` MUST fail closed.
- **Acceptance Criteria**:
  1. Static audit confirms zero `exec`/`execSync` shell calls and zero outbound HTTP/fetch calls in `src/`.
  2. Fixture canary secret in `.env` or `*.key` produces zero matches in `cache.sqlite` and tool outputs (verified in `docs/acceptance.md`).

---

## 2. Non-Functional Requirements (NFR)

| ID | Category | Requirement | Measurable Acceptance Criterion |
|---|---|---|---|
| `NFR-01` | **Zero Native Build / Runtime** | Run on Node.js `>= 22.5.0` using built-in `node:sqlite`, `node:http`, `node:crypto`, and `node:child_process` with minimal runtime dependencies (`@modelcontextprotocol/sdk`, `commander`, `zod`). | `npm install && npm run build` succeeds on Linux without `node-gyp` or C++ toolchain; `tsc --noEmit` exits `0`. |
| `NFR-02` | **Determinism & Offline Operation** | Indexing, summarization, and search MUST be deterministic and function 100% offline. | Two clean runs on the fixture repo with no network access produce identical summaries, symbols, and search rankings. |
| `NFR-03` | **Multi-Process Concurrency & Durability** | Shared SQLite cache MUST survive concurrent reads/writes from multiple local clients and persist across process restarts. | WAL mode + `busy_timeout = 5000` + `BEGIN IMMEDIATE` enabled on every `openDb()`; data persists after closing and reopening `ContextEngine`. |
| `NFR-04` | **Local Performance** | Indexing and querying typical repositories MUST remain fast enough for interactive agent tool calls. | Fixture repo cold index completes in `< 500 ms`; warm `repoSummary` / `search` / `fileContext` completes in `< 50 ms`; blob reads are batched (`BATCH = 300` via `git cat-file --batch`). |
| `NFR-05` | **Payload Compactness** | Returned summaries MUST stay compact to reduce agent context bloat. | Per-file summary is capped at `<= 420` chars; `get_repo_summary` response byte size is strictly smaller than total tracked source bytes on non-trivial repos. |
| `NFR-06` | **Modularity & Composability** | Core engine (`src/engine.ts`) MUST remain decoupled from transport layers (`mcp.ts`, `http.ts`, `cli.ts`) and have zero runtime dependency on other Mirevox modules. | Library consumers can import `ContextEngine` from `dist/index.js` without starting MCP or HTTP servers. |
| `NFR-07` | **Open-Source Packaging** | Ship under `Apache-2.0` as a Mirevox module with `LICENSE`, `README.md`, runnable fixture script (`npm run fixture:init`), and council `docs/`. | Fresh clone runs `npm install && npm run build && npm run fixture:init && npm test` cleanly. |
| `NFR-08` | **Error Isolation** | Malformed files, unreadable repos, or invalid client queries MUST never crash a long-running MCP or HTTP server process. | `listRepos()` captures per-repo Git errors into `RepoStatus.error`; MCP catches exceptions into `{ isError: true }`; HTTP returns structured `{ error }` JSON with `4xx`/`5xx`. |
