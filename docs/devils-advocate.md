# Context Engine — Devil’s Advocate

Role: kill weak claims. Force an honest v1 scope.

Pitched product: an MCP server that indexes many git repos, caches commit-aware summaries, and shares that cache so developers and agents stop re-burning tokens.

Brand: Mirevox. Open source (Apache-2.0). v1 is one local slice. It is a local tool. It is not a platform.

The sentence that should survive into the README:

> A single user or host can point this at local Git clones already on disk and get a deterministic, commit-keyed extractive map that a second local process can read from a shared SQLite cache without walking the tree again.

The sentence that must not survive:

> Teams share an index of many repos and stop paying tokens.

---

## 1. Attack the value prop

Token burn is real. A shared summary cache is a bad default explanation of it.

Agents re-burn tokens because harnesses re-send chat history, tool traces, and whole files the model asked for again. They do not, in the common case, re-ingest fifteen repositories from commit zero on every turn. A competent harness already reads the file the task named. A cache of prose about other files does not cancel the history replay, and it adds a new blob the model has to read.

### When a shared cache is a win

All of these have to be true at once. Drop one and the cache is overhead.

- The same commit is asked about more than once before `HEAD` moves. The second reader is a process that does not already have the tree in its context: a second agent, a fresh session, a CI check. A second question inside one session that already holds the files is not a win.
- The cached object is smaller than the tree it replaces, and it is sufficient for the question. A map that answers "where does X live?" with a real path and symbol list is sufficient. A vibe summary that still forces the agent to open the files is extra tokens, then the original tokens.
- Invalidation is blob-aware or the repo is slow-moving. A cache keyed only on "we indexed recently" is a lie. A cache keyed on whole-repo `HEAD` without blob reuse recomputes the entire repo on every typo fix.
- The readers share a trust boundary with the indexer. One person, one machine, clones they are already allowed to have. That is the only boundary v1 can enforce.
- The map is deterministic. Same SHA, same tool version, same bytes. Then a hit is debuggable. A temperature-0.7 "summary" that changes every run cannot be cached honestly and cannot be blamed when an agent follows it off a cliff.

The honest win is narrow: **a commit-keyed structural map of repos you already cloned, reused by another local process, for orientation questions whose answer is a path, layout, or symbol list.** Amortize one walk across two or more readers at the same SHA.

### When it loses

- One developer, one agent, one repo already open in the workspace. The index run costs the walk, the disk, and tool definitions in the prompt. The agent was going to open three files. You paid to avoid a cost they were not incurring.
- The "15 repos" story. Most tasks touch one repo. A cross-repo question is rare, and the answer rots as soon as either side merges. Indexing fifteen trees so one question a week can maybe be answered is a standing cost with no payer.
- Any task that writes code. Summaries omit signatures, error paths, and tests. The agent edits from the summary, the build fails, the next turns re-read the real files. Shared cache made the failure correlated: every agent inherits the same gap.
- Active branches. The expensive moment is the commit you do not have a summary for. That is the moment an agent is working. Hit rate peaks when nobody is working.
- Dirty trees. The bytes that matter are the ones not in `HEAD`. A commit-aware cache is blind to them. Serve it as "the context" without flagging dirty state and the agent repairs code the human already changed.
- Different jobs. A security pass and a UI pass do not share a useful summary. The shared object optimizes a generic question nobody asked.
- Team sharing as the pitch. Friends and teammates do not have the same repo ACL. One shared cache is the union of whatever the indexer could see. The person with the wider GitHub token becomes the silent exporter.
- Falling model prices. The token line item shrinks. Clone disk, secret scrubbing, stale lies, and MCP exposure do not. A product whose only promise is "fewer tokens" gets worse every price cut.
- Anything `rg`, ctags, `git ls-files`, or a committed `ARCHITECTURE.md` already answers. A new daemon that loses to ripgrep on "where is X?" has no value prop.

### What "commit-aware" is allowed to mean

It means the cache record stores the SHA it was built from, and the server compares that SHA to the worktree `HEAD` before it answers.

