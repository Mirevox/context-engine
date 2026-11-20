import { basename, extname } from "node:path";

export interface FileSummary {
  language: string;
  summary: string;
  symbols: string[];
  keywords: string;
}

const LANGS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".cs": "csharp", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c", ".cc": "cpp",
  ".cpp": "cpp", ".hpp": "cpp", ".swift": "swift", ".sh": "shell", ".bash": "shell",
  ".md": "markdown", ".mdx": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".sql": "sql", ".html": "html", ".css": "css", ".scss": "css",
  ".txt": "text",
};

const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".woff",
  ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".mov", ".wasm", ".jar", ".class", ".so", ".dylib",
  ".exe", ".bin", ".sqlite", ".db", ".lock", ".map",
]);

const SKIP_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum"]);
const SKIP_DIRS = ["node_modules/", "vendor/", "dist/", "build/", ".git/"];

const STOPWORDS = new Set(
  "the a an and or of to in is it for on with as by at be this that from are was not but if else return const let var function import export default new true false null undefined void string number boolean any self def class type async await".split(
    " ",
  ),
);

export const SUMMARY_MAX_CHARS = 420;

export function languageOf(path: string): string {
  const name = basename(path);
  if (name === "Dockerfile") return "dockerfile";
  if (name === "Makefile") return "make";
  return LANGS[extname(path).toLowerCase()] ?? "other";
}

const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx)|.*(secret|credential).*)$/i;

/** Secret-shaped filenames never enter the cache or tool output. */
export function isSecretPath(path: string): boolean {
  return SECRET_NAME.test(basename(path));
}

export function shouldIndex(path: string): boolean {
  const name = basename(path);
  if (isSecretPath(path)) return false;
  if (SKIP_NAMES.has(name) || name.endsWith(".min.js") || name.endsWith(".min.css")) return false;
  if (SKIP_EXT.has(extname(path).toLowerCase())) return false;
  const p = "/" + path;
  return !SKIP_DIRS.some((d) => p.includes("/" + d));
}

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  ],
  python: [/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/],
  java: [/^\s*(?:public|protected|private|abstract|final|static|\s)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/],
  ruby: [/^\s*(?:def|class|module)\s+([A-Za-z_][\w.?!]*)/],
  shell: [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/],
};
SYMBOL_PATTERNS.javascript = SYMBOL_PATTERNS.typescript!;
SYMBOL_PATTERNS.kotlin = SYMBOL_PATTERNS.java!;
SYMBOL_PATTERNS.csharp = SYMBOL_PATTERNS.java!;

export function extractSymbols(language: string, text: string, limit = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s) && out.length < limit) {
      seen.add(s);
      out.push(s);
    }
  };
  const lines = text.split("\n");
  if (language === "markdown") {
    for (const line of lines) {
      const m = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
      if (m) add(m[1]!);
    }
    return out;
  }
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return out;
  for (const line of lines) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (m?.[1]) {
        add(m[1]);
        break;
      }
    }
  }
  return out;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** First leading comment / docstring / README paragraph, as plain text. */
