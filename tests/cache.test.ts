import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { cleanup, commitAll, makeRepo, makeTmp, writeFiles } from "./helpers.js";

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

describe("cache keying (repoId, commitSha, path)", () => {
  it("stores a summary per commit and path and hits on the same key", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export function alpha() {}\n", "b.ts": "export const beta = 1;\n" });
    const { repo } = engine.registerRepo(dir);
    const sha = engine.registry.get(repo.id)!.lastIndexedCommit!;

    const a = engine.cache.getFile(repo.id, sha, "a.ts");
    expect(a?.symbols).toContain("alpha");
    expect(engine.cache.getFile(repo.id, sha, "missing.ts")).toBeUndefined();
    expect(engine.cache.getFile(repo.id, "0".repeat(40), "a.ts")).toBeUndefined();
    expect(engine.cache.getFile("otherrepo", sha, "a.ts")).toBeUndefined();

    const c = engine.cache.counters();
    expect(c.fileHits).toBeGreaterThanOrEqual(1);
    expect(c.fileMisses).toBeGreaterThanOrEqual(3);
  });

  it("keeps independent rows for the same path in different repos", () => {
    const d1 = makeRepo(root, "one", { "x.ts": "export function one() {}\n" });
    const d2 = makeRepo(root, "two", { "x.ts": "export function two() {}\n" });
    const r1 = engine.registerRepo(d1).repo;
    const r2 = engine.registerRepo(d2).repo;
    expect(engine.fileContext(r1.id, "x.ts").symbols).toEqual(["one"]);
    expect(engine.fileContext(r2.id, "x.ts").symbols).toEqual(["two"]);
  });

  it("reuses summaries for unchanged blobs across commits instead of recomputing", () => {
    const dir = makeRepo(root, "r", { "keep.ts": "export function keep() {}\n", "edit.ts": "export const v = 1;\n" });
    const { repo } = engine.registerRepo(dir);
    writeFiles(dir, { "edit.ts": "export const v = 2;\n" });
    commitAll(dir);
    const res = engine.ensureFresh(repo.id).indexed!;
    expect(res.filesReused).toBe(1);
    expect(res.filesIndexed).toBe(1);
  });

  it("persists hit/miss counters across engine instances", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export const a = 1;\n" });
    const { repo } = engine.registerRepo(dir);
    engine.fileContext(repo.id, "a.ts");
    const before = engine.stats();
    engine.close();

    engine = new ContextEngine({ dataDir: `${root}/data` });
    const after = engine.stats();
    expect(after.hits).toBe(before.hits);
    expect(after.misses).toBe(before.misses);
    expect(after.session.fileHits).toBe(0);
    engine.fileContext(repo.id, "a.ts");
    expect(engine.stats().hits).toBeGreaterThan(before.hits);
  });

  it("prunes cached commits beyond keepCommits", () => {
    engine.close();
    engine = new ContextEngine({ dataDir: `${root}/data`, keepCommits: 2 });
    const dir = makeRepo(root, "r", { "a.ts": "export const a = 0;\n" });
    const { repo } = engine.registerRepo(dir);
    for (let i = 1; i <= 3; i++) {
      writeFiles(dir, { "a.ts": `export const a = ${i};\n` });
      commitAll(dir);
      engine.ensureFresh(repo.id);
    }
    const n = (engine.db.prepare("SELECT COUNT(DISTINCT commit_sha) AS n FROM files WHERE repo_id = ?").get(repo.id) as { n: number }).n;
    expect(n).toBe(2);
  });
});
