/**
 * Compact test-mapping store (Phase 107, Task 665b — schema v16, additive).
 *
 * The 1.37–1.39 mapper kept one JSON row per production symbol in
 * `provider_metadata` holding every matched test file PATH and every test
 * SYMBOL ID of those files. Measured on the first coverage-needing call:
 * flutter 560 MB of rows in a 133 MB index, jenkins 83 MB in 47 MB — the
 * derived rows were 2–5x the index they described, and reading / parsing /
 * rewriting them dominated every incremental run.
 *
 * Three small tables replace that:
 *
 *  - `test_mapper_files`  test file path ↔ ordinal. Ordinals are STABLE: a
 *    new test file takes `max + 1`, a deleted one leaves a hole (its bit is
 *    cleared in every row that had it — those rows are exactly the delta
 *    targets, see test-mapper.ts). Only a forced rebuild compacts.
 *  - `test_mappings`      one row per production symbol: status, file
 *    count, and a bitset over the ordinals (NULL when no file matches).
 *    flutter: 2,415 test files → ≤ 302 bytes per matched row, ~7 MB total.
 *  - `test_name_runs`     the word runs of COMPOSITE names (`Foo.bar` →
 *    Foo, bar; a name with no run at all → ''). A delta run finds the
 *    symbols a token delta can touch with `run IN (delta)` here and
 *    `name IN (delta)` on `idx_symbols_repo_name` for plain word names,
 *    instead of reading every production symbol.
 *
 * Test SYMBOL ids are no longer stored: no tool reads them (only the web
 * API returns them) and they follow from the file list — the reader derives
 * them from the symbols table when asked.
 */
import type Database from 'better-sqlite3';

export type CoverageStatus = 'tested' | 'untested' | 'unknown';

export const TEST_MAPPING_DDL = `
CREATE TABLE IF NOT EXISTS test_mapper_files (
  repo_id   TEXT    NOT NULL,
  ord       INTEGER NOT NULL,
  file_path TEXT    NOT NULL,
  PRIMARY KEY (repo_id, ord),
  UNIQUE (repo_id, file_path),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS test_mappings (
  repo_id    TEXT    NOT NULL,
  symbol_id  TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  file_count INTEGER NOT NULL,
  files      BLOB,
  PRIMARY KEY (repo_id, symbol_id),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS test_name_runs (
  repo_id   TEXT NOT NULL,
  run       TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, run, symbol_id),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_test_name_runs_symbol ON test_name_runs(repo_id, symbol_id);
`;

const CHUNK = 500;

// ─── Bitsets ──────────────────────────────────────────────────────────────────

/** Bitset over ordinals; trailing zero bytes trimmed; no bits → null. */
export function bitsetFrom(ords: Iterable<number>): Buffer | null {
  let max = -1;
  const list: number[] = [];
  for (const o of ords) {
    list.push(o);
    if (o > max) max = o;
  }
  if (max < 0) return null;
  const buf = Buffer.alloc((max >> 3) + 1);
  for (const o of list) buf[o >> 3] |= 1 << (o & 7);
  return buf;
}

/** Ordinals set in the bitset, ascending. */
export function bitsetOrds(buf: Buffer | null | undefined): number[] {
  const out: number[] = [];
  if (!buf) return out;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] ?? 0;
    if (b === 0) continue;
    for (let k = 0; k < 8; k++) if (b & (1 << k)) out.push((i << 3) + k);
  }
  return out;
}

/** Number of set bits. */
export function bitsetCount(buf: Buffer | null | undefined): number {
  if (!buf) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i] ?? 0;
    while (b) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

/** True when both bitsets set the same ordinals (trailing zeros ignored). */
export function bitsetEquals(a: Buffer | null, b: Buffer | null): boolean {
  const la = a ? trimmedLength(a) : 0;
  const lb = b ? trimmedLength(b) : 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) if ((a as Buffer)[i] !== (b as Buffer)[i]) return false;
  return true;
}

function trimmedLength(buf: Buffer): number {
  let n = buf.length;
  while (n > 0 && buf[n - 1] === 0) n--;
  return n;
}

// ─── Ordinals ─────────────────────────────────────────────────────────────────

