import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUMMARIZER_VERSION } from "../src/cache.js";
import { ContextEngine } from "../src/engine.js";
import { createHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { normalizeRemoteUrl, repoIdForPath, repoIdForRemote } from "../src/registry.js";
import { SUMMARY_MAX_CHARS, summarizeDocument } from "../src/summarizer.js";
import { BackgroundIndexer } from "../src/worker.js";
import { cleanup, commitAll, git, makeRepo, makeTmp, writeFiles } from "./helpers.js";

let root: string;
let engine: ContextEngine;

beforeEach(() => {
  root = makeTmp();
  engine = new ContextEngine({ dataDir: `${root}/data` });
});

afterEach(() => {
  engine.close();
  cleanup(root);
});

function parseMcp(res: unknown): any {
  const r = res as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe("canonical remote identity & clone cache sharing", () => {
  it("normalizes SCP SSH and HTTPS remotes and rejects local file:// or bare paths", () => {
    expect(normalizeRemoteUrl("git@github.com:Mirevox/Context-Engine.git")).toBe("github.com/mirevox/context-engine");
    expect(normalizeRemoteUrl("https://github.com/mirevox/context-engine.git")).toBe(
      "github.com/mirevox/context-engine",
    );
    expect(normalizeRemoteUrl("https://token@github.com/Mirevox/Context-Engine/")).toBe(
      "github.com/mirevox/context-engine",
    );
    expect(normalizeRemoteUrl("ssh://git@gitlab.com:2222/team/sub/service.git")).toBe(
      "gitlab.com/team/sub/service",
    );
    expect(normalizeRemoteUrl("file:///tmp/bare.git")).toBeNull();
    expect(normalizeRemoteUrl("/tmp/bare.git")).toBeNull();
    expect(normalizeRemoteUrl("./local/repo")).toBeNull();
    expect(normalizeRemoteUrl("C:\\Users\\dev\\repo")).toBeNull();
    expect(normalizeRemoteUrl("https://github.com/only-owner")).toBeNull();
    expect(normalizeRemoteUrl("")).toBeNull();
  });

  it("shares one canonical repoId and SQLite cache across two separate git clones", () => {
    const seed = makeRepo(root, "seed", {
      "src/auth.ts": "/** Handles OAuth login. */\nexport function authenticateUser(id: string) { return id; }\n",
      "README.md": "# Team Service\n\nShared authentication service.\n",
    });
    const clone1 = join(root, "clone-a");
    const clone2 = join(root, "clone-b");
    git(root, "clone", "-q", seed, clone1);
    git(root, "clone", "-q", seed, clone2);
    git(clone1, "remote", "set-url", "origin", "git@github.com:mirevox/team-service.git");
    git(clone2, "remote", "set-url", "origin", "https://github.com/Mirevox/team-service.git");

    const expectedId = repoIdForRemote("github.com/mirevox/team-service");
    const r1 = engine.registerRepo(clone1, { name: "team-service" });
    expect(r1.repo.id).toBe(expectedId);
    expect(r1.repo.remoteUrl).toBe("github.com/mirevox/team-service");
    expect(r1.indexed?.filesIndexed).toBe(2);

    const hitsBefore = engine.stats().repoHits;
    const r2 = engine.registerRepo(clone2);
    expect(r2.repo.id).toBe(expectedId);
    expect(r2.repo.path).toBe(realpathSync(clone2));
    expect(r2.repo.remoteUrl).toBe("github.com/mirevox/team-service");
    expect(r2.indexed).toBeUndefined();
    expect(engine.stats().repoHits).toBe(hitsBefore + 1);

    // Resolvable by HTTPS or SSH remote URL
    expect(engine.registry.resolve("https://github.com/mirevox/team-service.git").id).toBe(expectedId);
    expect(engine.registry.resolve("git@github.com:mirevox/team-service.git").id).toBe(expectedId);
    expect(engine.fileContext(expectedId, "src/auth.ts").cacheHit).toBe(true);
  });

  it("migrates oldId -> canonical remote ID safely when a remote is added later", () => {
    const dir = makeRepo(root, "local-first", {
      "index.ts": "/** Entry module. */\nexport const version = 2;\n",
    });
    const oldId = repoIdForPath(realpathSync(dir));
    const first = engine.registerRepo(dir, { name: "local-first" });
    expect(first.repo.id).toBe(oldId);
    expect(first.repo.remoteUrl).toBeNull();
    const sha = first.repo.lastIndexedCommit!;

    git(dir, "remote", "add", "origin", "git@github.com:mirevox/migrated.git");
    const newId = repoIdForRemote("github.com/mirevox/migrated");
    const migrated = engine.registerRepo(dir);
    expect(migrated.repo.id).toBe(newId);
    expect(migrated.repo.remoteUrl).toBe("github.com/mirevox/migrated");
    expect(migrated.repo.lastIndexedCommit).toBe(sha);
    expect(migrated.indexed).toBeUndefined();

    const oldFiles = (engine.db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(oldId) as { n: number })
      .n;
    const newFiles = (engine.db.prepare("SELECT COUNT(*) AS n FROM files WHERE repo_id = ?").get(newId) as { n: number })
      .n;
    expect(oldFiles).toBe(0);
    expect(newFiles).toBe(1);
    expect(engine.repoSummary(newId).cacheHit).toBe(true);
  });
});

describe("SQLite v0.1 -> v0.2 migration", () => {
  it("migrates a simulated v0.1 DB lacking remote_url and appcode_documents idempotently", () => {
    const v1Dir = join(root, "v1-data");
    mkdirSync(v1Dir, { recursive: true });
    const repoDir = makeRepo(root, "legacy-repo", {
      "app.ts": "export function legacy() { return 1; }\n",
    });
    const real = realpathSync(repoDir);
    const id = repoIdForPath(real);
    const sha = git(real, "rev-parse", "HEAD");
    const now = new Date().toISOString();

    const rawDb = new DatabaseSync(join(v1Dir, "cache.sqlite"));
    rawDb.exec(`
      CREATE TABLE repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL,
        last_indexed_commit TEXT,
        last_indexed_at TEXT,
        file_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE files (
        repo_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        summary TEXT NOT NULL,
        symbols TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '',
        blob_sha TEXT NOT NULL,
        summarizer_version INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, commit_sha, path)
      );
      CREATE TABLE repo_summaries (
        repo_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        overview TEXT NOT NULL,
        languages TEXT NOT NULL,
        top_paths TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        summarizer_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, commit_sha)
      );
      CREATE TABLE counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
    `);
    rawDb
      .prepare(
        "INSERT INTO repos (id, name, path, registered_at, last_indexed_commit, last_indexed_at, file_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, "legacy-repo", real, now, sha, now, 1);
    rawDb
      .prepare(
        "INSERT INTO files (repo_id, commit_sha, path, language, byte_size, summary, symbols, keywords, blob_sha, summarizer_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sha, "app.ts", "typescript", 40, "typescript, 1 lines. Defines: legacy.", '["legacy"]', "legacy", "blob1", SUMMARIZER_VERSION, now);
    rawDb
      .prepare(
        "INSERT INTO repo_summaries (repo_id, commit_sha, overview, languages, top_paths, file_count, summarizer_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sha, "legacy-repo: 1 indexed files.", '{"typescript":1}', '["app.ts"]', 1, SUMMARIZER_VERSION, now);
    rawDb.close();

    const migrated = new ContextEngine({ dataDir: v1Dir });
    try {
      const cols = migrated.db.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
      expect(cols.some((c) => c.name === "remote_url")).toBe(true);
      const tables = (
        migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name);
      expect(tables).toContain("appcode_documents");
      const fk = migrated.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
      const summary = migrated.repoSummary(id);
      expect(summary.cacheHit).toBe(true);
      expect(summary.repo.remoteUrl).toBeNull();
    } finally {
      migrated.close();
    }

    // Second open must remain idempotent
    const reopened = new ContextEngine({ dataDir: v1Dir });
    try {
      expect(reopened.listRepos()[0]?.id).toBe(id);
    } finally {
      reopened.close();
    }
  });
});

describe("appcode ingestion, context packs, and token savings", () => {
  it("summarizes non-Git docs without generic code prefixes and enforces secret paths", () => {
    const docSum = summarizeDocument(
      "OAuth2 Login Flow",
      "# OAuth2 Login Flow\n\nImplements PKCE authorization for PROJ-104 and refreshes short-lived JWT tokens.",
      "confluence",
    );
    expect(docSum.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(docSum.summary).not.toMatch(/\blines\./);
    expect(docSum.symbols).toContain("OAuth2 Login Flow");
    expect(docSum.symbols).toContain("PROJ-104");

    expect(() =>
      engine.ingestAppcodeDocuments("app-sec", [
        { source: "git", docId: ".env.production", title: "Prod Env", content: "API_KEY=secret" },
      ]),
    ).toThrow(/secret/i);

    expect(() =>
      engine.ingestAppcodeDocuments("app-sec", [
        {
          source: "sharepoint",
          docId: "doc-1",
          uri: "credentials/aws-keys.json",
          title: "Keys",
          content: "AKIA...",
        },
      ]),
    ).toThrow(/secret/i);

    expect(engine.listAppcodeDocuments("app-sec")).toEqual([]);
  });

  it("deduplicates by sha256 content_hash and enforces budgetTokens with persisted savings", () => {
    const longSpec = (topic: string) =>
      `# ${topic}\n\n` +
      `Detailed architectural specification covering ${topic}, latency budgets, retries, schema migration, observability, and audit logging. `.repeat(
        18,
      );

    const r1 = engine.ingestAppcodeDocuments("appcode-demo-0", [
      {
        source: "confluence",
        docId: "disc-1",
        stage: "discovery",
        title: "Payment Gateway Discovery",
        content: longSpec("payment gateway idempotency"),
        priority: 10,
      },
      {
        source: "sharepoint",
        docId: "fr-1",
        stage: "requirements",
        title: "FR-01 Billing Ledger",
        content: longSpec("billing ledger double entry"),
        priority: 5,
      },
      {
        source: "jira",
        docId: "EPIC-42",
        stage: "requirements",
        title: "EPIC-42 Invoice Approval",
        content: longSpec("invoice approval workflow"),
        priority: 2,
      },
    ]);
    expect(r1.ingested).toBe(3);
    expect(r1.deduplicated).toBe(0);
    expect(r1.documents[0]!.contentHash).toBe(
      createHash("sha256").update(longSpec("payment gateway idempotency")).digest("hex"),
    );

    // Re-ingesting identical content under same or different docId deduplicates by sha256 hash
    const r2 = engine.ingestAppcodeDocuments("appcode-demo-0", [
      {
        source: "confluence",
        docId: "disc-1",
        stage: "discovery",
        title: "Payment Gateway Discovery",
        content: longSpec("payment gateway idempotency"),
        priority: 10,
      },
      {
        source: "sharepoint",
        docId: "fr-1-mirror",
        stage: "requirements",
        title: "Mirror",
        content: longSpec("billing ledger double entry"),
      },
    ]);
    expect(r2.ingested).toBe(0);
    expect(r2.deduplicated).toBe(2);
    expect(engine.listAppcodeDocuments("appcode-demo-0").length).toBe(3);
    expect(engine.listAppcodeDocuments("appcode-demo-0", { stage: "requirements" }).length).toBe(2);

    // Budget tightly allows ~1 doc (each summary is ~420 chars = ~105 tokens)
    const pack = engine.getAppcodeContextPack("appcode-demo-0", {
      budgetTokens: 120,
    });
    expect(pack.usedTokens).toBeLessThanOrEqual(120);
    expect(pack.items.length).toBe(1);
    expect(pack.items[0]!.docId).toBe("disc-1");
    expect(pack.omittedCount).toBe(2);
    expect(pack.rawBytesTotal).toBeGreaterThan(pack.summaryBytesServed);
    expect(pack.rawBytesAvoided).toBe(pack.rawBytesTotal - pack.summaryBytesServed);
    expect(pack.tokensSaved).toBeGreaterThan(0);

    const stats = engine.stats();
    expect(stats.contextPacksServed).toBe(1);
    expect(stats.rawBytesAvoided).toBe(pack.rawBytesAvoided);
    expect(stats.summaryBytesServed).toBe(pack.summaryBytesServed);
    expect(stats.tokensSaved).toBe(pack.tokensSaved);

    // Query filtering picks matching item
    const qPack = engine.getAppcodeContextPack("appcode-demo-0", {
      budgetTokens: 500,
      query: "invoice approval",
    });
    expect(qPack.items.map((i) => i.docId)).toEqual(["EPIC-42"]);

    // Repo summary & fileContext(!includeContent) also accumulate savings; includeContent does not
    const repoDir = makeRepo(root, "savings-repo", {
      "src/big.ts": "/** Big helper module. */\n" + "export const item = 'value';\n".repeat(40),
    });
    const { repo } = engine.registerRepo(repoDir);
    const beforeRepo = engine.stats();
    engine.repoSummary(repo.id);
    const afterSummary = engine.stats();
    expect(afterSummary.rawBytesAvoided).toBeGreaterThan(beforeRepo.rawBytesAvoided);
    expect(afterSummary.tokensSaved).toBeGreaterThan(beforeRepo.tokensSaved);

    engine.fileContext(repo.id, "src/big.ts", { includeContent: false });
    const afterFileMeta = engine.stats();
    expect(afterFileMeta.rawBytesAvoided).toBeGreaterThan(afterSummary.rawBytesAvoided);

    engine.fileContext(repo.id, "src/big.ts", { includeContent: true });
    const afterFileContent = engine.stats();
    expect(afterFileContent.rawBytesAvoided).toBe(afterFileMeta.rawBytesAvoided);

    // Reopen Engine to verify persistence of new counters
    engine.close();
    engine = new ContextEngine({ dataDir: `${root}/data` });
    const persisted = engine.stats();
    expect(persisted.contextPacksServed).toBe(2);
    expect(persisted.rawBytesAvoided).toBe(afterFileContent.rawBytesAvoided);
    expect(persisted.tokensSaved).toBe(afterFileContent.tokensSaved);
    expect(persisted.session.tokensSaved).toBe(0);
  });
});

describe("BackgroundIndexer", () => {
  it("ticks stale repos, isolates errors, guards against overlap, and manages timer lifecycle", async () => {
    const repoA = makeRepo(root, "worker-a", { "a.ts": "export const a = 1;\n" });
    const repoB = makeRepo(root, "worker-b", { "b.ts": "export const b = 1;\n" });
    const regA = engine.registerRepo(repoA).repo;
    const regB = engine.registerRepo(repoB).repo;

    writeFiles(repoA, { "a.ts": "export const a = 2;\n" });
    const newSha = commitAll(repoA, "update a");

    // Break repoB on disk to test per-repo error isolation
    rmSync(repoB, { recursive: true, force: true });

    const worker = new BackgroundIndexer(engine);
    const tickRes = await worker.tick();
    expect(tickRes.skippedOverlap).toBe(false);
    expect(tickRes.processed).toBe(2);
    expect(tickRes.indexed).toBe(1);
    expect(tickRes.errors).toBe(1);
    expect(tickRes.results.find((r) => r.repoId === regA.id)?.commitSha).toBe(newSha);
    expect(tickRes.results.find((r) => r.repoId === regB.id)?.status).toBe("error");

    // Concurrent tick hits overlap guard
    const [p1, p2] = await Promise.all([worker.tick(), worker.tick()]);
    expect(p1.skippedOverlap).toBe(false);
    expect(p2.skippedOverlap).toBe(true);

    worker.start(60_000);
    expect(worker.status().enabled).toBe(true);
    expect(worker.status().intervalMs).toBe(60_000);
    expect(worker.status().tickCount).toBe(2);
    worker.stop();
    expect(worker.status().enabled).toBe(false);
    expect(worker.status().intervalMs).toBeNull();
  });
});

describe("v0.2 HTTP and MCP endpoints", () => {
  it("serves appcode & worker HTTP routes", async () => {
    const repoDir = makeRepo(root, "http-repo", { "main.ts": "export const x = 1;\n" });
    engine.registerRepo(repoDir, { name: "http-repo" });
    writeFiles(repoDir, { "main.ts": "export const x = 2;\n" });
    commitAll(repoDir);

    const worker = new BackgroundIndexer(engine);
    const server = createHttpServer(engine, { token: "tok", worker });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: "Bearer tok", "content-type": "application/json" };

    try {
      const health = (await (await fetch(`${base}/health`)).json()) as { version: string };
      expect(health.version).toBe("0.2.0");

      const secretRes = await fetch(`${base}/appcodes/app-http/ingest`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          docs: [{ source: "git", docId: ".env", title: "env", content: "SECRET=1" }],
        }),
      });
      expect(secretRes.status).toBe(403);

      const ingestRes = await fetch(`${base}/appcodes/app-http/ingest`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          docs: [
            {
              source: "confluence",
              docId: "c-1",
              stage: "spec",
              title: "Architecture Spec",
              content: "Service architecture and SQLite WAL concurrency specification. ".repeat(10),
            },
          ],
        }),
      });
      expect(ingestRes.status).toBe(200);
      const ingestJson = (await ingestRes.json()) as { ingested: number };
      expect(ingestJson.ingested).toBe(1);

      const docs = (await (
        await fetch(`${base}/appcodes/app-http/documents?stage=spec&source=confluence&limit=10`, { headers: auth })
      ).json()) as { docId: string }[];
      expect(docs.map((d) => d.docId)).toEqual(["c-1"]);

      const pack = (await (
        await fetch(`${base}/appcodes/app-http/context-pack?budget_tokens=400&stage=spec&sources=confluence&query=sqlite`, {
          headers: auth,
        })
      ).json()) as { items: { docId: string }[]; tokensSaved: number };
      expect(pack.items.length).toBe(1);
      expect(pack.tokensSaved).toBeGreaterThan(0);

      const tick = (await (
        await fetch(`${base}/worker/tick`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ repo: "http-repo" }),
        })
      ).json()) as { indexed: number };
      expect(tick.indexed).toBe(1);

      const status = (await (await fetch(`${base}/worker/status`, { headers: auth })).json()) as { tickCount: number };
      expect(status.tickCount).toBe(1);
    } finally {
      worker.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("exposes new appcode and background worker MCP tools", async () => {
    const repoDir = makeRepo(root, "mcp-repo", { "a.ts": "export const a = 1;\n" });
    engine.registerRepo(repoDir, { name: "mcp-repo" });
    writeFiles(repoDir, { "a.ts": "export const a = 2;\n" });
    commitAll(repoDir);

    const server = createMcpServer(engine);
    const client = new Client({ name: "v2-test", version: "0.2.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const ingested = parseMcp(
      await client.callTool({
        name: "ingest_appcode_documents",
        arguments: {
          appcode: "app-mcp",
          docs: [
            {
              source: "jira",
              docId: "APP-12",
              stage: "requirements",
              title: "APP-12 Rate Limit",
              content: "Gateway must enforce token bucket rate limits per tenant. ".repeat(8),
            },
          ],
        },
      }),
    );
    expect(ingested.ingested).toBe(1);

    const listed = parseMcp(
      await client.callTool({
        name: "list_appcode_documents",
        arguments: { appcode: "app-mcp", source: "jira" },
      }),
    );
    expect(listed).toHaveLength(1);

    const pack = parseMcp(
      await client.callTool({
        name: "get_appcode_context_pack",
        arguments: { appcode: "app-mcp", budget_tokens: 300, sources: ["jira"] },
      }),
    );
    expect(pack.items[0].docId).toBe("APP-12");
    expect(pack.tokensSaved).toBeGreaterThan(0);

    const tick = parseMcp(
      await client.callTool({
        name: "run_background_index",
        arguments: { repo: "mcp-repo" },
      }),
    );
    expect(tick.indexed).toBe(1);

    const stats = parseMcp(await client.callTool({ name: "cache_stats", arguments: {} }));
    expect(stats.contextPacksServed).toBe(1);
    expect(stats.tokensSaved).toBeGreaterThan(0);

    await client.close();
  });
});
