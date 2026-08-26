import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RepoMetadata } from '../types.js';
import { EMBEDDINGS_DDL } from './embedding-store.js';
import { CO_CHANGE_DDL } from './co-change-store.js';
import { getSqliteFactory, type SqliteDatabase } from './sqlite-loader.js';

// ─── SQLite backend ───────────────────────────────────────────────────────────
// The concrete engine (native better-sqlite3 or the WASM fallback) is chosen by
// the loader. We keep the better-sqlite3-compatible `SqliteDatabase` type so
// the existing `InstanceType<DatabaseConstructor>` annotations below — and all
// call sites — remain valid and unchanged.
type DatabaseConstructor = new (filename: string) => SqliteDatabase;

// v11 (Phase 90): values-correctness bump, no DDL change. Pre-v11 indexes
// stored UTF-16 char indices in start_byte/end_byte (char-vs-byte corruption);
// index-manager force-re-parses pre-v11 repos once so spans become true bytes.
export const SCHEMA_VERSION = 11;

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
  tenant_id       TEXT    NOT NULL DEFAULT 'local',
  git_tree_sha    TEXT,
  source          TEXT    NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS files (
  repo_id             TEXT    NOT NULL,
  path                TEXT    NOT NULL,
  content_hash        TEXT    NOT NULL,
  raw_content         BLOB,
  indexed_at          INTEGER NOT NULL,
  tenant_id           TEXT    NOT NULL DEFAULT 'local',
  remote_sha          TEXT,
  last_commit_sha     TEXT,
  last_commit_author  TEXT,
  last_commit_date    INTEGER,
  last_commit_message TEXT,
  commit_count        INTEGER,
  declared_package    TEXT,
  PRIMARY KEY (repo_id, path),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_metadata (
  repo_id      TEXT    NOT NULL,
  file_path    TEXT    NOT NULL,
  commit_sha   TEXT    NOT NULL,
  author_name  TEXT    NOT NULL,
  author_email TEXT    NOT NULL,
  commit_date  INTEGER NOT NULL,
  message      TEXT    NOT NULL,
  PRIMARY KEY (repo_id, file_path, commit_sha),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
  id                   TEXT    NOT NULL,
  repo_id              TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  kind                 TEXT    NOT NULL,
  file_path            TEXT    NOT NULL,
  start_byte           INTEGER NOT NULL,
  end_byte             INTEGER NOT NULL,
  signature            TEXT    NOT NULL DEFAULT '',
  summary              TEXT    NOT NULL DEFAULT '',
  framework_meta       TEXT,
  indexed_at           INTEGER NOT NULL,
  tenant_id            TEXT    NOT NULL DEFAULT 'local',
  line_count           INTEGER,
  cyclomatic_complexity INTEGER,
  cognitive_complexity  INTEGER,
  param_count          INTEGER,
  return_count         INTEGER,
  nesting_depth        INTEGER,
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

-- v10 (Task 561): raw import statements per file, persisted so edges can be
-- re-resolved without re-parsing — e.g. when a newly added file becomes the
-- target of imports that unchanged files wrote before it existed.
CREATE TABLE IF NOT EXISTS import_records (
  repo_id        TEXT NOT NULL,
  source_file    TEXT NOT NULL,
  specifier      TEXT NOT NULL,
  resolved_path  TEXT,
  imported_names TEXT NOT NULL DEFAULT '[]',
  is_type_only   INTEGER NOT NULL DEFAULT 0,
  tenant_id      TEXT NOT NULL DEFAULT 'local',
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_records_source ON import_records(repo_id, source_file);

CREATE TABLE IF NOT EXISTS provider_metadata (
  repo_id       TEXT    NOT NULL,
  provider_name TEXT    NOT NULL,
  entity_key    TEXT    NOT NULL,
  metadata      TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, provider_name, entity_key),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_name     ON symbols(repo_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_file     ON symbols(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_kind     ON symbols(repo_id, kind);
CREATE INDEX IF NOT EXISTS idx_dep_edges_source      ON dep_edges(repo_id, source_file);
CREATE INDEX IF NOT EXISTS idx_dep_edges_target      ON dep_edges(repo_id, target_file);
CREATE INDEX IF NOT EXISTS idx_dep_edges_target_sym  ON dep_edges(repo_id, target_symbol_id)
  WHERE target_symbol_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_git_metadata_repo_file ON git_metadata(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_git_metadata_date      ON git_metadata(repo_id, commit_date);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id  TEXT    NOT NULL,
  repo_id      TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  metrics      TEXT    NOT NULL,
  PRIMARY KEY (snapshot_id, repo_id),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo ON snapshots(repo_id, created_at);

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
  const dataDir = process.env['PCTX_DATA_DIR'];
  if (dataDir) return join(dataDir, 'indexes');
  return join(homedir(), '.purecontext', 'indexes');
}

export function openDatabase(repoId: string, indexDir?: string): InstanceType<DatabaseConstructor> {
  const dir = indexDir ?? getIndexDir();
  mkdirSync(dir, { recursive: true });
  const db = getSqliteFactory().open(join(dir, `${repoId}.db`));
  initializeDatabase(db);
  return db;
}

export function openInMemoryDatabase(): InstanceType<DatabaseConstructor> {
  const db = getSqliteFactory().open(':memory:');
  initializeDatabase(db);
  return db;
}

export function initializeDatabase(db: InstanceType<DatabaseConstructor>): void {
  db.exec(DDL);
  db.exec(EMBEDDINGS_DDL);
  db.exec(CO_CHANGE_DDL);
  runMigrations(db);
  // Ensure source column exists — added after v7, using try-catch for existing DBs
  // (SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
  try {
    db.exec("ALTER TABLE repos ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
  } catch {
    // Column already exists — ignore
  }
}

// ─── Migrations ───────────────────────────────────────────────────────────────

function runMigrations(db: InstanceType<DatabaseConstructor>): void {
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

  // Migration v3 → v4: add git_tree_sha to repos, remote_sha to files.
  if (dbVersion < 4) {
    const repoCols = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
    if (!repoCols.some((c) => c.name === 'git_tree_sha')) {
      db.exec('ALTER TABLE repos ADD COLUMN git_tree_sha TEXT');
    }

    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'remote_sha')) {
      db.exec('ALTER TABLE files ADD COLUMN remote_sha TEXT');
    }
  }

  // Migration v4 → v5: add provider_metadata table.
  if (dbVersion < 5) {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_metadata'"
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE provider_metadata (
          repo_id       TEXT    NOT NULL,
          provider_name TEXT    NOT NULL,
          entity_key    TEXT    NOT NULL,
          metadata      TEXT    NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (repo_id, provider_name, entity_key),
          FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
        )
      `);
    }
  }

  // Migration v5 → v6: add git metadata columns to files table + git_metadata table.
  if (dbVersion < 6) {
    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    const existingFileCols = new Set(fileCols.map((c) => c.name));

    if (!existingFileCols.has('last_commit_sha')) {
      db.exec('ALTER TABLE files ADD COLUMN last_commit_sha TEXT');
    }
    if (!existingFileCols.has('last_commit_author')) {
      db.exec('ALTER TABLE files ADD COLUMN last_commit_author TEXT');
    }
    if (!existingFileCols.has('last_commit_date')) {
      db.exec('ALTER TABLE files ADD COLUMN last_commit_date INTEGER');
    }
    if (!existingFileCols.has('last_commit_message')) {
      db.exec('ALTER TABLE files ADD COLUMN last_commit_message TEXT');
    }
    if (!existingFileCols.has('commit_count')) {
      db.exec('ALTER TABLE files ADD COLUMN commit_count INTEGER');
    }

    // Create git_metadata table if it doesn't already exist.
    db.exec(`
      CREATE TABLE IF NOT EXISTS git_metadata (
        repo_id      TEXT    NOT NULL,
        file_path    TEXT    NOT NULL,
        commit_sha   TEXT    NOT NULL,
        author_name  TEXT    NOT NULL,
        author_email TEXT    NOT NULL,
        commit_date  INTEGER NOT NULL,
        message      TEXT    NOT NULL,
        PRIMARY KEY (repo_id, file_path, commit_sha),
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
      )
    `);

    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_git_metadata_repo_file ON git_metadata(repo_id, file_path)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_git_metadata_date ON git_metadata(repo_id, commit_date)');
    } catch {
      // Indexes already exist — ignore
    }
  }

  // Migration v6 → v7: add code quality metric columns to symbols table.
  if (dbVersion < 7) {
    const symCols = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
    const existingSymCols = new Set(symCols.map((c) => c.name));

    if (!existingSymCols.has('line_count')) {
      db.exec('ALTER TABLE symbols ADD COLUMN line_count INTEGER');
    }
    if (!existingSymCols.has('cyclomatic_complexity')) {
      db.exec('ALTER TABLE symbols ADD COLUMN cyclomatic_complexity INTEGER');
    }
    if (!existingSymCols.has('cognitive_complexity')) {
      db.exec('ALTER TABLE symbols ADD COLUMN cognitive_complexity INTEGER');
    }
    if (!existingSymCols.has('param_count')) {
      db.exec('ALTER TABLE symbols ADD COLUMN param_count INTEGER');
    }
    if (!existingSymCols.has('return_count')) {
      db.exec('ALTER TABLE symbols ADD COLUMN return_count INTEGER');
    }
    if (!existingSymCols.has('nesting_depth')) {
      db.exec('ALTER TABLE symbols ADD COLUMN nesting_depth INTEGER');
    }
  }

  // Migration v7 → v8: add commit_files table for repo-level co-change capture.
  // Additive — the table is created by CO_CHANGE_DDL (IF NOT EXISTS) in
  // initializeDatabase; old indexes load without re-indexing.
  if (dbVersion < 8) {
    db.exec(CO_CHANGE_DDL);
  }

  // Migration v8 → v9: add declared_package to files (JVM import resolution).
  // Additive — old rows stay NULL until their file is re-indexed; the JVM
  // resolver treats NULL as "derive the package from the path" (best effort).
  if (dbVersion < 9) {
    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'declared_package')) {
      db.exec('ALTER TABLE files ADD COLUMN declared_package TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_declared_package ON files(repo_id, declared_package)
        WHERE declared_package IS NOT NULL
    `);
  }
}

// ─── Repo operations ──────────────────────────────────────────────────────────

export function upsertRepo(db: InstanceType<DatabaseConstructor>, meta: RepoMetadata): void {
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

export function getRepo(db: InstanceType<DatabaseConstructor>, repoId: string): RepoMetadata | null {
  const row = db.prepare<[string], DbRepoRow>(
    'SELECT * FROM repos WHERE id = ?',
  ).get(repoId);
  return row ? rowToRepo(row) : null;
}

export function listRepos(db: InstanceType<DatabaseConstructor>): RepoMetadata[] {
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

// ─── GitHub API helpers ───────────────────────────────────────────────────────

/**
 * Store the Git tree SHA for a repo (used by GitHub API incremental indexing).
 * The tree SHA changes whenever any file in the repo changes.
 */
export function setGitTreeSha(
  db: InstanceType<DatabaseConstructor>,
  repoId: string,
  treeSha: string,
): void {
  db.prepare('UPDATE repos SET git_tree_sha = ? WHERE id = ?').run(treeSha, repoId);
}

/**
 * Get the stored Git tree SHA for a repo, or null if not set.
 */
export function getGitTreeSha(
  db: InstanceType<DatabaseConstructor>,
  repoId: string,
): string | null {
  const row = db
    .prepare<[string], { git_tree_sha: string | null }>('SELECT git_tree_sha FROM repos WHERE id = ?')
    .get(repoId);
  return row?.git_tree_sha ?? null;
}