It does not mean the prose tracks the repo by magic. It does not mean dirty files are included. Whole-repo invalidation without blob reuse wastes work on every commit; blob-SHA reuse (`(repo_id, path, blob_sha)`) recovers incremental efficiency while keeping exact `HEAD` correctness. Silent staleness is never acceptable.

### The cost that eats the savings

Building the cache is itself a token bill if a model writes the summaries. One full-tree summarization of a real repo can exceed a week of lazy file reads by one agent. Embeddings make that worse: you pay to vectorize files no question ever retrieves, then you pay again to retrieve them, then the agent opens the file anyway.

Default v1 does not call a model and does not embed. A deterministic extractive map (paths, sizes, languages, size cap, symbol/heading extract, leading doc) is the product. Shared LLM summaries also share hallucinations; deterministic extracts fail transparently and reproducibly.

---

## 2. Failure modes

### Stale summaries

- Record built at SHA `A`, served after `HEAD` is `B`, with no invalidation or flag. The agent "fixes" code that already moved.
- Branch mix-up. Index of `main` answered to a client whose worktree is a feature branch. The SHA check has to inspect the live worktree `HEAD`, not "whatever this server indexed last."
- Dirty worktrees. Uncommitted edits are invisible to `git ls-tree HEAD`. Status should surface dirty state honestly instead of pretending uncommitted edits are indexed.
- Two writers. Concurrent CLI/MCP/HTTP processes hitting the same cache database must serialize writes cleanly (SQLite WAL + `BEGIN IMMEDIATE` + `busy_timeout`) rather than corrupting state or throwing `SQLITE_BUSY`.
- Non-determinism. Cache keys must include `summarizer_version` so algorithm updates never serve mixed-format records.

### Secret leakage into the cache

This is the failure that ends the project if v1 is casual about it.

- Indexers walk `.env`, `*.pem`, `*.key`, `credentials.json`, kubeconfigs, `.npmrc`, Jupyter outputs, and CI logs. A summary or keyword extract can copy secret fragments into `cache.sqlite`, which is easier to share or accidentally commit than the original repo.
- Git history is worse than `HEAD`. A key removed from `HEAD` is still in `git log -p`. v1 indexes the tree at `HEAD` only—never Git history.
- The cache directory becomes a second secret store with weaker controls than the Git host.
- Open source defaults matter: zero outbound calls, zero telemetry, local-only by default.

Canary rule: a fixture secret inside `.env` or a denylist-shaped key file that appears in `cache.sqlite`, logs, or tool outputs is a failed build.

Denylist minimum for hardening: `.env`, `.env.*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `id_rsa`, plus the size cap and binary filter.

### Huge monorepos and the "15 repos" demo

Fifteen small public repos are a demo script. One monorepo with `node_modules`, `vendor`, `dist`, `build`, lockfiles, or committed datasets will blow up disk and latency.

- v1 takes explicit local paths. It does not crawl the filesystem or GitHub.
- Default skip: `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, lockfiles, binary/media extensions, NUL-containing buffers, files over `maxFileBytes` (`200 KB`), and hard cap `maxFilesPerRepo` (`5000`).
- v1 does not clone. The operator provides local checkouts on disk.

### Embedding cost

- Embedding a tree nobody has queried is prepaid waste.
- Vector dimensions and model names are lock-in.
- v1 uses plain SQLite tables and lexical scoring over paths, symbols, summaries, and keywords—no Qdrant, no hosted vector DB, no embedding API keys.

### MCP & HTTP auth

- Stdio MCP inherits the OS user. That user can already read the clones. That is the v1 trust model.
- A TCP listener on `0.0.0.0` with no token publishes the corpus to the network. Default HTTP bind MUST be `127.0.0.1`. Binding non-loopback SHOULD require an explicit token (`CONTEXT_ENGINE_TOKEN`), and docs must state it is a single shared secret, not per-developer ACL.
- OAuth, dynamic client registration, and enterprise SSO are deferred.

---

## 3. Must ship vs theater

### Must ship (v1)

