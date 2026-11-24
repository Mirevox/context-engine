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
CREATE TABLE IF NOT EXISTS appcode_documents (
  appcode TEXT NOT NULL,
  source TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  summary TEXT NOT NULL,
  summary_bytes INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  symbols TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  summarizer_version INTEGER NOT NULL,
  PRIMARY KEY (appcode, source, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_appcode_docs_appcode ON appcode_documents (appcode, stage, source);
CREATE INDEX IF NOT EXISTS idx_appcode_docs_hash ON appcode_documents (appcode, content_hash);
`;

const txDepth = new WeakMap<Db, number>();

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  inTransaction(db, () => {
    const cols = db.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "remote_url")) {
      db.exec("ALTER TABLE repos ADD COLUMN remote_url TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_repos_remote ON repos (remote_url);");

    const appCols = db.prepare("PRAGMA table_info(appcode_documents)").all() as { name: string }[];
    if (!appCols.some((c) => c.name === "content")) {
      db.exec("ALTER TABLE appcode_documents ADD COLUMN content TEXT NOT NULL DEFAULT '';");
    }
  });
  return db;
}

export function inTransaction<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth === 0) {
    db.exec("BEGIN IMMEDIATE");
    txDepth.set(db, 1);
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      txDepth.set(db, 0);
    }
  }
  const sp = `sp_${depth}`;
  db.exec(`SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const out = fn();
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    return out;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      db.exec(`RELEASE SAVEPOINT ${sp}`);
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