/** path → ordinal for every stored test file. */
export function getTestFileOrds(db: Database.Database, repoId: string): Map<string, number> {
  const rows = db
    .prepare<[string], { file_path: string; ord: number }>(
      'SELECT file_path, ord FROM test_mapper_files WHERE repo_id = ?',
    )
    .all(repoId);
  return new Map(rows.map((r) => [r.file_path, r.ord]));
}

/** Compact rebuild: ordinal = position in `paths` (call inside a transaction). */
export function replaceTestFileOrds(
  db: Database.Database,
  repoId: string,
  paths: readonly string[],
): Map<string, number> {
  db.prepare('DELETE FROM test_mapper_files WHERE repo_id = ?').run(repoId);
  const ins = db.prepare('INSERT INTO test_mapper_files (repo_id, ord, file_path) VALUES (?, ?, ?)');
  const out = new Map<string, number>();
  paths.forEach((p, i) => {
    ins.run(repoId, i, p);
    out.set(p, i);
  });
  return out;
}

/** Give a new test file the next free ordinal (`max + 1`). */
export function addTestFileOrd(db: Database.Database, repoId: string, filePath: string): number {
  const next =
    (db
      .prepare<[string], { m: number | null }>('SELECT MAX(ord) AS m FROM test_mapper_files WHERE repo_id = ?')
      .get(repoId)?.m ?? -1) + 1;
  db.prepare('INSERT INTO test_mapper_files (repo_id, ord, file_path) VALUES (?, ?, ?)').run(repoId, next, filePath);
  return next;
}

export function deleteTestFileOrd(db: Database.Database, repoId: string, filePath: string): void {
  db.prepare('DELETE FROM test_mapper_files WHERE repo_id = ? AND file_path = ?').run(repoId, filePath);
}

// ─── Mapping rows ─────────────────────────────────────────────────────────────

export interface MappingRow {
  symbolId: string;
  status: CoverageStatus;
  fileCount: number;
  /** Bitset over `test_mapper_files.ord`; null when `fileCount` is 0. */
  files: Buffer | null;
}

type RawRow = { symbol_id: string; status: CoverageStatus; file_count: number; files: Buffer | null };

function fromRaw(r: RawRow): MappingRow {
  return { symbolId: r.symbol_id, status: r.status, fileCount: r.file_count, files: r.files };
}

export function getMappingRow(db: Database.Database, repoId: string, symbolId: string): MappingRow | null {
  const r = db
    .prepare<[string, string], RawRow>(
      'SELECT symbol_id, status, file_count, files FROM test_mappings WHERE repo_id = ? AND symbol_id = ?',
    )
    .get(repoId, symbolId);
  return r ? fromRaw(r) : null;
}

export function getAllMappingRows(db: Database.Database, repoId: string): MappingRow[] {
  return db
    .prepare<[string], RawRow>('SELECT symbol_id, status, file_count, files FROM test_mappings WHERE repo_id = ?')
    .all(repoId)
    .map(fromRaw);
}

/** The cheap projection for the tools that only need tested / untested. */
export function getMappingStatuses(
  db: Database.Database,
  repoId: string,
): Array<{ symbolId: string; status: CoverageStatus; fileCount: number }> {
  return db
    .prepare<[string], { symbol_id: string; status: CoverageStatus; file_count: number }>(
      'SELECT symbol_id, status, file_count FROM test_mappings WHERE repo_id = ?',
    )
    .all(repoId)
    .map((r) => ({ symbolId: r.symbol_id, status: r.status, fileCount: r.file_count }));
}

export function getMappingRowsFor(
  db: Database.Database,
  repoId: string,
  symbolIds: readonly string[],
): Map<string, MappingRow> {
  const out = new Map<string, MappingRow>();
  for (let i = 0; i < symbolIds.length; i += CHUNK) {
    const slice = symbolIds.slice(i, i + CHUNK);
    const rows = db
      .prepare<string[], RawRow>(
        `SELECT symbol_id, status, file_count, files FROM test_mappings
         WHERE repo_id = ? AND symbol_id IN (${slice.map(() => '?').join(',')})`,
      )
      .all(repoId, ...slice);
    for (const r of rows) out.set(r.symbol_id, fromRaw(r));
  }
  return out;
}

