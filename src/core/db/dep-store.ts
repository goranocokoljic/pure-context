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

/** Delete every edge of one type for a repo (e.g. rebuild of 'di' edges). */
export function deleteEdgesByType(
  db: Database.Database,
  repoId: string,
  edgeType: string,
): void {
  db.prepare('DELETE FROM dep_edges WHERE repo_id = ? AND edge_type = ?').run(repoId, edgeType);
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

// ─── Coupling map ─────────────────────────────────────────────────────────────

export interface CouplingRow {
  filePath: string;
  efferentCoupling: number;   // Count of unique files this file imports (Ce)
  afferentCoupling: number;   // Count of unique files that import this file (Ca)
  instability: number;        // Ce / (Ce + Ca), 0=stable, 1=unstable
  efferentDeps: string[];     // File paths this file imports
  afferentDeps: string[];     // File paths that import this file
}

/**
 * Build a per-file coupling map from dep_edges.
 *
 * All edges in dep_edges are internal (external npm imports are dropped at
 * graph-build time), so no external-package filtering is needed.
 *
 * When `filePath` is provided only that file's row is returned.
 */
export function getCouplingMap(
  db: Database.Database,
  repoId: string,
  filePath?: string,
): CouplingRow[] {
  type EffRow = { source_file: string; ce: number; efferent_list: string | null };
  type AffRow = { target_file: string; ca: number; afferent_list: string | null };

  let effRows: EffRow[];
  let affRows: AffRow[];

  if (filePath !== undefined) {
    effRows = db
      .prepare<[string, string], EffRow>(`
        SELECT source_file,
               COUNT(DISTINCT target_file)       AS ce,
               GROUP_CONCAT(DISTINCT target_file) AS efferent_list
        FROM dep_edges
        WHERE repo_id = ? AND source_file = ?
        GROUP BY source_file
      `)
      .all(repoId, filePath);

    affRows = db
      .prepare<[string, string], AffRow>(`
        SELECT target_file,
               COUNT(DISTINCT source_file)       AS ca,
               GROUP_CONCAT(DISTINCT source_file) AS afferent_list
        FROM dep_edges
        WHERE repo_id = ? AND target_file = ?
        GROUP BY target_file
      `)
      .all(repoId, filePath);
  } else {
    effRows = db
      .prepare<[string], EffRow>(`
        SELECT source_file,
               COUNT(DISTINCT target_file)       AS ce,
               GROUP_CONCAT(DISTINCT target_file) AS efferent_list
        FROM dep_edges
        WHERE repo_id = ?
        GROUP BY source_file
      `)
      .all(repoId);

    affRows = db
      .prepare<[string], AffRow>(`
        SELECT target_file,
               COUNT(DISTINCT source_file)       AS ca,
               GROUP_CONCAT(DISTINCT source_file) AS afferent_list
        FROM dep_edges
        WHERE repo_id = ?
        GROUP BY target_file
      `)
      .all(repoId);
  }

  // Merge efferent and afferent into per-file records
  const map = new Map<string, CouplingRow>();

  for (const row of effRows) {
    map.set(row.source_file, {
      filePath: row.source_file,
      efferentCoupling: row.ce,
      afferentCoupling: 0,
      instability: 0,
      efferentDeps: row.efferent_list ? row.efferent_list.split(',') : [],
      afferentDeps: [],
    });
  }

  for (const row of affRows) {
    const existing = map.get(row.target_file);
    const afferentDeps = row.afferent_list ? row.afferent_list.split(',') : [];
    if (existing) {
      existing.afferentCoupling = row.ca;
      existing.afferentDeps = afferentDeps;
    } else {
      map.set(row.target_file, {
        filePath: row.target_file,
        efferentCoupling: 0,
        afferentCoupling: row.ca,
        instability: 0,
        efferentDeps: [],
        afferentDeps,
      });
    }
  }

  // Compute Martin's instability: Ce / (Ce + Ca)
  for (const row of map.values()) {
    const total = row.efferentCoupling + row.afferentCoupling;
    row.instability = total === 0 ? 0 : Math.round((row.efferentCoupling / total) * 1000) / 1000;
  }

  return Array.from(map.values());
}

// ─── get_class_hierarchy helpers ─────────────────────────────────────────────

/**
 * Find all class/interface symbols whose signature contains `extends TargetName`.
 * Used for building the descendant tree in get_class_hierarchy.
 *
 * The LIKE query is an over-approximation; callers should post-filter with a
 * word-boundary regex when exact matching is needed.
 */
export function findClassesExtending(
  db: Database.Database,
  repoId: string,
  targetName: string,
): ImplementorRow[] {
  interface RawRow {
    id: string;
    name: string;
    kind: string;
    file_path: string;
    start_byte: number;
    end_byte: number;
    signature: string;
    summary: string;
  }

  const pattern = `%extends ${targetName}%`;
  const rows = db
    .prepare<[string, string], RawRow>(`
      SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
      FROM symbols
      WHERE repo_id = ?
        AND kind IN ('class', 'interface')
        AND signature LIKE ?
    `)
    .all(repoId, pattern);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    startByte: r.start_byte,
    endByte: r.end_byte,
    signature: r.signature,
    summary: r.summary,
  }));
}

/**
 * Find a class or interface symbol by exact name.
 * Returns the first match (expected to be unique per name+kind in a repo).
 */
export function findClassOrInterfaceByName(
  db: Database.Database,
  repoId: string,
  name: string,
): ImplementorRow | null {
  interface RawRow {
    id: string;
    name: string;
    kind: string;
    file_path: string;
    start_byte: number;
    end_byte: number;
    signature: string;
    summary: string;
  }

  const row = db
    .prepare<[string, string], RawRow>(`
      SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
      FROM symbols
      WHERE repo_id = ? AND name = ? AND kind IN ('class', 'interface')
      LIMIT 1
    `)
    .get(repoId, name) as RawRow | undefined;

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    filePath: row.file_path,
    startByte: row.start_byte,
    endByte: row.end_byte,
    signature: row.signature,
    summary: row.summary,
  };
}

