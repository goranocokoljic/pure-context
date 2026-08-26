/**
 * Import-record persistence (schema v10, Task 561).
 *
 * Stores every file's raw import statements so the dependency graph can be
 * re-resolved from the DB alone — no re-parsing. The motivating case: a newly
 * added file becomes the target of imports that UNCHANGED files wrote before
 * it existed; without stored records those importers' edges can never appear
 * until each importer is itself re-indexed (1.18.0 verification report,
 * runbook §7).
 *
 * Lifecycle mirrors symbols: replaced wholesale whenever a file is
 * (re)processed, deleted when the file is removed from disk.
 */
import type Database from 'better-sqlite3';
import type { ImportRecord } from '../types.js';

interface ImportRow {
  source_file: string;
  specifier: string;
  resolved_path: string | null;
  imported_names: string;
  is_type_only: number;
}

/** Replace all stored records for one source file (delete + insert). */
export function replaceImportRecords(
  db: Database.Database,
  repoId: string,
  sourceFile: string,
  records: ImportRecord[],
  tenantId = 'local',
): void {
  db.prepare('DELETE FROM import_records WHERE repo_id = ? AND source_file = ?').run(
    repoId,
    sourceFile,
  );
  if (records.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO import_records
      (repo_id, source_file, specifier, resolved_path, imported_names, is_type_only, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of records) {
    stmt.run(
      repoId,
      sourceFile,
      r.specifier,
      r.resolvedPath,
      JSON.stringify(r.importedNames ?? []),
      r.isTypeOnly ? 1 : 0,
      tenantId,
    );
  }
}

/** Remove all records for a file (deletion path). */
export function deleteImportRecordsByFile(
  db: Database.Database,
  repoId: string,
  sourceFile: string,
): void {
  db.prepare('DELETE FROM import_records WHERE repo_id = ? AND source_file = ?').run(
    repoId,
    sourceFile,
  );
}

/** Every stored import record for a repo, ready for buildGraph. */
export function getAllImportRecords(db: Database.Database, repoId: string): ImportRecord[] {
  const rows = db
    .prepare<[string], ImportRow>(
      `SELECT source_file, specifier, resolved_path, imported_names, is_type_only
       FROM import_records WHERE repo_id = ?`,
    )
    .all(repoId);
  return rows.map((row) => ({
    sourceFile: row.source_file,
    specifier: row.specifier,
    resolvedPath: row.resolved_path,
    importedNames: JSON.parse(row.imported_names) as string[],
    isTypeOnly: row.is_type_only === 1,
  }));
}
