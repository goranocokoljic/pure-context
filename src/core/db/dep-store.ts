import type Database from 'better-sqlite3';
import type { DepEdge, SymbolRecord, SymbolKind } from '../types.js';
import { StorageError } from '../errors.js';

// ─── Internal row type ────────────────────────────────────────────────────────

interface DbEdgeRow {
  id: number;
  repo_id: string;
  source_file: string;
  source_symbol_id: string | null;
  target_file: string;
  target_symbol_id: string | null;
  edge_type: string;
  specifier: string;
}

interface DbSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  signature: string;
  summary: string;
  framework_meta: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToEdge(row: DbEdgeRow): DepEdge {
  return {
    repoId: row.repo_id,
    sourceFile: row.source_file,
    sourceSymbolId: row.source_symbol_id,
    targetFile: row.target_file,
    targetSymbolId: row.target_symbol_id,
    edgeType: row.edge_type,
    specifier: row.specifier,
  };
}

function rowToSymbol(row: DbSymbolRow): SymbolRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SymbolKind,
    filePath: row.file_path,
    startByte: row.start_byte,
    endByte: row.end_byte,
    signature: row.signature,
    summary: row.summary,
    frameworkMeta: row.framework_meta
      ? (JSON.parse(row.framework_meta) as Record<string, unknown>)
      : undefined,
  };
}

// ─── Operations ───────────────────────────────────────────────────────────────

export function insertEdges(
  db: Database.Database,
  edges: DepEdge[],
  tenantId = 'local',
): void {
  if (edges.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO dep_edges
      (repo_id, source_file, source_symbol_id, target_file, target_symbol_id, edge_type, specifier, tenant_id)
    VALUES
      (@repoId, @sourceFile, @sourceSymbolId, @targetFile, @targetSymbolId, @edgeType, @specifier, @tenantId)
  `);

  const insert = db.transaction((rows: DepEdge[]) => {
    for (const e of rows) {
      try {
        stmt.run({
          repoId: e.repoId,
          sourceFile: e.sourceFile,
          sourceSymbolId: e.sourceSymbolId ?? null,
          targetFile: e.targetFile,
          targetSymbolId: e.targetSymbolId ?? null,
          edgeType: e.edgeType,
          specifier: e.specifier,
          tenantId,
        });
      } catch (err) {
        throw new StorageError(
          `Failed to insert edge ${e.sourceFile} → ${e.targetFile}`,
          'insertEdges',
          err,
        );
      }
    }
  });

  insert(edges);
}

export function deleteEdgesByFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): void {
  db.prepare(
    'DELETE FROM dep_edges WHERE repo_id = ? AND (source_file = ? OR target_file = ?)',
  ).run(repoId, filePath, filePath);
}

/** All dependency edges for a repo. */
export function getAllDepEdges(
  db: Database.Database,
  repoId: string,
  tenantId?: string,
): DepEdge[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string], DbEdgeRow>(
        'SELECT * FROM dep_edges WHERE repo_id = ? AND tenant_id = ?',
      )
      .all(repoId, tenantId)
      .map(rowToEdge);
  }
  return db
    .prepare<[string], DbEdgeRow>('SELECT * FROM dep_edges WHERE repo_id = ?')
    .all(repoId)
    .map(rowToEdge);
}

/** Files and symbols that `sourceFile` imports (forward walk, one hop). */
export function getForwardDeps(
  db: Database.Database,
  repoId: string,
  sourceFile: string,
  tenantId?: string,
): DepEdge[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, string], DbEdgeRow>(
        'SELECT * FROM dep_edges WHERE repo_id = ? AND source_file = ? AND tenant_id = ?',
      )
      .all(repoId, sourceFile, tenantId)
      .map(rowToEdge);
  }
  return db
    .prepare<[string, string], DbEdgeRow>(
      'SELECT * FROM dep_edges WHERE repo_id = ? AND source_file = ?',
    )
    .all(repoId, sourceFile)
    .map(rowToEdge);
}

/** Files and symbols that import `targetFile` (reverse walk, one hop). */
export function getReverseDeps(
  db: Database.Database,
  repoId: string,
  targetFile: string,
  tenantId?: string,
): DepEdge[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, string], DbEdgeRow>(
        'SELECT * FROM dep_edges WHERE repo_id = ? AND target_file = ? AND tenant_id = ?',
      )
      .all(repoId, targetFile, tenantId)
      .map(rowToEdge);
  }
  return db
    .prepare<[string, string], DbEdgeRow>(
      'SELECT * FROM dep_edges WHERE repo_id = ? AND target_file = ?',
    )
    .all(repoId, targetFile)
    .map(rowToEdge);
}

/** Distinct file paths that import `targetFile`. */
export function getImportersOf(
  db: Database.Database,
  repoId: string,
  targetFile: string,
  tenantId?: string,
): string[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, string], { source_file: string }>(
        'SELECT DISTINCT source_file FROM dep_edges WHERE repo_id = ? AND target_file = ? AND tenant_id = ?',
      )
      .all(repoId, targetFile, tenantId)
      .map((r) => r.source_file);
  }
  return db
    .prepare<[string, string], { source_file: string }>(
      'SELECT DISTINCT source_file FROM dep_edges WHERE repo_id = ? AND target_file = ?',
    )
    .all(repoId, targetFile)
    .map((r) => r.source_file);
}

/**
 * Returns exported symbols whose file is never imported by any other file in
 * the repo. Phase 1: file-level dead code detection.
 */
export function findDeadExports(
  db: Database.Database,
  repoId: string,
  tenantId?: string,
): SymbolRecord[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, string, string], DbSymbolRow>(`
        SELECT s.id, s.name, s.kind, s.file_path, s.start_byte, s.end_byte,
               s.signature, s.summary, s.framework_meta
        FROM symbols s
        WHERE s.repo_id = ?
          AND s.tenant_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM dep_edges e
            WHERE e.repo_id = ?
              AND e.tenant_id = ?
              AND e.target_file = s.file_path
          )
        ORDER BY s.file_path, s.start_byte
      `)
      .all(repoId, tenantId, repoId, tenantId)
      .map(rowToSymbol);
  }
  return db
    .prepare<[string, string], DbSymbolRow>(`
      SELECT s.id, s.name, s.kind, s.file_path, s.start_byte, s.end_byte,
             s.signature, s.summary, s.framework_meta
      FROM symbols s
      WHERE s.repo_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM dep_edges e
          WHERE e.repo_id = ?
            AND e.target_file = s.file_path
        )
      ORDER BY s.file_path, s.start_byte
    `)
    .all(repoId, repoId)
    .map(rowToSymbol);
}
