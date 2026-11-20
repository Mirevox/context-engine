# Problem statement — Mirevox `context-engine`

## The problem

Developers and coding agents that work across many local Git repositories repeatedly pay the same orientation cost: walking trees, opening READMEs, and scanning files to answer structural questions ("which repo owns billing?", "what lives in `src/auth.ts`?"). That work is discarded when a session ends, invisible to other harnesses on the same machine, and often rebuilt with LLM/embedding calls that cost tokens and send private source off-box. Timestamp-based caches also drift from `HEAD`, so agents navigate stale paths without knowing the index is wrong.

## Who feels it

- Multi-repo developers running Cursor, Claude Code, VS Code agents, and CLI tools against the same clones
- Small teams / home-lab operators who cannot justify Sourcegraph-scale shared search but still re-burn context every session
- Automation that wants compact repo overviews without standing up a vector database

## What we ship (v1)

A **local-first, harness-neutral context cache**:

1. Register existing local Git repos (must have a commit).
2. Build **deterministic extractive** file/repo summaries with **no LLM, no embeddings, no network**.
3. Persist them in SQLite keyed by `(repoId, commitSha, path)` with blob-SHA reuse when `HEAD` moves.
4. Serve one shared data directory over **MCP (stdio)**, **HTTP JSON**, and **CLI** (Docker Compose stands up the HTTP path).

## What we deliberately do not claim

- Not a replacement for Sourcegraph, Copilot repository indexing, or Cursor Instant Grep
- Not semantic/vector search on the default path
- Not multi-tenant SaaS or per-repo ACLs (trust boundary = local OS user / bearer token on the published port)
- Not dirty-worktree indexing — only committed trees at `HEAD`

## Success looks like

A second client on the same host, at the same commit, gets a SQLite cache hit instead of re-walking the tree; a one-file commit invalidates cleanly and re-summarizes only changed blobs; payloads stay compact (≤420 chars per file summary); and the stack runs offline on Node ≥ 22.5 with Apache-2.0 licensing.