- MCP over stdio and HTTP on `127.0.0.1` only by default. Zero outbound connections.
- Explicit registration of existing local Git checkouts. No discovery crawler, no GitHub App, no clone.
- On-disk SQLite cache keyed by `(repo_id, commit_sha, path)` + `summarizer_version`, with blob-SHA reuse across commits.
- Lookup compares cached SHA to live worktree `HEAD`. Mismatch invalidates and reindexes—never serves an older SHA as current.
- Default junk skip list, binary filter, byte cap, and file count cap.
- Secret denylist so `.env` / `*.key` / `*.pem` never enter cached summaries or keywords.
- Deterministic extractive summaries (zero LLM required) + persisted hit/miss/invalidation stats.
- Plain-language trust model in README: local OS user / shared host, cache equals derived source, no team ACL, no invented token-savings percentage.
- Apache-2.0 `LICENSE` and offline test suite passing against in-tree fixtures.

### Theater — do not build, do not demo, do not claim

- "Shared context for the team" with multi-user ACLs. v1 has no user identity.
- Unmeasured percentage token-reduction claims ("save 90% tokens").
- Semantic embeddings, vector DBs, rerankers, or LLM-written architecture essays on the default path.
- Background file-watching daemons as a correctness claim.
- Web UI, admin dashboards, or token-savings charts.
- Runtime coupling to other Mirevox modules.
- Git-history summarization or auto-cloning from GitHub.

---

## 4. Ruthless v1 acceptance bar

Six checks. Each one can gate shipping:

1. **Correct and cheaper, once.** Fixture repo in-tree with known symbols. `get_repo_summary` / `search_context` names the exact file path and symbols. Response size is smaller than the raw fixture tree. A second call at the same `HEAD` records a cache hit (`cacheHit: true`, `repoHits` incremented) with zero re-indexing.
2. **Stale SHA is never served as fresh.** Index at `SHA1`. Commit a symbol move at `SHA2`. Next call detects `SHA2`, increments `invalidations`, and returns `SHA2` data (reusing unchanged blobs) rather than silently returning `SHA1`.
3. **Canary secret stays out.** Fixture contains `.env` / key file with a `CANARY_SECRET_mirevox_` value. After indexing, zero matches appear in `cache.sqlite` or tool responses.
4. **Junk does not sink the run.** Fixture includes `node_modules/`, a lockfile, a binary file, and an oversized file (`> 200 KB`). Indexing finishes quickly, records `filesSkipped > 0`, and excludes junk from search results.
5. **Default is local and quiet.** Default HTTP binds `127.0.0.1`; non-loopback without `CONTEXT_ENGINE_TOKEN` fails closed; default run makes zero outbound network connections.
6. **Honest worktree state.** Uncommitted dirty edits are not falsely claimed to be indexed (documented clearly and ideally flagged on status).

---

## 5. Defer (v2+)

- Vector databases, hosted embeddings, and semantic rerankers.
- Multi-tenant SaaS, org accounts, per-repo ACLs, OAuth/SSO.
- Web UI / dashboards.
- Remote WAN exposure (Tailscale/proxy/TLS) beyond explicit opt-in token auth.
- Dirty-worktree live indexing and background watchers.
- Optional LLM summary adapter behind an explicit opt-in interface.
- Git-history indexing and auto-cloning.

---

## 6. v1 Shipped Reality Check (Honest Audit Note)

Compared against this devil's advocate bar, the shipped `src/` slice **delivers** on:
- Zero-LLM deterministic extractive summaries (`src/summarizer.ts`)
- Exact `(repo_id, commit_sha, path)` + `summarizer_version` SQLite WAL cache with blob-SHA reuse (`src/cache.ts`, `src/indexer.ts`)
- Secret-file denylist (`isSecretPath()`) enforced in both `shouldIndex()` and `ContextEngine.fileContext()`
- Read-only local Git invocation, junk/binary/size caps, all 7 MCP tools (`src/mcp.ts`), loopback default HTTP with `assertSafeBind()` fail-closed guard on non-loopback binds without `CONTEXT_ENGINE_TOKEN`, and zero outbound calls.

Remaining caveat to keep honest in user docs and v2 backlog:
- Dirty working-tree state (uncommitted local modifications) is not yet flagged as a separate boolean on `listRepos()` / `status`; v1 strictly indexes committed Git trees at `HEAD`.
- README notes should keep `cache.sqlite` (not `cache.db`) consistent with `src/config.ts`.
