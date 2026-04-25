import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RepoMetadata } from '../types.js';
import { EMBEDDINGS_DDL } from './embedding-store.js';

export const SCHEMA_VERSION = 3;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT    PRIMARY KEY,
  root_path       TEXT    NOT NULL UNIQUE,
  symbol_count    INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  languages       TEXT    NOT NULL DEFAULT '[]',
  indexed_at      INTEGER NOT NULL,
  schema_version  INTEGER NOT NULL,
  tenant_id       TEXT    NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS files (
  repo_id       TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  raw_content   BLOB,
  indexed_at    INTEGER NOT NULL,
  tenant_id     TEXT    NOT NULL DEFAULT 'local',
  PRIMARY KEY (repo_id, path),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
  id             TEXT    NOT NULL,
  repo_id        TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  file_path      TEXT    NOT NULL,
  start_byte     INTEGER NOT NULL,
  end_byte       INTEGER NOT NULL,
  signature      TEXT    NOT NULL DEFAULT '',
  summary        TEXT    NOT NULL DEFAULT '',
  framework_meta TEXT,
  indexed_at     INTEGER NOT NULL,
  tenant_id      TEXT    NOT NULL DEFAULT 'local',
  PRIMARY KEY (id, repo_id),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dep_edges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id          TEXT NOT NULL,
  source_file      TEXT NOT NULL,
  source_symbol_id TEXT,
  target_file      TEXT NOT NULL,
  target_symbol_id TEXT,
  edge_type        TEXT NOT NULL,
  specifier        TEXT NOT NULL,
  tenant_id        TEXT NOT NULL DEFAULT 'local',
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_name     ON symbols(repo_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_file     ON symbols(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_kind     ON symbols(repo_id, kind);
CREATE INDEX IF NOT EXISTS idx_dep_edges_source      ON dep_edges(repo_id, source_file);
CREATE INDEX IF NOT EXISTS idx_dep_edges_target      ON dep_edges(repo_id, target_file);
CREATE INDEX IF NOT EXISTS idx_dep_edges_target_sym  ON dep_edges(repo_id, target_symbol_id)
  WHERE target_symbol_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
  symbol_id UNINDEXED,
  repo_id   UNINDEXED,
  content,
  tokenize  = 'porter ascii'
);
`;

// ─── Database factory ─────────────────────────────────────────────────────────

export function computeRepoId(absolutePath: string): string {
  return createHash('sha256').update(absolutePath).digest('hex').slice(0, 16);
}

export function getIndexDir(): string {
  return join(homedir(), '.pureconfig', 'indexes');
}

export function openDatabase(repoId: string, indexDir?: string): Database.Database {
  const dir = indexDir ?? getIndexDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, `${repoId}.db`));
  initializeDatabase(db);
  return db;
}

export function openInMemoryDatabase(): Database.Database {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

export function initializeDatabase(db: Database.Database): void {
  db.exec(DDL);
  db.exec(EMBEDDINGS_DDL);
  runMigrations(db);
}

// ─── Migrations ───────────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  // Read the highest schema_version present in repos (if any rows exist).
  // If the table is empty or new, no migration needed — rows are written at
  // SCHEMA_VERSION by callers.
  const row = db.prepare<[], { v: number }>('SELECT MAX(schema_version) AS v FROM repos').get();
  const dbVersion = row?.v ?? 0;

  // Migration v1 → v2: add clone_path column to repos table.
  if (dbVersion < 2) {
    // SQLite doesn't support IF NOT EXISTS for ADD COLUMN — check first.
    const repoCols = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
    if (!repoCols.some((c) => c.name === 'clone_path')) {
      db.exec('ALTER TABLE repos ADD COLUMN clone_path TEXT');
    }

    // Add embedding column to symbols table.
    const symCols = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
    if (!symCols.some((c) => c.name === 'embedding')) {
      db.exec('ALTER TABLE symbols ADD COLUMN embedding BLOB');
    }

    // The fts_symbols virtual table is created by the DDL above (IF NOT EXISTS).
  }

  // Migration v2 → v3: add tenant_id to all data tables.
  // Existing rows migrate to the default 'local' tenant.
  if (dbVersion < 3) {
    const repoCols = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
    if (!repoCols.some((c) => c.name === 'tenant_id')) {
      db.exec("ALTER TABLE repos ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
    }

    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'tenant_id')) {
      db.exec("ALTER TABLE files ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
    }

    const symCols = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
    if (!symCols.some((c) => c.name === 'tenant_id')) {
      db.exec("ALTER TABLE symbols ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
    }

    const edgeCols = db.prepare("PRAGMA table_info(dep_edges)").all() as Array<{ name: string }>;
    if (!edgeCols.some((c) => c.name === 'tenant_id')) {
      db.exec("ALTER TABLE dep_edges ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
    }

    // Add tenant_id to embeddings table (created by EMBEDDINGS_DDL, not DDL above).
    const embCols = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>;
    if (embCols.length > 0 && !embCols.some((c) => c.name === 'tenant_id')) {
      db.exec("ALTER TABLE embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
    }

    // Add tenant index on symbols (may already exist on fresh DBs from DDL).
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_tenant ON symbols(tenant_id, repo_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_files_tenant ON files(tenant_id, repo_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dep_edges_tenant ON dep_edges(tenant_id, repo_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_tenant ON embeddings(tenant_id, repo_id)');
    } catch {
      // Indexes already exist — ignore
    }
  }
}

// ─── Repo operations ──────────────────────────────────────────────────────────

export function upsertRepo(db: Database.Database, meta: RepoMetadata): void {
  db.prepare(`
    INSERT INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version, clone_path, tenant_id)
    VALUES (@id, @rootPath, @symbolCount, @fileCount, @languages, @indexedAt, @schemaVersion, @clonePath, @tenantId)
    ON CONFLICT(id) DO UPDATE SET
      root_path      = excluded.root_path,
      symbol_count   = excluded.symbol_count,
      file_count     = excluded.file_count,
      languages      = excluded.languages,
      indexed_at     = excluded.indexed_at,
      schema_version = excluded.schema_version,
      clone_path     = excluded.clone_path,
      tenant_id      = excluded.tenant_id
  `).run({
    id: meta.id,
    rootPath: meta.rootPath,
    symbolCount: meta.symbolCount,
    fileCount: meta.fileCount,
    languages: JSON.stringify(meta.languages),
    indexedAt: meta.indexedAt,
    schemaVersion: meta.schemaVersion,
    clonePath: meta.clonePath ?? null,
    tenantId: meta.tenantId ?? 'local',
  });
}

export function getRepo(db: Database.Database, repoId: string): RepoMetadata | null {
  const row = db.prepare<[string], DbRepoRow>(
    'SELECT * FROM repos WHERE id = ?',
  ).get(repoId);
  return row ? rowToRepo(row) : null;
}

export function listRepos(db: Database.Database): RepoMetadata[] {
  return db.prepare<[], DbRepoRow>('SELECT * FROM repos ORDER BY indexed_at DESC').all().map(rowToRepo);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DbRepoRow {
  id: string;
  root_path: string;
  symbol_count: number;
  file_count: number;
  languages: string;
  indexed_at: number;
  schema_version: number;
  clone_path: string | null;
  tenant_id: string | null;
}

function rowToRepo(row: DbRepoRow): RepoMetadata {
  return {
    id: row.id,
    rootPath: row.root_path,
    symbolCount: row.symbol_count,
    fileCount: row.file_count,
    languages: JSON.parse(row.languages) as string[],
    indexedAt: row.indexed_at,
    schemaVersion: row.schema_version,
    clonePath: row.clone_path ?? null,
    tenantId: row.tenant_id ?? 'local',
  };
}
