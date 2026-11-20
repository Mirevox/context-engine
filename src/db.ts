import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  last_indexed_commit TEXT,
  last_indexed_at TEXT,
  file_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
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
CREATE INDEX IF NOT EXISTS idx_files_blob ON files (repo_id, path, blob_sha);
CREATE TABLE IF NOT EXISTS repo_summaries (
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
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  return db;
}

export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
