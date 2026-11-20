# Acceptance checklist (v1)

Locked against `docs/requirements.md`. Evidence from cloud VM run 2026-11-20.

| Check | FR/NFR | Result |
| --- | --- | --- |
| `npm run build` succeeds on Node 22 | NFR-01 | PASS |
| `npm test` — 20 tests (cache, invalidation, search, MCP, HTTP) | FR-03/04/06/09/10 | PASS |
| Register multiple local git repos | FR-01 | PASS |
| Shared `--data-dir` / SQLite reuse; same HEAD → cache hit | FR-02, FR-04 | PASS |
| Commit change → invalidation + reindex that repo | FR-04 | PASS |
| Search finds symbols across repos | FR-06 | PASS |
| MCP tools: list/register/summary/search/file/stats/reindex | FR-09 | PASS |
| HTTP `/health`, `/repos`, `/search`, `/stats` (+ optional bearer) | FR-10 | PASS |
| CLI `register|index|status|query|serve-*` with `-d/--data-dir` | FR-11 | PASS |
| Secret-shaped paths skipped (`isSecretPath`) | FR-12 (partial) | PASS |
| LICENSE Apache-2.0 + docs/ + README | NFR-07 | PASS |
| No homelab / cloud dependency for core | NFR (delivery) | PASS |

## Known gaps (honest)

- No remote multi-tenant auth beyond optional HTTP bearer
- Extractive summaries only (no embeddings)
- Org GitHub publish `Mirevox/context-engine` blocked until App can `createRepository`
- Non-loopback HTTP without token: still caller responsibility to bind carefully (default `127.0.0.1`)
