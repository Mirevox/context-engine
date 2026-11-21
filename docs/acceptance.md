# Acceptance checklist (v1)

Evidence from a Grok acceptance run on 2026-11-20, Node v22.23.4, branch `cursor/context-engine-v1-1d3e`.

| Check | FR/NFR | Result |
| --- | --- | --- |
| `npm run build` succeeds on Node 22 | NFR-01 | PASS |
| `npm test` — 23 tests (cache, invalidation, search, secrets, MCP, HTTP) | FR-03/04/06/09/10/12 | PASS |
| Register two fixture repos (`sample-alpha`, `sample-beta`) | FR-01 | PASS |
| Second `index` at the same HEAD → `reason: "fresh"` and a hit | FR-02, FR-04 | PASS |
| Commit on one repo reindexes only that repo | FR-04 | PASS |
| Search finds `greet` (alpha) and `add` (beta) | FR-06 | PASS |
| MCP tools include summary, search, stats, and `register_repo` | FR-09 | PASS |
| `serve-http` `/health` and `/stats` respond on loopback | FR-08, FR-10 | PASS |
| CLI `register\|index\|status\|query\|serve-*` with `-d` / `--json` | FR-11 | PASS |
| Secret-shaped filenames skipped; `0.0.0.0` without a token exits 1 | FR-12 | PASS |
| LICENSE Apache-2.0 present | NFR-07 | PASS |
| Offline local git only; no homelab stack | NFR-02 | PASS |

## What was run

- `npm run build` and `npm test` (23 passed).
- CLI against git-initialized `fixtures/sample-alpha` and `fixtures/sample-beta` with a private `--data-dir`: register, `index` twice (`reason: "fresh"` both times), `status` (both fresh, hits persisted), `query greet`, `query add`.
- A second pair of temp repos: after a commit in alpha only, `index` reported `head-changed` (1 summarized, 1 reused) for alpha and `fresh` for beta. Beta `lastIndexedAt` did not move. `invalidations` 0→1, `reindexes` 2→3. `query changedMarker` hit the new alpha SHA.
- `serve-http` on `127.0.0.1:7437`: `/health` → `{ok:true,name:"mirevox-context-engine"}`, `/stats` → cache counters and `dbPath`, `/search?q=greet` → `src/greet.ts`.
- `serve-http --host 0.0.0.0` with no `CONTEXT_ENGINE_TOKEN` exited 1: `Refusing to bind 0.0.0.0 without CONTEXT_ENGINE_TOKEN`.
- Bad register path exited 1 with `error: Not a directory`.
- Cold index of the two-file fixtures was 16–17 ms.

## Bugs fixed during this run

- Re-registering a repo with another repo's display name succeeded and left two rows named `alpha`. `resolve("alpha")` returned whichever row SQLite handed back. Explicit renames now use the same uniqueness check as inserts. If a cache already contains duplicate names, resolve throws instead of picking one.
- `query --limit foo` returned `[]` and exit 0, which looks like a real miss. Non-finite limits now error (CLI exit 1, HTTP 400).

## Known gaps

- Dirty worktree is invisible. An uncommitted `dirtyOnlyMarker` in `greet.ts` was not searchable, and `status` still said `fresh`, because the cache is keyed on `HEAD` only.
- Secret filtering covers basenames plus `.ssh`/`secret(s)`/`credential(s)` path segments; it still does not scan contents, and names like `.npmrc` / `kubeconfig` outside those dirs can be indexed.
- No embeddings, no per-repo ACL, no multi-tenant auth beyond the optional HTTP bearer.
- Repo identity is `SHA-1(realpath)` — separate clones do not share cache rows.
- MCP stdio is not the Compose service; Compose stands up HTTP only (share `/data` volume for MCP on the host).
- Multi-process SQLite concurrency is not stress-tested in CI; some write paths omit a combined `BEGIN IMMEDIATE`.

## Docker standup (validation wave)

- `cp .env.example .env && docker compose up --build -d` → container **healthy**; `GET /health` returns `{ok, db:"ok"}`.
- With `REPOS_HOST_PATH=./fixtures` after `npm run fixture:init`, `POST /repos` for `/repos/sample-repo` indexes 6 files; `GET /search?q=invoice` returns `src/billing.ts`.
