import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { summarizeFile, tokenize } from "../src/summarizer.js";
import { cleanup, makeFixtureRepo, makeRepo, makeTmp } from "./helpers.js";

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

describe("search", () => {
  it("ranks symbol and path matches in the fixture repo", () => {
    const dir = makeFixtureRepo(root);
    engine.registerRepo(dir, { name: "sample" });
    const hits = engine.search("authenticate token");
    expect(hits[0]?.path).toBe("src/auth.ts");
    const billing = engine.search("invoice tax");
    expect(billing[0]?.path).toBe("src/billing.ts");
    expect(billing[0]?.symbols).toContain("calculateInvoice");
  });

  it("matches camelCase identifiers from natural words", () => {
    const dir = makeFixtureRepo(root);
    engine.registerRepo(dir);
    expect(engine.search("calculate invoice")[0]?.path).toBe("src/billing.ts");
  });

  it("searches across all repos and can scope to one", () => {
    const a = makeRepo(root, "a", { "x.ts": "export function sharedThing() {}\n" });
    const b = makeRepo(root, "b", { "y.py": "def shared_thing():\n    pass\n" });
    engine.registerRepo(a, { name: "alpha" });
    engine.registerRepo(b, { name: "beta" });
    const all = engine.search("shared thing");
    expect(new Set(all.map((h) => h.repoName))).toEqual(new Set(["alpha", "beta"]));
    const only = engine.search("shared thing", { repo: "beta" });
    expect(only.every((h) => h.repoName === "beta")).toBe(true);
  });

  it("returns nothing for unmatched or empty queries and honours limit", () => {
    const dir = makeFixtureRepo(root);
    engine.registerRepo(dir);
    expect(engine.search("zzzqqq")).toEqual([]);
    expect(engine.search("   ")).toEqual([]);
    expect(engine.search("src", { limit: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("returns file context with optional content from git", () => {
    const dir = makeFixtureRepo(root);
    const { repo } = engine.registerRepo(dir);
    const ctx = engine.fileContext(repo.id, "src/auth.ts", { includeContent: true, maxChars: 50 });
    expect(ctx.cacheHit).toBe(true);
    expect(ctx.summary).toMatch(/Authentication helpers/);
    expect(ctx.content?.length).toBe(50);
    expect(ctx.truncated).toBe(true);
  });
});

describe("extractive summarizer", () => {
  it("is deterministic and extracts leading docs and symbols", () => {
    const src = "/** Parses things. */\nexport class Parser {}\nexport function parse() {}\n";
    const a = summarizeFile("p.ts", src);
    expect(a).toEqual(summarizeFile("p.ts", src));
    expect(a.summary).toContain("Parses things");
    expect(a.symbols).toEqual(["Parser", "parse"]);
  });

  it("handles python docstrings and markdown headings", () => {
    expect(summarizeFile("m.py", '"""Math utils."""\ndef add(a, b):\n    return a\n').summary).toContain("Math utils");
    expect(summarizeFile("R.md", "# Title\n\nSome intro text.\n").symbols).toEqual(["Title"]);
  });

  it("tokenizes identifiers", () => {
    expect(tokenize("getUserName snake_case")).toEqual(expect.arrayContaining(["user", "name", "snake", "case"]));
  });
});

describe("file filtering", () => {
  it("skips secrets, lockfiles, binaries, oversized and vendored files", () => {
    const big = "x".repeat(250_000);
    const dir = makeRepo(root, "filt", {
      "ok.ts": "export const ok = 1;\n",
      ".env": "API_KEY=CANARY_SECRET_VALUE\n",
      "deploy.key": "CANARY_SECRET_VALUE\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "package-lock.json": "{}",
      "big.ts": big,
    });
    const { repo, indexed } = engine.registerRepo(dir);
    expect(indexed!.filesIndexed).toBe(1);
    expect(indexed!.filesSkipped).toBe(5);
    expect(engine.search("CANARY_SECRET_VALUE")).toEqual([]);
    expect(() => engine.fileContext(repo.id, ".env", { includeContent: true })).toThrow(/secret/i);
    const rows = engine.db.prepare("SELECT COUNT(*) AS n FROM files WHERE summary LIKE '%CANARY_SECRET%' OR keywords LIKE '%canary_secret%'").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
