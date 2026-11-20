# Mirevox Context Engine

**License: [Apache-2.0](./LICENSE)**

Shared multi-repo context for agent harnesses. Register local git repos once, index them at their `HEAD` commit, and cache **extractive** summaries (no LLM) in SQLite keyed by `(repoId, commitSha, path)`. Every client using the **same host, checkouts, and data directory** — Cursor, CLI, scripts, other local agents — reads the same cache over **MCP (stdio)**, a small **HTTP JSON** API, or the **CLI**, so nobody re-burns tokens on the same corpus.

Part of the [Mirevox](https://github.com/Mirevox) open-source modules.

## Problem

Coding agents working across several local Git checkouts repeatedly spend tool calls opening the same READMEs, manifests, directory trees, and entry files just to orient themselves. Existing products already solve much of this with semantic search, code graphs, and hosted organization-wide indexes; `context-engine` is **not** intended to replace them.

The narrower gap is a small, model-free orientation cache that different local tools can reuse. It indexes tracked files at each checkout’s committed `HEAD`, stores compact deterministic extracts in a shared SQLite data directory, reuses unchanged blobs across commits, and serves the same records through MCP, HTTP, and CLI — without an embedding model, API key, or external service. Docker Compose stands up the HTTP path in one command.

Search covers paths, extracted symbols, keywords, and short summaries. It does **not** provide semantic retrieval, call/dependency graphs, cross-repository relationships, dirty-working-tree indexing, reuse across separate clones, or team authorization. Use it as a cheap orientation and prefilter layer before agents open authoritative source files. Clients must share the **same host, checkouts, and data directory**.

## Requirements

- Node.js >= 22.13 (built-in `node:sqlite`; on 22.5–22.12 prefix commands with `node --experimental-sqlite`)
- `git` on `PATH`
- For Docker: Docker Engine + Compose v2

## One-command Docker standup

```bash
cp .env.example .env
# edit CONTEXT_ENGINE_TOKEN (required) — e.g. openssl rand -hex 32
# optional: set REPOS_HOST_PATH to a folder of local git clones

docker compose up --build -d
curl -s http://127.0.0.1:7437/health
# {"ok":true,"name":"mirevox-context-engine","db":"ok",...}

# Register a mounted repo (fixtures are mounted at /repos by default):
TOKEN=$(grep ^CONTEXT_ENGINE_TOKEN= .env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/repos/sample-repo","name":"sample"}' http://127.0.0.1:7437/repos
```

Compose publishes HTTP on `${CONTEXT_ENGINE_PUBLISH_PORT:-7437}`, stores the SQLite cache in the `context-data` volume (`MIREVOX_CONTEXT_DIR=/data`), mounts `${REPOS_HOST_PATH:-./fixtures}` read-only at `/repos`, runs as a non-root user, drops capabilities, and healthchecks `GET /health` (DB ping). Binding is `0.0.0.0` inside the container; **`CONTEXT_ENGINE_TOKEN` is mandatory** (fail-closed).

Stop: `docker compose down` (add `-v` to wipe the cache volume).

### Docker gaps (honest)

- **MCP stdio is not the compose service.** MCP remains a host/`docker run -i` process sharing the same `/data` volume; compose ships the HTTP API.
- **Repos must be mounted.** The engine indexes local git trees; without `REPOS_HOST_PATH` (or extra volumes) there is nothing to register.
- **Fixture mount needs git metadata.** `fixtures/*` in this repo are not live git checkouts until you run `npm run fixture:init` (or mount real clones).
- **Git `safe.directory`:** the image allows any directory for the non-root user so host-UID mounts under `/repos` work; only mount trees you trust.
- **No multi-tenant ACLs.** Trust boundary is whoever can reach the published port with the bearer token.
- **Dirty worktrees are invisible** — cache keys are `HEAD` commits only.
- **Secret denylist is basename-oriented** (e.g. `.env`, `*.key`); nested paths like `secrets/notes.txt` are not blocked by name alone.

## Quick start (local Node)

```bash
npm install
npm run build
npm test

npm run fixture:init                    # turns fixtures/sample-repo into a real git repo (1 commit)
DATA=./.mirevox-context

node dist/cli.js -d "$DATA" register fixtures/sample-repo -n sample
node dist/cli.js -d "$DATA" status
node dist/cli.js -d "$DATA" query "invoice tax"
node dist/cli.js -d "$DATA" --json query authenticate
```

Make a commit in the repo and run `status` again: it shows `STALE` until the next query or `index`, which reindexes only that repo (unchanged files are reused by blob SHA).

Data directory precedence: `-d/--data-dir`, `$MIREVOX_CONTEXT_DIR`, `~/.mirevox/context-engine`, then `./.mirevox-context` if home is not writable. The database is `cache.sqlite` (WAL mode, safe for several processes at once).

## CLI

| Command | What it does |
| --- | --- |
| `register <path> [-n name] [--no-index]` | Register a git repo (id = sha1 of its real path) and index it |
| `unregister <repo>` | Remove the repo and all its cached rows (`<repo>` = id, name or path) |
| `index [repo] [-f]` | Index one/all repos; no-op if HEAD is unchanged, `-f` recomputes |
| `status` | Repos, indexed vs HEAD commit, stale flag, cache counters |
| `query <text> [-r repo] [-l n]` | Keyword search over summaries, symbols and paths |
| `serve-mcp` | MCP server on stdio |
| `serve-http [-p 7437] [--host 127.0.0.1]` | JSON HTTP API (`$CONTEXT_ENGINE_PORT` / `$CONTEXT_ENGINE_HOST` also honored) |

Global options: `-d, --data-dir <dir>`, `--json`.

## MCP

```json
{
  "mcpServers": {
    "mirevox-context": {
      "command": "node",
      "args": ["/absolute/path/to/context-engine/dist/cli.js", "-d", "/absolute/path/to/shared-cache", "serve-mcp"]
    }
  }
}
```

Tools: `list_repos`, `register_repo`, `get_repo_summary`, `search_context`, `get_file_context`, `cache_stats`, `reindex_repo`. All query tools check `HEAD` first and reindex automatically if it moved.

## HTTP

```bash
node dist/cli.js -d "$DATA" serve-http -p 7437
curl -s http://127.0.0.1:7437/health
curl -s 'http://127.0.0.1:7437/search?q=invoice'
curl -s http://127.0.0.1:7437/stats
```

Routes: `GET /health` (DB ping; unauthenticated), `GET|POST /repos`, `DELETE /repos/:ref`, `GET /repos/:ref/summary`, `POST /repos/:ref/reindex`, `GET /search?q=&repo=&limit=`, `GET /file?repo=&path=&content=1&max_chars=`, `GET /stats`.

Binds `127.0.0.1` by default. Set `CONTEXT_ENGINE_TOKEN` to require `Authorization: Bearer <token>` (everything except `/health`). Binding to a non-loopback host without a token is refused.

## How caching works

- Cache key: `(repoId, commitSha, path)`. If `HEAD` equals the indexed commit it is a **hit** and git is not walked.
- If `HEAD` moved it is a **miss** (counted as an invalidation) and that repo is reindexed. Files whose git blob is unchanged since an earlier commit are copied, not re-summarized.
- `cache_stats` / `status` report persisted counters (`fileHits`, `fileMisses`, `repoHits`, `repoMisses`, `invalidations`, `reindexes`, `hitRate`) plus per-process `session` counters.
- Summaries are deterministic and extractive: language, line count, leading doc comment, top-level symbols, keywords. Max 420 chars per file.
- Skipped: `node_modules`, `dist`, lockfiles, binaries, files over 200 KB, and secret-shaped names (`.env*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `id_rsa*`).
- Only the newest 3 indexed commits per repo are kept.

## Library

`import { ContextEngine } from "@mirevox/context-engine"` gives the same engine the CLI, MCP and HTTP layers use.

## Docs

`docs/` holds the problem statement, requirements, architecture, market gap, and devil's advocate notes.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). See `LICENSE` for the full text.
