# Acceptance checklist (v1)

| Check | FR/NFR | Result |
| --- | --- | --- |
| `npm run build` succeeds | NFR-01 | PASS |
| `npm test` passes (20 tests: cache, invalidation, search, MCP, HTTP) | FR-03, NFR-01 | PASS |
| Register two fixture/local repos | FR-01 | PASS |
| Index then re-index same HEAD → fresh/hit | FR-03, FR-09 | PASS |
| Search finds known symbol (`greet` / `authenticate`) | FR-05 | PASS |
| `serve-http` `/health` and `/stats` respond | FR-08, FR-09 | PASS |
| MCP tools documented in README | FR-07, NFR-06 | PASS |
| LICENSE Apache-2.0 present | NFR-03 | PASS |
| Works offline with local git only | NFR-02 | PASS |
| No homelab stack required | NFR-05 | PASS |

Vetted against `docs/requirements.md` on 2026-11-20 (cloud VM). Org GitHub push pending App create permission.