/** Prepared upsert for a write loop (call inside a transaction). */
export function mappingWriter(db: Database.Database, repoId: string): (row: MappingRow) => void {
  const stmt = db.prepare(
    `INSERT INTO test_mappings (repo_id, symbol_id, status, file_count, files)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, symbol_id) DO UPDATE SET
       status = excluded.status, file_count = excluded.file_count, files = excluded.files`,
  );
  return (row) => {
    stmt.run(repoId, row.symbolId, row.status, row.fileCount, row.files);
  };
}

export function deleteMappingRows(db: Database.Database, repoId: string, symbolIds: readonly string[]): void {
  const stmt = db.prepare('DELETE FROM test_mappings WHERE repo_id = ? AND symbol_id = ?');
  for (const id of symbolIds) stmt.run(repoId, id);
}

export function deleteAllMappings(db: Database.Database, repoId: string): void {
  db.prepare('DELETE FROM test_mappings WHERE repo_id = ?').run(repoId);
  db.prepare('DELETE FROM test_name_runs WHERE repo_id = ?').run(repoId);
  db.prepare('DELETE FROM test_mapper_files WHERE repo_id = ?').run(repoId);
}

/** Symbol ids that have a mapping row but no symbol (deleted / re-keyed). */
export function orphanMappingIds(db: Database.Database, repoId: string): string[] {
  return db
    .prepare<[string], { symbol_id: string }>(
      `SELECT m.symbol_id FROM test_mappings m
       WHERE m.repo_id = ?
         AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.repo_id = m.repo_id AND s.id = m.symbol_id)`,
    )
    .all(repoId)
    .map((r) => r.symbol_id);
}

export function mappingCount(db: Database.Database, repoId: string): number {
  return (
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM test_mappings WHERE repo_id = ?').get(repoId)
      ?.c ?? 0
  );
}

/** Stored size of the three tables' payload (measured, not guessed). */
export function mappingBytes(db: Database.Database, repoId: string): number {
  const files =
    db
      .prepare<[string], { b: number | null }>(
        'SELECT SUM(COALESCE(LENGTH(files), 0) + LENGTH(symbol_id) + 8) AS b FROM test_mappings WHERE repo_id = ?',
      )
      .get(repoId)?.b ?? 0;
  const runs =
    db
      .prepare<[string], { b: number | null }>(
        'SELECT SUM(LENGTH(run) + LENGTH(symbol_id)) AS b FROM test_name_runs WHERE repo_id = ?',
      )
      .get(repoId)?.b ?? 0;
  return files + runs;
}

// ─── Name runs ────────────────────────────────────────────────────────────────

/** Prepared insert for a write loop (call inside a transaction). */
export function nameRunWriter(db: Database.Database, repoId: string): (run: string, symbolId: string) => void {
  const stmt = db.prepare('INSERT OR IGNORE INTO test_name_runs (repo_id, run, symbol_id) VALUES (?, ?, ?)');
  return (run, symbolId) => {
    stmt.run(repoId, run, symbolId);
  };
}

export function deleteNameRunsFor(db: Database.Database, repoId: string, symbolIds: readonly string[]): void {
  const stmt = db.prepare('DELETE FROM test_name_runs WHERE repo_id = ? AND symbol_id = ?');
  for (const id of symbolIds) stmt.run(repoId, id);
}

/** Symbol ids whose composite name has one of these runs ('' = no run at all). */
export function symbolIdsWithRuns(
  db: Database.Database,
  repoId: string,
  runs: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < runs.length; i += CHUNK) {
    const slice = runs.slice(i, i + CHUNK);
    // No DISTINCT: SQLite materialises a temp b-tree for it here (107 ms vs
    // 3 ms on flutter's 126k rows); the Set dedupes.
    const rows = db
      .prepare<string[], { symbol_id: string }>(
        `SELECT symbol_id FROM test_name_runs
         WHERE repo_id = ? AND run IN (${slice.map(() => '?').join(',')})`,
      )
      .all(repoId, ...slice);
    for (const r of rows) out.add(r.symbol_id);
  }
  return out;
}