// ─── find_implementations ─────────────────────────────────────────────────────

export interface ImplementorRow {
  id: string;
  name: string;
  kind: string;        // 'class' | 'interface'
  filePath: string;
  startByte: number;
  endByte: number;
  signature: string;
  summary: string;
}

/**
 * Find all class / interface symbols in the repo whose signature contains
 * `implements {targetName}` or `extends {targetName}`.
 *
 * Two passes are used:
 *  1. Name-based: LIKE query on signature (fast, covers most cases).
 *  2. Import-based: check files that import the interface's file — any class
 *     there that matches is also included (catches cases where the LIKE
 *     didn't fire because the signature was truncated).
 *
 * When `includeAbstract` is false, classes with `abstract` in their signature
 * are excluded. The `limit` is applied after both passes are merged.
 */
export function findClassImplementations(
  db: Database.Database,
  repoId: string,
  targetName: string,
  targetFilePath: string,
  includeAbstract: boolean,
  limit: number,
): ImplementorRow[] {
  interface RawRow {
    id: string;
    name: string;
    kind: string;
    file_path: string;
    start_byte: number;
    end_byte: number;
    signature: string;
    summary: string;
  }

  // Pass full LIKE patterns as params — avoids SQLite || concatenation ambiguity
  const implementsPattern = `%implements ${targetName}%`;
  const extendsPattern = `%extends ${targetName}%`;

  // Pass 1 — name-based: signature LIKE `%implements TargetName%` OR `%extends TargetName%`
  const pass1Rows = db
    .prepare<[string, string, string], RawRow>(`
      SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
      FROM symbols
      WHERE repo_id = ?
        AND kind IN ('class', 'interface')
        AND (signature LIKE ? OR signature LIKE ?)
    `)
    .all(repoId, implementsPattern, extendsPattern);

  // Pass 2 — import-based: files that import the interface's file
  const importerFiles = db
    .prepare<[string, string], { source_file: string }>(`
      SELECT DISTINCT source_file FROM dep_edges
      WHERE repo_id = ? AND target_file = ?
    `)
    .all(repoId, targetFilePath)
    .map((r) => r.source_file);

  const pass1Ids = new Set(pass1Rows.map((r) => r.id));
  const extra: RawRow[] = [];

  for (const f of importerFiles) {
    const fileRows = db
      .prepare<[string, string, string, string], RawRow>(`
        SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
        FROM symbols
        WHERE repo_id = ?
          AND file_path = ?
          AND kind IN ('class', 'interface')
          AND (signature LIKE ? OR signature LIKE ?)
      `)
      .all(repoId, f, implementsPattern, extendsPattern);

    for (const row of fileRows) {
      if (!pass1Ids.has(row.id)) {
        pass1Ids.add(row.id);
        extra.push(row);
      }
    }
  }

  const allRows = [...pass1Rows, ...extra];

  // Map to ImplementorRow, optionally exclude abstract classes, then apply limit
  return allRows
    .filter((r) => includeAbstract || !r.signature.includes('abstract '))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startByte: r.start_byte,
      endByte: r.end_byte,
      signature: r.signature,
      summary: r.summary,
    }));
}

/**
 * Return the method name stems (the part after the dot) for all method symbols
 * belonging to a given class in the symbol index.
 *
 * e.g. `JwtAuthProvider.authenticate` → `'authenticate'`
 *
 * Note: interface methods are NOT indexed as separate symbols by the TypeScript
 * handler. Use `extractInterfaceMethodNames` for interface method extraction.
 */
export function getMethodNamesForSymbol(
  db: Database.Database,
  repoId: string,
  ownerName: string,
  filePath: string,
): string[] {
  const prefix = `${ownerName}.`;
  return db
    .prepare<[string, string, string], { name: string }>(`
      SELECT name FROM symbols
      WHERE repo_id = ? AND file_path = ? AND kind = 'method' AND name LIKE ?
    `)
    .all(repoId, filePath, `${prefix}%`)
    .map((r) => r.name.slice(prefix.length));
}

/**
 * Extract method/property names from an interface or abstract class body by
 * scanning the raw file content between the symbol's byte offsets.
 *
 * Used for `missingMethods` computation when interface methods are not indexed
 * as separate symbol rows.
 *
 * Strategy: scan lines within the byte range for `identifier(` patterns,
 * skipping the declaration line itself and accessor keywords.
 */
export function extractInterfaceMethodNames(
  fileContent: Buffer,
  startByte: number,
  endByte: number,
): string[] {
  const text = fileContent
    .slice(Math.max(0, startByte), Math.min(fileContent.length, endByte))
    .toString('utf8');

  const lines = text.split('\n');
  const methods: string[] = [];
  const SKIP_KEYWORDS = new Set([
    'constructor', 'get', 'set', 'if', 'for', 'while', 'switch', 'catch',
  ]);

  let isFirstLine = true;
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the declaration line (class/interface/abstract header)
    if (isFirstLine) {
      isFirstLine = false;
      continue;
    }

    // Skip blank lines, closing braces, comments
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '{' || trimmed === '}') {
      continue;
    }

    // Match method signatures: `identifier(` possibly preceded by modifiers
    const match = trimmed.match(/^(?:(?:readonly|abstract|public|protected|private|static|override)\s+)*(\w+)\s*[<(]/);
    if (match && match[1] && !SKIP_KEYWORDS.has(match[1])) {
      methods.push(match[1]);
    }
  }

  return methods;
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
