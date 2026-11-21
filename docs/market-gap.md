# Mirevox `context-engine`: Market Gap

_Research refreshed 20 November 2026 (validation wave)._

## Positioning (honest)

**A deterministic committed-code orientation cache for local agent fleets — not a semantic code search engine, team knowledge base, or foundation-model product.**

## Verdict: NARROW

Shared multi-repo MCP indexing is already a crowded category (Repowise, codesearch, rag-rat, Augment, Sourcegraph, Sourcebot, Copilot). Shipped v1 still addresses a **real but small** gap: several local MCP/CLI/HTTP clients can share one **model-free, inspectable, commit-exact** SQLite orientation cache without embeddings, API keys, or a hosted account.

Keep shipping it only as that narrow utility. Require measured wins over `rg` / Instant Grep on repeated orientation tasks before expanding into semantic search or hosted team products.

## Top four OSS alternatives

| Alternative | What it does | Gap left for Mirevox |
|---|---|---|
| **[Repowise](https://github.com/repowise-dev/repowise)** | Multi-repo workspace MCP (~8k★); federated search/overview; graphs, contracts, history. Optional `--no-prose`. | Far deeper than v1. Mirevox wins only on zero-LLM defaults and tiny footprint. |
| **[codesearch](https://github.com/flupkede/codesearch)** | Apache-2.0 Rust MCP; offline multi-repo BM25 + local embeddings + tree-sitter; cross-repo RRF. | Directly overlaps “offline MCP multi-repo.” Mirevox is smaller and has no embedding download. |
| **[rag-rat](https://github.com/cq27-dev/rag-rat)** | Machine-global SQLite; hybrid search, symbols/graphs, dirty-worktree overlays, 47 MCP tools. | Proves durable local SQLite + MCP exists. Mirevox is shallower and deliberately extractive-only. |
| **[agent-context-mcp](https://github.com/jeremymefford/agent-context-mcp)** | Shared local HTTP MCP; Tantivy + SQLite; multi-repo scopes; hybrid/symbol tools. | Closest harness-neutral shared-service shape. Leaves Mirevox a simplicity niche. |

Also track: Sourcegull, repomesh, multi-cc-rag, Repomix (packer, not a maintained shared index), Srclight, Frigg, Relith.

## Top four paid / commercial alternatives

| Alternative | What it does | Gap left for Mirevox |
|---|---|---|
| **[Augment Context Engine MCP](https://docs.augmentcode.com/context-services/mcp/overview)** | Local or hosted context for any MCP agent; cross-repo semantic/relationship retrieval. | Owns “context engine for any MCP agent.” Mirevox must lead with offline + no per-query cost. |
| **[Sourcegraph Enterprise / Cody](https://sourcegraph.com/docs/api/mcp)** | Mature cross-repo search, SCIP, Deep Search over MCP; Cody multi-repo. | Enterprise substitute. Compete only on local footprint and cost. |
| **[Sourcebot](https://docs.sourcebot.dev/docs/mcp/overview)** | Self-hosted index of all connected repos + MCP (now closed-source core). | Makes “one MCP over company repos” a commodity. |
| **[GitHub Copilot](https://docs.github.com/en/copilot/concepts/prompting-and-context/repository-indexing)** | Per-repo semantic indexes; org-wide search inside GitHub. | Hosted amortization. Mirevox matters where offline / vendor-neutral committed snapshots are required. |

Adjacent: DeepWiki/Devin MCP, Cursor Instant Grep (local; no uploaded search embeddings per current Agent docs), Continue (client that consumes MCP).

## What shipped v1 actually does

- Registers local Git checkouts; indexes tracked blobs at committed `HEAD` (dirty tree out of scope).
- Deterministic extractive summaries (≤420 chars) — language, layout, symbols, keywords — **no LLM, no embeddings**.
- SQLite WAL keyed by `(repo_id, commit_sha, path)` with `summarizer_version` on lookup; blob reuse when same repo + path + blob SHA; keep newest 3 commits.
- MCP stdio + HTTP JSON + CLI over one shared data directory; Docker Compose stands up HTTP with healthcheck + bearer token.
- Repo id = SHA-1 of **realpath** → separate clones do **not** share rows. “Shared” means same host + same checkouts + same data dir.

## Gap, stated precisely

1. **Model-free orientation cache** — still scarce as a tiny Apache-2.0 Node module with MCP/HTTP/CLI parity.
2. **Commit-exact invalidation with inspectable counters** — not novel, but cleanly packaged.
3. **Not** missing: multi-repo MCP search, semantic retrieval, team indexes (those exist elsewhere).

## Shipping test

Earn expansion only if a fixture benchmark beats `rg`/Instant Grep (and ideally codesearch or Repowise) on: warm latency, returned bytes/tokens, tool-call count, and stale-answer rate for orientation queries — without worse recall on symbol lookups.

## Dark theme

**N/A — no UI** (CLI/MCP/HTTP only).