export function leadingDoc(language: string, text: string): string {
  const lines = text.split("\n").slice(0, 60);
  if (language === "markdown") {
    const para: string[] = [];
    for (const line of lines) {
      if (/^#/.test(line) || /^\s*$/.test(line) || /^(```|---|\[!|<)/.test(line)) {
        if (para.length) break;
        continue;
      }
      para.push(line);
    }
    return clean(para.join(" "));
  }
  if (language === "json") return "";
  const doc: string[] = [];
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]!) || /^#!/.test(lines[i]!) || /^\s*(["']use strict["'];?)\s*$/.test(lines[i]!))) i++;
  const first = lines[i] ?? "";
  if (/^\s*\/\*/.test(first)) {
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      doc.push(l.replace(/^\s*\/?\*+\/?\s?/, "").replace(/\*\/\s*$/, ""));
      if (l.includes("*/")) break;
    }
  } else if (/^\s*(\/\/|#(?!include|!))/.test(first)) {
    for (; i < lines.length && /^\s*(\/\/|#(?!include|!))/.test(lines[i]!); i++) {
      doc.push(lines[i]!.replace(/^\s*(\/\/+|#+)\s?/, ""));
    }
  } else if (/^\s*[rR]?("""|''')/.test(first)) {
    const m = /^\s*[rR]?("""|''')(.*)$/.exec(first)!;
    const quote = m[1]!;
    const rest = m[2]!;
    if (rest.includes(quote)) doc.push(rest.slice(0, rest.indexOf(quote)));
    else {
      doc.push(rest);
      for (i++; i < lines.length; i++) {
        const idx = lines[i]!.indexOf(quote);
        if (idx >= 0) {
          doc.push(lines[i]!.slice(0, idx));
          break;
        }
        doc.push(lines[i]!);
      }
    }
  }
  return clean(doc.join(" "));
}

function topKeywords(text: string, limit = 30): string[] {
  const counts = new Map<string, number>();
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    for (const part of splitIdentifier(w)) {
      if (part.length < 3 || STOPWORDS.has(part)) continue;
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export function tokenize(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.match(/[A-Za-z0-9_$.\-/]+/g) ?? []) {
    for (const t of splitIdentifier(raw.replace(/[./\\]/g, " "))) if (!STOPWORDS.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

function jsonSummary(text: string, path: string): { summary: string; symbols: string[] } {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const keys = Object.keys(obj).slice(0, 12);
      const bits: string[] = [];
      if (typeof obj.name === "string") bits.push(`name=${obj.name}`);
      if (typeof obj.description === "string") bits.push(obj.description);
      if (bits.length === 0) bits.push(`keys: ${keys.join(", ")}`);
      return { summary: bits.join(" - "), symbols: keys };
    }
    return { summary: `JSON array with ${(obj as unknown[]).length} items`, symbols: [] };
  } catch {
    return { summary: `JSON file ${path}`, symbols: [] };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/** Deterministic extractive summary: leading doc + symbols + size. No LLM. */
export function summarizeFile(path: string, text: string): FileSummary {
  const language = languageOf(path);
  const lineCount = text === "" ? 0 : text.split("\n").length;
  let symbols = extractSymbols(language, text);
  let doc = leadingDoc(language, text);
  if (language === "json") {
    const j = jsonSummary(text, path);
    doc = j.summary;
    symbols = j.symbols;
  }
  if (!doc) {
    const firstLine = text.split("\n").find((l) => l.trim() && !/^\s*(import|from|using|package|#include|use|require)\b/.test(l));
    doc = firstLine ? clean(firstLine).slice(0, 120) : "";
  }
  const parts = [`${language}, ${lineCount} lines.`];
  if (doc) parts.push(doc.endsWith(".") ? doc : doc + ".");
  if (symbols.length) parts.push(`Defines: ${symbols.slice(0, 12).join(", ")}${symbols.length > 12 ? ", …" : ""}.`);
  return {
    language,
    summary: truncate(parts.join(" "), SUMMARY_MAX_CHARS),
    symbols,
    keywords: topKeywords(text).join(" "),
  };
}

export interface RepoSummaryInput {
  name: string;
  files: { path: string; language: string; byteSize: number; summary: string }[];
  readme?: string;
  packageDescription?: string;
}

export interface RepoOverview {
  overview: string;
  languages: Record<string, number>;
  topPaths: string[];
}

const ENTRY_HINTS = /(^|\/)(index|main|app|server|cli|mod|lib|__init__|__main__)\.[a-z]+$/;

export function summarizeRepo(input: RepoSummaryInput): RepoOverview {
  const languages: Record<string, number> = {};
  for (const f of input.files) languages[f.language] = (languages[f.language] ?? 0) + 1;
  const sortedLangs = Object.entries(languages).sort((a, b) => b[1] - a[1]);

  const dirs = new Map<string, number>();
  for (const f of input.files) {
    const top = f.path.includes("/") ? f.path.split("/")[0]! + "/" : "(root)";
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
  }
  const dirList = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const scored = input.files
    .filter((f) => f.language !== "other")
    .map((f) => {
      let score = 0;
      if (/^readme/i.test(basename(f.path))) score += 6;
      if (ENTRY_HINTS.test(f.path)) score += 4;
      if (!f.path.includes("/")) score += 2;
      if (/(^|\/)(tests?|__tests__|fixtures?)\//.test(f.path)) score -= 3;
      score += Math.min(f.byteSize / 4000, 2);
      return { path: f.path, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const topPaths = scored.slice(0, 10).map((s) => s.path);

  const lines: string[] = [];
  const intro = input.packageDescription || input.readme;
  lines.push(`${input.name}: ${input.files.length} indexed files.`);
  if (intro) lines.push(truncate(clean(intro), 300));
  if (sortedLangs.length) {
    lines.push("Languages: " + sortedLangs.slice(0, 5).map(([l, n]) => `${l} (${n})`).join(", ") + ".");
  }
  if (dirList.length) lines.push("Layout: " + dirList.map(([d, n]) => `${d} (${n})`).join(", ") + ".");
  if (topPaths.length) lines.push("Key files: " + topPaths.slice(0, 6).join(", ") + ".");
  return { overview: lines.join(" "), languages, topPaths };
}
