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

describe("commit-aware invalidation", () => {
  it("serves from cache while HEAD is unchanged", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export function a() {}\n" });
    const { repo } = engine.registerRepo(dir);
    const first = engine.ensureFresh(repo.id);
    const second = engine.ensureFresh(repo.id);
    expect(first.indexed).toBeUndefined();
    expect(second.indexed).toBeUndefined();
    expect(engine.stats().invalidations).toBe(0);
    expect(engine.repoSummary(repo.id).cacheHit).toBe(true);
  });

  it("reindexRepo(force=false) reports fresh without inflating counters", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export function a() {}\n" });
    const { repo } = engine.registerRepo(dir);
    const before = engine.stats();
    const result = engine.reindexRepo(repo.id, false);
    expect(result.reason).toBe("fresh");
    expect(engine.stats().reindexes).toBe(before.reindexes);
  });

  it("reindexes when HEAD sha differs from the cached sha", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export function oldName() {}\n" });
    const { repo, indexed } = engine.registerRepo(dir);
    expect(indexed?.reason).toBe("initial");
    const oldSha = indexed!.commitSha;

    writeFiles(dir, { "a.ts": "export function newName() {}\n" });
    const newSha = commitAll(dir);
    expect(newSha).not.toBe(oldSha);
    expect(engine.listRepos()[0]!.stale).toBe(true);

    const fresh = engine.ensureFresh(repo.id);
    expect(fresh.indexed?.reason).toBe("head-changed");
    expect(fresh.commitSha).toBe(newSha);
    expect(engine.registry.get(repo.id)!.lastIndexedCommit).toBe(newSha);
    expect(engine.stats().invalidations).toBe(1);
    expect(engine.listRepos()[0]!.stale).toBe(false);

    expect(engine.search("newName")[0]?.path).toBe("a.ts");
    expect(engine.fileContext(repo.id, "a.ts").symbols).toEqual(["newName"]);
  });

  it("invalidates automatically from query tools (search, file context, summary)", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export function one() {}\n" });
    const { repo } = engine.registerRepo(dir);
    writeFiles(dir, { "b.ts": "export function brandNewThing() {}\n" });
    commitAll(dir);
    const hits = engine.search("brandNewThing");
    expect(hits.map((h) => h.path)).toContain("b.ts");
    expect(engine.stats().invalidations).toBe(1);
    expect(engine.repoSummary(repo.id).fileCount).toBe(2);
  });

  it("drops deleted files after a new commit", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export const a = 1;\n", "gone.ts": "export const gone = 1;\n" });
    const { repo } = engine.registerRepo(dir);
    writeFiles(dir, {});
    commitAllRemove(dir, "gone.ts");
    engine.ensureFresh(repo.id);
    expect(() => engine.fileContext(repo.id, "gone.ts")).toThrow(/not found/i);
    expect(engine.search("gone")).toEqual([]);
  });

  it("forced reindex recomputes every file for HEAD", () => {
    const dir = makeRepo(root, "r", { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
    const { repo } = engine.registerRepo(dir);
    const res = engine.reindexRepo(repo.id, true);
    expect(res.reason).toBe("forced");
    expect(res.filesIndexed).toBe(2);
    expect(res.filesReused).toBe(0);
  });
});

import { rmSync } from "node:fs";
import { join } from "node:path";
function commitAllRemove(dir: string, rel: string): void {
  rmSync(join(dir, rel));
  commitAll(dir, "remove");
}
