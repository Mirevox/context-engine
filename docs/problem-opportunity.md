# Mirevox `context-engine` — Problem & Opportunity

- **Product**: `@mirevox/context-engine` (`https://github.com/Mirevox/context-engine`)
- **License**: Apache-2.0
- **Status**: v1 shipped (TypeScript / Node 22 / SQLite / MCP + HTTP + CLI)

---

## 1. Problem Statement

Developers and coding agents working across multiple local Git repositories repeatedly pay the same orientation cost: walking directory trees, scanning READMEs and manifests, and opening files just to answer basic structural questions ("which repo owns billing?", "what symbols live in `src/auth.ts`?", "what is the layout of service B?").

This repeated ingestion happens because current context tooling breaks along three seams:

1. **Per-session and per-harness amnesia.** A summary or map assembled inside one Cursor, Claude Code, VS Code, or CLI agent session is discarded when the session ends and is invisible to other tools running on the same machine.
2. **Expensive or opaque indexing defaults.** Many code-context tools require external LLM or embedding API keys just to build an initial index, introducing non-deterministic prose, ongoing token bills before a single query is answered, and outbound network egress of private source code.
3. **Silent staleness across moving checkouts.** Static repo dumps and timestamp-based caches quickly drift from `HEAD`, causing agents to navigate moved paths or outdated APIs without knowing the index is stale.

---

## 2. Opportunity

There is a practical, focused opportunity for a **harness-neutral, local-first, commit-aware context service** that turns local Git repositories into deterministic, reusable structural summaries stored once in a shared SQLite cache.

Rather than competing with full enterprise search platforms or shipping another vector database, Mirevox `context-engine` targets a sharp v1 slice:

- **Zero-LLM deterministic indexing.** Extractive summaries (language breakdown, top-level layout, key entry paths, leading comments/docstrings, top-level symbols, Markdown headings, and split-identifier keywords) cost zero model tokens, work 100% offline, and produce identical output for the same commit and summarizer version.
- **Commit-SHA-exact freshness with blob-level reuse.** Every cached artifact is keyed by `(repo_id, commit_sha, path)`. When `HEAD` matches the indexed commit, reads return immediately from SQLite without touching the Git tree. When `HEAD` moves, only changed blobs are re-read and re-summarized; unchanged `(repo_id, path, blob_sha)` entries are copied forward in SQLite.
- **One shared cache across harnesses on the same host.** Multiple MCP stdio clients, CLI invocations, and local HTTP callers point at the same `--data-dir` (or `$MIREVOX_CONTEXT_DIR`) backed by SQLite WAL mode, sharing summaries and persisted hit/miss telemetry.
- **Boring, composable interfaces.** Exposes the same `ContextEngine` core over MCP (stdio), loopback HTTP JSON, and a scriptable CLI (`--json`), allowing standalone use today and clean composition with other Mirevox control-plane modules (`smart-router`, `stage-gate`, `shadow-versioning`).

---

## 3. Target Users & Primary Workflows

| Persona | Workflow | Value Delivered |
|---|---|---|
| **Multi-repo developer** | Registers 3–15 local clones once and connects Cursor / VS Code / Claude Code via MCP stdio. | Orientation queries (`list_repos`, `get_repo_summary`, `search_context`, `get_file_context`) hit a shared SQLite cache instead of re-walking trees every session. |
| **Local automation / CI script** | Calls `context-engine status --json`, `query`, or loopback HTTP endpoints against the same data dir. | Reuses summaries already built by interactive agents; detects staleness against live Git `HEAD`. |
| **Mirevox control-plane integrator** | Connects `smart-router` or `stage-gate` to `context-engine` over MCP or HTTP. | Pulls compact, deterministic repo overviews and symbol maps into downstream workflows with zero LLM overhead and no hard coupling. |

---

## 4. Honest v1 Scope & Non-Goals

Guided by the council's devil's advocate and market-gap reviews, v1 deliberately keeps its promise narrow and verifiable:

**In scope for v1:**
- Explicit registration of existing local Git repositories (must have at least one commit).
- Deterministic extractive summarization of tracked blobs at `HEAD` (no LLM calls, no embeddings, no outbound network traffic).
- Commit-SHA-keyed SQLite (`node:sqlite`, WAL mode) cache in a configurable shared data directory with persisted hit/miss/invalidation counters and automatic commit pruning.
- Three thin interfaces over one core engine: MCP stdio server, loopback HTTP JSON API (with optional bearer token), and CLI.

**Explicitly out of scope for v1:**
- Vector databases, embeddings, semantic rerankers, or LLM-generated prose summaries on the default path.
- Remote Git cloning, org-wide repository discovery, or Git history/commit-log summarization.
- Multi-tenant authentication, per-repository ACLs, SSO, or internet-exposed SaaS hosting (v1 trust boundary is the local OS user / shared local host).
- Indexing uncommitted dirty working-tree edits (v1 indexes committed Git trees at `HEAD`).

---

## 5. Measurable v1 Success Outcomes

1. **Multi-client reuse:** A second client/process querying the same registered repo at the same `HEAD` records a persisted cache hit (`cacheHit: true`, incremented `repoHits`/`fileHits`) without re-walking the repository.
2. **Commit-aware invalidation + incremental reuse:** After a single-file commit moves `HEAD`, the next lookup detects the SHA change, increments `invalidations`, re-summarizes only the changed blob(s), and reuses unchanged files via `(repo_id, path, blob_sha)`.
3. **Compact orientation payloads:** `get_repo_summary` and `search_context` return bounded, structured summaries (max 420 chars per file summary) materially smaller than reading raw repository trees.
4. **Zero-dependency local operation:** Runs offline on Node >= 22.5.0 using built-in `node:sqlite`, with zero external services, zero API keys, and zero outbound sockets during indexing or serving.
