# Devil’s advocate — Context Engine

## Attack the value prop

Shared cache only wins when:

- Multiple agents/people hit the **same checkouts** and the **same commits** often enough that index cost > cache lookup  
- Summaries are good enough that agents stop dumping whole files into prompts  

It does **not** win when:

- Every developer works on unique branches that churn every minute (constant invalidation)  
- Agents need deep semantic retrieval that extractive text cannot provide  
- The “shared” data dir is never actually shared (each process uses a private path)

## Failure modes

| Failure | Why it hurts |
| --- | --- |
| Stale summaries | Bug if HEAD check is skipped or worktree dirty state ignored |
| Secret leakage | Indexing `.env` / credentials into SQLite shared on disk |
| Huge monorepos | Caps help, but naive walks still waste time |
| MCP auth | stdio is local-trust; HTTP without token is a footgun on shared hosts |
| False “token savings” | If agents still fetch full file contents every turn, cache is theater |

## Ruthless v1 bar (must pass)

1. Register ≥2 local git repos  
2. Index once; second index at same HEAD reports fresh/hit  
3. After a commit, that repo reindexes; other repos untouched  
4. `search` finds a known symbol across repos  
5. MCP tool list includes summary/search/stats  
6. `npm test` green on Node 22  
7. No cloud credentials required  

## Theater to cut

- Fancy web UI  
- Vector DB / embedding providers in v1  
- Multi-tenant SaaS  
- “AI-written” repo novels that differ per run  

## Defer

Cloud sync, ACL per repo, automatic secret scanning product, Docker home-lab stack, cross-machine cache federation.
