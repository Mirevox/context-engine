# Verification & Smoke Screen Report — `context-engine` (`v0.2.0`)

| Field | Value |
| --- | --- |
| **Module** | `Mirevox/context-engine` (`@mirevox/context-engine`) |
| **Package Version** | `0.2.0` |
| **Verification Status** | **VERIFIED** |
| **Verified At (UTC)** | `2026-11-24T01:55:22Z` |
| **Environment** | Node `v22.14.0` (built-in `node:sqlite`), Vitest `5.1.1`, Docker `linux/amd64` (`sherali` Docker Engine `29.8.1`) |

## Automated Typecheck, Build & Test Suite

- `tsc --noEmit`, `tsc -p tsconfig.build.json`, and `node scripts/postbuild.mjs`: **PASS** (exit `0`)
- `vitest run --configLoader runner`: **PASS (5/5 test files, 33/33 tests passed, 0 failed)**
  - `tests/v2-appcode-and-worker.test.ts` (`9` tests): canonical remote URL repo ID sharing across separate clones, `oldId -> id` migration, v0.1 -> v0.2 transactional SQLite WAL migration, `ingestAppcodeDocuments` (including secret-path rejection), `getAppcodeContextPack` token-savings math, `BackgroundIndexer.tick()`, HTTP `/appcodes/*` + `/worker/*` routes, and 11-tool MCP server checks.
  - `tests/cache.test.ts` (`6`), `tests/search.test.ts` (`9`), `tests/invalidation.test.ts` (`6`), `tests/interfaces.test.ts` (`3`).

## Multi-Repo MCP & Live v0.2 Cross-Module E2E Checks

- **MCP Multi-Repo Query:** Registered 3 Mirevox repositories (`smart-router`, `data-lineage`, `evals`) via `InMemoryTransport` -> `15` ranked cross-repo hits across all 3.
- **v0.2 Canonical Team Cache, Worker & `appcode` Context Pack (`appcode-v2-enterprise-1`):**
  - Two distinct team clones (`https://` and `git@` remotes) resolved to shared `canonicalRepoId=43c06f7d431a`; `POST /worker/tick` indexed `1` repo offline; second clone got `cacheHit=true` (`cloneBHit=true`).
  - Received `5` cross-source artifacts (`confluence`, `sharepoint`, `jira`, `git`, `testing`) from `shadow-versioning`; `GET /appcodes/appcode-v2-enterprise-1/context-pack?budget_tokens=600` packed into `usedTokens=509` with `tokensSaved=573`.

## Container & Hygiene Verification

- Standalone Linux/x64 Docker image rebuilt cleanly: `mirevox/context-engine:x64-verify 518461a80a5d 496MB`
- Workspace hygiene & security scan: `repos=9, all_docs_license_compose=True, hardcoded_paths=0, secret_hits=0, src_todo_hits=0`

## Reproduce Locally

```bash
npm run typecheck && npm run build && npm test
```
