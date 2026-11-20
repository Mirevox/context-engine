import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface EngineConfig {
  dataDir: string;
  dbPath: string;
  maxFileBytes: number;
  maxFilesPerRepo: number;
  keepCommits: number;
}

export interface ConfigOverrides {
  dataDir?: string;
  maxFileBytes?: number;
  maxFilesPerRepo?: number;
  keepCommits?: number;
}

/**
 * Data dir precedence: explicit override, MIREVOX_CONTEXT_DIR, ~/.mirevox/context-engine,
 * then ./.mirevox-context when the home directory is not writable.
 */
export function resolveDataDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(explicit));
  else if (process.env.MIREVOX_CONTEXT_DIR) candidates.push(resolve(process.env.MIREVOX_CONTEXT_DIR));
  else {
    candidates.push(join(homedir(), ".mirevox", "context-engine"));
    candidates.push(resolve(".mirevox-context"));
  }
  let lastErr: unknown;
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return dir;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`No writable data directory (${String(lastErr)})`);
}

export function loadConfig(overrides: ConfigOverrides = {}): EngineConfig {
  const dataDir = resolveDataDir(overrides.dataDir);
  return {
    dataDir,
    dbPath: join(dataDir, "cache.sqlite"),
    maxFileBytes: overrides.maxFileBytes ?? 200_000,
    maxFilesPerRepo: overrides.maxFilesPerRepo ?? 5000,
    keepCommits: overrides.keepCommits ?? 3,
  };
}
