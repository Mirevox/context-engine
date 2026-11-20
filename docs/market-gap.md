# Mirevox `context-engine`: Market Gap

_Research current as of 20 November 2026._

## Executive view

The market does not lack code indexes. Cursor, GitHub Copilot, Sourcegraph Cody, Continue, Aider, Sweep, DeepWiki, Repomix, and numerous code-RAG projects already retrieve code more efficiently than rereading a repository wholesale.

The narrower opportunity is a **harness-neutral, team-shared context service** that:

1. treats a multi-repository snapshot as an explicit set of repository identities and commit SHAs;
2. stores compact, inspectable summaries and relationship artifacts against that immutable snapshot;
3. reuses those artifacts across developers, agents, IDEs, CI jobs, and sessions through MCP;
4. recomputes only the changed parts and clearly reports staleness and provenance; and
5. optimizes for fewer file reads and smaller tool results, not merely faster search.

This is not an uncontested category. In particular, Sourcegraph already offers shared multi-repository search, GitHub says a Copilot index is built once per repository, DeepWiki exposes generated repository documentation over MCP, and emerging open-source projects such as repomesh and rag-rat are close to the proposed design. Mirevox is worth shipping only if it makes **shared, commit-exact semantic reuse** the product rather than adding one more local vector database.

## Competitive and adjacent landscape

