import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { assertSafeBind, createHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { cleanup, makeFixtureRepo, makeTmp } from "./helpers.js";

let root: string;
let engine: ContextEngine;
let repoDir: string;

beforeEach(() => {
  root = makeTmp();
  engine = new ContextEngine({ dataDir: `${root}/data` });
  repoDir = makeFixtureRepo(root);
});
afterEach(() => {
  engine.close();
  cleanup(root);
});

function parse(res: unknown): any {
  const r = res as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe("MCP", () => {
  it("exposes all tools and shares the cache", async () => {
    engine.registerRepo(repoDir, { name: "sample" });
    const server = createMcpServer(engine);
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ["cache_stats", "get_file_context", "get_repo_summary", "list_repos", "register_repo", "reindex_repo", "search_context"].sort(),
    );
    expect(parse(await client.callTool({ name: "list_repos", arguments: {} }))[0].name).toBe("sample");
    const summary = parse(await client.callTool({ name: "get_repo_summary", arguments: { repo: "sample" } }));
    expect(summary.cacheHit).toBe(true);
    const hits = parse(await client.callTool({ name: "search_context", arguments: { query: "authenticate" } }));
    expect(hits[0].path).toBe("src/auth.ts");
    const file = parse(
      await client.callTool({ name: "get_file_context", arguments: { repo: "sample", path: "src/billing.ts" } }),
    );
    expect(file.symbols).toContain("InvoiceBuilder");
    const re = parse(await client.callTool({ name: "reindex_repo", arguments: { repo: "sample" } }));
    expect(re.reason).toBe("forced");
    const stats = parse(await client.callTool({ name: "cache_stats", arguments: {} }));
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.reindexes).toBeGreaterThanOrEqual(2);
    const bad = await client.callTool({ name: "get_repo_summary", arguments: { repo: "nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe("HTTP", () => {
  it("serves the JSON API", async () => {
    const server = createHttpServer(engine, { token: "secret" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: "Bearer secret" };
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/stats`)).status).toBe(401);

      const reg = await fetch(`${base}/repos`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ path: repoDir, name: "sample" }),
      });
      expect(reg.status).toBe(201);

      const search = (await (await fetch(`${base}/search?q=invoice&repo=sample`, { headers: auth })).json()) as any[];
      expect(search[0].path).toBe("src/billing.ts");
      const file = (await (await fetch(`${base}/file?repo=sample&path=src/auth.ts&content=1`, { headers: auth })).json()) as any;
      expect(file.content).toContain("authenticate");
      const sum = (await (await fetch(`${base}/repos/sample/summary`, { headers: auth })).json()) as any;
      expect(sum.cacheHit).toBe(true);
      const stats = (await (await fetch(`${base}/stats`, { headers: auth })).json()) as any;
      expect(stats.files).toBeGreaterThan(0);
      expect((await fetch(`${base}/repos/missing/summary`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/search`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${base}/search?q=invoice&limit=foo`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${base}/repos/sample`, { method: "DELETE", headers: auth })).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("hardening", () => {
  it("fails closed on non-loopback bind without a token", () => {
    expect(() => assertSafeBind("0.0.0.0", undefined)).toThrow(/CONTEXT_ENGINE_TOKEN/);
    expect(() => assertSafeBind("0.0.0.0", "t")).not.toThrow();
    expect(() => assertSafeBind("127.0.0.1", undefined)).not.toThrow();
  });
});
