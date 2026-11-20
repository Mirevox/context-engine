# Mirevox Context Engine

Shared multi-repo context for agent harnesses. Index local git repos once, cache **commit-aware** extractive summaries in SQLite, and serve them over **MCP (stdio)** or a small **HTTP JSON** API so teammates and agents on the same host do not re-burn tokens on the same corpus.

Part of the [Mirevox](https://github.com/Mirevox) open-source control-plane modules.

## Requirements

- Node.js ≥ 22.5 (uses built-in `node:sqlite`)
- Local git repositories to index

## Quick start

```bash
npm install
npm run build
npm test

DATA=./.mirevox-context

# Register any local git checkouts (fixtures work after git init)
node --experimental-sqlite dist/cli.js --data-dir "$DATA" --json register ./fixtures/sample-alpha -n alpha
node --experimental-sqlite dist/cli.js --data-dir "$DATA" --json register ./fixtures/sample-beta -n beta
node --experimental-sqlite dist/cli.js --data-dir "$DATA" status
node --experimental-sqlite dist/cli.js --data-dir "$DATA" --json query greet
```

Second `index` / summary at the same `HEAD` is a cache hit. After you commit in a repo, only that repo reindexes.

### MCP (Cursor / VS Code)

```json
{
  "mcpServers": {
    "mirevox-context": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "/absolute/path/to/context-engine/dist/cli.js",
        "--data-dir",
        "/absolute/path/to/shared-cache",
        "serve-mcp"
      ]
    }
  }
}
```

Tools: `list_repos`, `get_repo_summary`, `search_context`, `get_file_context`, `cache_stats`, `reindex_repo`.

### HTTP (shared on one machine)

```bash
node --experimental-sqlite dist/cli.js --data-dir "$DATA" serve-http -p 7437
curl -s http://127.0.0.1:7437/health
curl -s 'http://127.0.0.1:7437/search?q=greet'
```

Optional: set `CONTEXT_ENGINE_TOKEN` and send `Authorization: Bearer …`.

## How caching works

- Cache key: `(repoId, commitSha, path)` in SQLite (`~/.mirevox/context-engine/cache.sqlite` by default, or `--data-dir`).
- If HEAD matches the indexed commit → **cache hit**.
- If HEAD moved → miss, reindex that repo only.
- Summaries are **extractive** (paths, symbols, keywords, previews). No LLM required for v1.

## Compose with other Mirevox modules

- **smart-router** — call this MCP as a tool backend for context assembly.
- **stage-gate / shadow-versioning** — pull repo overviews without re-ingesting trees.

## Docs

- [Problem & opportunity](docs/problem-opportunity.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Market gap](docs/market-gap.md)
- [Devil’s advocate](docs/devils-advocate.md)
- [Acceptance](docs/acceptance.md)

## License

Apache-2.0