| Product | What it does | What remains open for Mirevox |
|---|---|---|
| **Cursor** | Current Agent search uses local **Instant Grep**, with a per-repository index under `.git/cursor/`; Cursor says it does not upload code or store embeddings for this search. Cursor has also published an earlier/team-oriented semantic indexing design that reused near-identical teammate indexes using Merkle trees, chunk hashes, and similarity matching. ([search docs](https://cursor.com/docs/agent/tools/search), [shared-index design](https://cursor.com/blog/secure-codebase-indexing)) | The current local index is IDE-specific and per repo. The published shared-index design proves that team reuse is valuable, so Mirevox cannot claim that insight as novel; it can instead offer an open, self-hosted, cross-harness version centered on reusable summaries and exact commits. |
| **GitHub Copilot** | Builds semantic indexes for repositories; GitHub says an index is built once per repository and is then available to Copilot Chat and its cloud agent. VS Code agents can also search other GitHub repositories using semantic and text-search tools. ([GitHub docs](https://docs.github.com/en/copilot/concepts/prompting-and-context/repository-indexing), [VS Code docs](https://code.visualstudio.com/docs/agents/reference/workspace-context)) | Strong shared indexing inside the GitHub/Copilot boundary, but not a vendor-neutral team context plane. Cross-repo search is available, yet the documented unit is still repository search, not a reusable semantic snapshot spanning a service graph. |
| **Sourcegraph Cody** | Uses Sourcegraph search and code-graph infrastructure to retrieve local and remote code. Cody Enterprise supports context from up to 10 repositories and admin context filters. ([enterprise features](https://sourcegraph.com/docs/cody/enterprise/features), [context docs](https://sourcegraph.com/docs/cody/core-concepts/context)) | This is the most mature enterprise substitute for shared multi-repo retrieval. Mirevox must compete on lightweight deployment, open MCP access, commit-exact derived artifacts, and reuse by non-Cody agents—not on generic cross-repo search. |
| **Continue.dev** | Supports embeddings-based indexing, local storage, repository maps inspired by Aider, built-in file/search tools, and arbitrary MCP servers. Its old `@Codebase` provider is deprecated; its own guide recommends custom MCP or custom code RAG for large private corpora. ([embeddings](https://docs.continue.dev/customize/model-roles/embeddings), [codebase awareness](https://docs.continue.dev/guides/codebase-documentation-awareness), [MCP](https://docs.continue.dev/customize/deep-dives/mcp)) | Continue is a capable client and integration target, but it leaves shared private-code RAG as user infrastructure. Mirevox can fill that server-side gap rather than duplicate Continue's editor experience. |
| **Aider repo map** | Uses Tree-sitter to extract definitions and references, ranks them using a dependency graph, and sends a token-budgeted map—1,000 tokens by default—with requests. ([repo-map docs](https://aider.chat/docs/repomap.html)) | Excellent single-repo compression, but primarily a local, per-agent map rather than an organization-wide multi-repo knowledge service. It is also a useful baseline: Mirevox should demonstrate better reuse and cross-repo answers, not merely produce another symbol outline. |
| **DeepWiki / Devin** | Auto-generates repository wikis with architecture diagrams, summaries, and source links. Its free remote MCP server exposes wiki structure, contents, and Q&A for public GitHub repositories; its question tool accepts up to 10 repositories. Private-repository support sits behind Devin. ([DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki), [MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp)) | This is a direct proof that generated summaries plus MCP are useful. The open gap is a self-hosted/private, commit-addressed, refresh-transparent implementation whose artifacts can be reused without buying an agent platform. |
| **Repomix** | Packs a local or remote repository into an AI-friendly file, counts tokens, includes Git logs/diffs, compresses code with Tree-sitter, accepts a commit as the remote ref, and can run as an MCP server. ([project](https://github.com/yamadashy/repomix), [usage](https://repomix.com/guide/usage)) | Portable and simple, but its core abstraction is a generated repository bundle. It does not by itself provide a shared, incrementally maintained team index or durable semantic summaries across a multi-repo dependency graph. |
| **Sweep** | Its published search design hashes chunks, reuses unchanged content from Redis, and updates the index after merged pull requests; it has also used lexical search, repository trees, ctags, and JetBrains PSI for context. ([search design](https://github.com/sweepai/sweep/blob/main/docs/pages/blogs/search-infra.mdx), [current agent](https://docs.sweep.dev/agent)) | Demonstrates commit/change-aware cache economics, but the intelligence is coupled to Sweep's coding product. Mirevox can expose the reusable infrastructure as a small independent service. |
| **LlamaIndex and generic code RAG** | Supplies GitHub readers, AST-aware `CodeSplitter`, `VectorStoreIndex`, and integrations with many persistent vector stores. ([GitHub reader](https://developers.llamaindex.ai/python/examples/data_connectors/githubrepositoryreaderdemo/), [code splitter](https://developers.llamaindex.ai/python/framework/module_guides/loading/node_parsers/modules/), [vector stores](https://developers.llamaindex.ai/python/framework/module_guides/storing/vector_stores/)) | These are construction primitives, not an opinionated shared code-context product. Users still need identity, repository synchronization, commit/version semantics, invalidation, authorization, cross-repo relationships, MCP contracts, and observability. |
| **Mem0** | Provides persistent searchable memory scoped by user, agent, or `run_id`; its OSS server exposes memory CRUD/search over REST, and agents can share a project/run memory. ([team memory](https://docs.mem0.ai/cookbooks/operations/team-task-agent), [OSS REST API](https://docs.mem0.ai/open-source/features/rest-api)) | Strong adjacent memory layer, but its documented abstractions are conversations and entities, not source trees, Git commits, symbols, or safe invalidation after code changes. Mirevox should integrate with general memory systems rather than imitate them. |
| **Continual** | Organizes source, branches, threads, apps, and data into shared projects and exposes workspace- or project-scoped tools to external agents through MCP. ([projects](https://continual.ai/docs/concepts/projects), [MCP](https://continual.ai/docs/reference/mcp)) | Shows demand for project-scoped context over MCP, but is a broader application/agent platform. A standalone code-context server can remain usable from any agent stack and source host. |
| **Emerging OSS code-context MCPs** | **repomesh** builds per-repo graphs, cross-repo links, compact summaries, HEAD staleness checks, and incremental refresh. **rag-rat** combines commit/worktree-aware indexing with durable source-anchored memories. **multi-cc-rag** shares one multi-repo index across concurrent sessions and attributes results to repo, branch, and commit. ([repomesh](https://github.com/Lorquas/repomesh), [rag-rat](https://github.com/cq27-dev/rag-rat), [multi-cc-rag](https://github.com/wolframs/multi-cc-rag)) | These are the closest open-source substitutes and materially reduce novelty. Mirevox needs a visibly different center of gravity: zero-dependency portable SQLite storage, commit-exact invalidation with blob reuse, artifact provenance, harness-neutral MCP/HTTP/CLI access, and measured reuse across different harnesses. |

## The gap, stated precisely

### 1. Shared cache keyed by exact source state

Many tools cache embeddings, symbols, or search indexes. Fewer expose a durable summary artifact with an explicit key such as:

`(repoId, commitSha, path, summarizerVersion)`

Branch names alone are unsafe because they move; file modification times are not portable; "latest" silently mixes incompatible versions. Exact commit keys make an answer reproducible and let multiple clients/sessions reuse the same repository overview without each re-walking the tree.

### 2. Multi-repo context as a first-class unit

Cody and DeepWiki already query several repositories, while several OSS projects search a group of indexes. Mirevox's v1 slice establishes a clean local registry of named repositories with exact `HEAD` tracking, per-repo overviews, cross-repo keyword search, and per-file summaries—providing the foundation for multi-repo snapshot manifests and cross-repo relationships in later releases.

### 3. Avoid repeated orientation work, not just repeated embedding

Existing indexes often avoid re-embedding unchanged chunks, but agents still spend tool calls and context tokens opening the same files and reconstructing the same facts. Even before optional LLM synthesis, deterministic extractive summaries cached by `(repoId, commitSha, path)` with blob-SHA reuse eliminate repeated directory walks and file reads at zero token cost.

The honest claim is **reduced repeated tree walks, file reads, and tool-result volume**. It should not claim to eliminate token costs: retrieved summaries still consume prompt tokens, query-specific reasoning still has to run, and editing tasks still require opening real source files.

### 4. Harness neutrality and open deployment

Copilot, Cursor, Cody, Devin, and Sweep optimize context within their own products. Continue and Repomix can consume MCP, but do not supply a lightweight shared SQLite summary cache with HTTP and CLI parity. A narrow Apache-2.0 MCP/HTTP/CLI server can serve Cursor, Claude Code, VS Code, Continue, CI scripts, and custom Mirevox modules from the same cache directory on disk.

## Why ship it as an open-source Mirevox module

- **It is shared infrastructure, not a destination app.** An open protocol and permissive Apache-2.0 implementation encourage IDEs and agents to interoperate instead of rebuilding private indexes.
- **Small teams and solo builders bear duplicate orientation cost immediately.** Running multiple harnesses on one workstation or homelab box does not justify Sourcegraph-scale infrastructure or a proprietary agent suite.
- **Zero-LLM deterministic defaults remove adoption friction.** Users can run it offline on Node 22 with built-in SQLite—no vector DB, no API keys, no outbound egress.
- **Inspectability improves trust.** Users can inspect the exact SQLite rows, commit SHA, summarizer version, and cache hit/miss counters, and delete or rebuild any repo at any time.
- **It complements rather than replaces agents.** Mirevox `context-engine` plugs into existing harnesses and composes cleanly with `smart-router`, `stage-gate`, and `shadow-versioning`.

The recommended initial promise is modest: **"Index a set of local Git repositories once per commit without an LLM, share compact extractive context across every MCP/HTTP/CLI client on the host, and track the cache reuse."**

## Honest risks and commoditization

1. **The core primitives are commodities.** Git hashing, regex/AST extraction, SQLite, lexical scoring, and MCP servers are readily available. A basic implementation is easy to clone.
2. **Incumbents already amortize indexing.** GitHub builds a Copilot index once per repository; Sourcegraph maintains shared code search; Cursor has demonstrated teammate index reuse. Mirevox cannot lead with "do not index every clone" as if nobody does it.
3. **Direct OSS competition already exists.** repomesh, rag-rat, multi-cc-rag, and similar projects overlap materially. Operational simplicity (single Node 22 binary + built-in SQLite), reliability, and clean composition will matter more than a feature checklist.
4. **Agents are getting better at cheap search.** Fast local grep (`rg`) and language servers often outperform elaborate semantic indexes for targeted lookups. Mirevox must remain faster and more compact than cold multi-repo discovery.
5. **Summaries decay semantically.** Commit keys prevent accidental reuse across versions, and blob-SHA reuse avoids redundant work on unchanged files, but structural extracts still omit runtime nuances that editing tasks need.
6. **Cross-repo access control is deferred.** In v1, the trust boundary is the local OS user. Any future networked team deployment must solve per-repository authorization before sharing derived summaries across users.
7. **The cache can become a prompt-injection or secret-leak surface.** Repository text is untrusted input and may contain credentials; strict secret denylists and local-only defaults are essential.
8. **Extractor upgrades fragment the cache.** Exact reproducibility requires `summarizer_version` in the lookup key, causing clean misses when extractor logic improves.
9. **Token savings may be overstated.** Faster retrieval is not automatically fewer billed tokens. Claims should be backed by measured cache hit rates and response byte sizes against fixtures.
10. **MCP is an interface, not a moat.** Vendors can add equivalent tools quickly. Durable value comes from dependable invalidation, portable storage, and ecosystem composition.

## Shipping test (v1)

Mirevox `context-engine` v1 earns its place if it demonstrates all four outcomes locally and offline:

- a second local client/process at the same commit receives an immediate SQLite cache hit without re-walking the tree;
- a single-file commit invalidates the repo cleanly, re-summarizes only the modified blob, and never serves the prior commit as current;
- cross-repo search and repo summaries return compact, deterministic, symbol-bearing context materially smaller than raw files; and
- MCP (stdio), HTTP JSON, and CLI clients consume the same shared data directory without product-specific adapters.
