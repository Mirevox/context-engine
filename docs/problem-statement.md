# Mirevox `context-engine` — Problem Statement

## The Problem

When a developer or coding agent works across multiple local Git repositories on the same machine, every new session and every separate tool (IDE chat, CLI agent, local script) starts blind. Each client walks the same directory trees, opens the same READMEs, manifests, and source files, and reconstructs the same structural map ("which repo defines `calculateInvoice`?", "what is the layout of `billing`?", "what symbols are exported from `src/auth.ts`?") from scratch.

Existing ways to handle this break down in three practical ways:

1. **No reuse across local processes or harnesses.** Whatever structural map one agent session builds disappears when that session closes and cannot be read by another MCP client, CLI command, or local HTTP caller on the same host.
2. **Heavyweight indexing defaults.** Many code-context tools require LLM API keys, embedding models, vector databases, or outbound network access just to produce an initial index—adding token cost, external dependencies, and non-deterministic prose before a single lookup runs.
3. **Silent staleness as `HEAD` moves.** Static repo dumps and mtime-based caches drift out of sync as soon as a commit lands, without surfacing which commit SHA the summary actually came from.

## What `context-engine` Solves (v1)

`@mirevox/context-engine` is a local, offline, deterministic structural cache for Git repositories already checked out on disk.

- **Index once per commit, zero LLM required.** Given explicitly registered local Git checkouts (with at least one commit), the engine walks `git ls-tree HEAD` and generates bounded extractive summaries in pure TypeScript: detected language, line count, leading doc comment or README paragraph, regex-extracted top-level symbols/headings, split-identifier keywords (file summary capped at 420 characters), plus a repo overview (language counts, top-level directories, and ranked key paths).
- **Exact `HEAD` invalidation with blob-level reuse.** Every cached row in SQLite (`cache.sqlite`, built-in `node:sqlite`, WAL mode) is keyed by `(repo_id, commit_sha, path)` and `summarizer_version`. When `HEAD` matches the indexed commit, reads return directly from SQLite without walking Git. When `HEAD` moves, unchanged `(repo_id, path, blob_sha)` files are copied forward without re-reading or re-summarizing their blobs, and only the newest 3 commits per repo are retained.
- **One shared local cache across interfaces.** CLI commands (`context-engine`), MCP stdio tools (`serve-mcp`), a loopback HTTP JSON API (`127.0.0.1:7437`, optional `CONTEXT_ENGINE_TOKEN`), Docker Compose HTTP standup, and the `ContextEngine` TypeScript library all read and write the same configurable data directory (`--data-dir` / `$MIREVOX_CONTEXT_DIR` / `~/.mirevox/context-engine`), tracking persisted and per-session hit/miss/invalidation counters.

## Honest Boundaries (What v1 Does Not Solve)

- **Committed `HEAD` trees only.** Uncommitted (dirty) working-tree edits are not indexed, not searchable, and not flagged as stale by `status`.
- **Orientation, not full code understanding.** Extractive summaries and keyword search help locate repos, files, and symbols quickly across sessions; agents still need to open real source files before editing code, and v1 makes no blanket token-reduction percentage claim.
- **Single-host trust boundary.** There is no multi-user identity, per-repo ACL, or remote Git cloning. HTTP authentication, when enabled, is a single shared bearer token. Clients must share the same host, checkouts, and data directory (repo id is derived from realpath).
- **Best-effort secret path filtering.** v1 skips and refuses secret-shaped file basenames (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH key names, `*secret*`, `*credential*`) and common secret directory segments (`.ssh/`, `secret(s)/`, `credential(s)/`), binaries, lockfiles, `node_modules`/`dist`/`build`/`vendor`, and files over 200 KB — but does not scan file contents for secrets and does not catch every sensitive name (e.g. `.npmrc`, `kubeconfig` outside those dirs).
- **No embeddings or LLM synthesis.** Semantic vector retrieval, AST call graphs, and LLM-generated documentation are intentionally out of scope for v1.
