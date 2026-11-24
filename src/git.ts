import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[], opts: { input?: string | Buffer } = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 1024 * 1024 * 256,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function repoRoot(path: string): string {
  return git(path, ["rev-parse", "--show-toplevel"]).trim();
}

export function headSha(repoPath: string): string {
  return git(repoPath, ["rev-parse", "--verify", "HEAD"]).trim();
}

export function originRemoteUrl(repoPath: string): string | null {
  try {
    const out = git(repoPath, ["remote", "get-url", "origin"]).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

export function listTree(repoPath: string, sha: string): TreeEntry[] {
  const out = git(repoPath, ["ls-tree", "-r", "-l", "-z", sha]);
  const entries: TreeEntry[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [, type, blobSha, size] = rec.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !blobSha) continue;
    entries.push({ path: rec.slice(tab + 1), blobSha, size: Number(size) || 0 });
  }
  return entries;
}

/** Read many blobs in one `git cat-file --batch` call. */
export function readBlobs(repoPath: string, blobShas: string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  if (blobShas.length === 0) return result;
  const raw = execFileSync("git", ["-C", repoPath, "cat-file", "--batch"], {
    input: blobShas.join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pos = 0;
  while (pos < raw.length) {
    const nl = raw.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = raw.subarray(pos, nl).toString("utf8").split(" ");
    pos = nl + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    result.set(header[0]!, raw.subarray(pos, pos + size));
    pos += size + 1;
  }
  return result;
}

export function readFileAt(repoPath: string, sha: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["-C", repoPath, "show", `${sha}:${path}`], {
      maxBuffer: 1024 * 1024 * 64,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}
