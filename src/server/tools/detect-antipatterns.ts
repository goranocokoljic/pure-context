/**
 * detect_antipatterns tool — scan an indexed repo for structural anti-patterns.
 *
 * Checks:
 *   circular_dependencies — DFS cycle detection in dep_edges
 *   god_class             — classes with >500 lines or >20 methods
 *   high_coupling         — files imported by >10 (warning) or >20 (error) files
 *   dead_code             — exported symbols with zero importers
 *   deep_nesting          — symbols with nesting_depth > 5
 *   long_parameter_list   — functions/methods with param_count > 7 (warn) or > 10 (error)
 *   duplicate_code        — symbols with cosine similarity > 0.95 (requires HNSW index)
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges, findDeadExports } from '../../core/db/dep-store.js';
import { countEmbeddings, loadEmbeddings } from '../../core/db/embedding-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DepEdge } from '../../core/types.js';

// ─── Public constants (exported for tests) ────────────────────────────────────

export const CIRCULAR_DEP_SEVERITY = 'error' as const;
export const GOD_CLASS_LINE_THRESHOLD = 500;
export const GOD_CLASS_METHOD_THRESHOLD = 20;
export const HIGH_COUPLING_WARNING = 10;
export const HIGH_COUPLING_ERROR = 20;
export const DEEP_NESTING_THRESHOLD = 5;
export const LONG_PARAM_WARNING = 7;
export const LONG_PARAM_ERROR = 10;
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.95;

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const name = 'detect_antipatterns';

export const description =
  'Scan an indexed repo for structural anti-patterns: circular dependencies, ' +
  'god classes, high coupling, dead code, deep nesting, long parameter lists, ' +
  'and duplicate code (requires HNSW semantic index). ' +
  'Returns findings with severity, evidence, and actionable remediation hints. ' +
  'Intended for CI use and periodic health reviews.';

const antipatternCheckEnum = z.enum([
  'circular_dependencies',
  'god_class',
  'high_coupling',
  'dead_code',
  'deep_nesting',
  'long_parameter_list',
  'duplicate_code',
]);

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  checks: z
    .array(antipatternCheckEnum)
    .optional()
    .describe('Specific checks to run (default: all checks)'),
  severity: z
    .enum(['all', 'warning', 'error'])
    .optional()
    .describe('Filter findings by severity (default: all)'),
};

// ─── Internal types ───────────────────────────────────────────────────────────

type AntipatternCheck = z.infer<typeof antipatternCheckEnum>;

interface AntipatternFinding {
  check: AntipatternCheck;
  severity: 'warning' | 'error';
  filePath: string;
  symbolId?: string;
  symbolName?: string;
  description: string;
  evidence: string;
  suggestion: string;
}

interface DetectAntipatternsOutput {
  repoId: string;
  findingsCount: number;
  errorCount: number;
  warningCount: number;
  findings: AntipatternFinding[];
  healthScore: number;
  notes: string[];
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Pure detection functions (exported for unit testing) ─────────────────────

/**
 * Build a directed adjacency list (file → files it imports) from dep edges.
 */
export function buildAdjacencyList(edges: DepEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.sourceFile)) adj.set(edge.sourceFile, []);
    adj.get(edge.sourceFile)!.push(edge.targetFile);
    // Ensure target nodes appear in the map even without outgoing edges
    if (!adj.has(edge.targetFile)) adj.set(edge.targetFile, []);
  }
  return adj;
}

/**
 * Find all cycles in a directed graph using iterative DFS.
 * Returns unique cycles as arrays of file paths.
 */
export function findCycles(adj: Map<string, string[]>): Array<string[]> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycles: Array<string[]> = [];
  const seenCycleKeys = new Set<string>();

  for (const node of adj.keys()) {
    color.set(node, WHITE);
  }

  function dfs(startNode: string): void {
    const stack: Array<{ node: string; neighborIdx: number }> = [{ node: startNode, neighborIdx: 0 }];
    const path: string[] = [];
    const pathSet = new Set<string>();

    color.set(startNode, GRAY);
    path.push(startNode);
    pathSet.add(startNode);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];

      if (frame.neighborIdx >= neighbors.length) {
        // Done with this node — backtrack
        color.set(frame.node, BLACK);
        path.pop();
        pathSet.delete(frame.node);
        stack.pop();
        continue;
      }

      const neighbor = neighbors[frame.neighborIdx]!;
      frame.neighborIdx++;

      const neighborColor = color.get(neighbor) ?? WHITE;

      if (neighborColor === WHITE) {
        color.set(neighbor, GRAY);
        path.push(neighbor);
        pathSet.add(neighbor);
        stack.push({ node: neighbor, neighborIdx: 0 });
      } else if (neighborColor === GRAY) {
        // Back edge — found a cycle
        const cycleStart = path.indexOf(neighbor);
        const cycle = path.slice(cycleStart);

        // Normalize: rotate so the lexicographically smallest node is first
        let minIdx = 0;
        for (let i = 1; i < cycle.length; i++) {
          if (cycle[i]! < cycle[minIdx]!) minIdx = i;
        }
        const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
        const key = normalized.join('→');

        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
      }
      // BLACK: already fully processed, no new cycle via this edge
    }
  }

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Compute cosine similarity between two Float32Arrays.
 * Returns 0 if either vector is zero-length.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── DB query helpers ─────────────────────────────────────────────────────────

interface ClassRow {
  id: string;
  name: string;
  file_path: string;
  line_count: number | null;
}

interface MethodCountRow {
  file_path: string;
  method_count: number;
}

interface CouplingRow {
  target_file: string;
  importer_count: number;
}

interface MetricSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  nesting_depth: number | null;
  param_count: number | null;
}

interface EmbeddingSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
}

// ─── Check implementations ────────────────────────────────────────────────────

function checkCircularDependencies(db: Database.Database, repoId: string): AntipatternFinding[] {
  const edges = getAllDepEdges(db, repoId);
  const adj = buildAdjacencyList(edges);
  const cycles = findCycles(adj);

  return cycles.map((cycle) => ({
    check: 'circular_dependencies' as AntipatternCheck,
    severity: 'error' as const,
    filePath: cycle[0] ?? '',
    description: `Circular dependency cycle of length ${cycle.length} detected`,
    evidence: cycle.join(' → ') + ' → ' + cycle[0],
    suggestion:
      'Break the cycle by extracting shared types/interfaces into a separate module that both sides can import, ' +
      'or invert one dependency using a callback or event.',
  }));
}

function checkGodClass(db: Database.Database, repoId: string): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];

  // Classes with line_count > 500
  const largeClasses = db
    .prepare<[string, number], ClassRow>(
      `SELECT id, name, file_path, line_count
       FROM symbols
       WHERE repo_id = ? AND kind = 'class' AND line_count > ?`,
    )
    .all(repoId, GOD_CLASS_LINE_THRESHOLD);

  for (const row of largeClasses) {
    findings.push({
      check: 'god_class',
      severity: 'error',
      filePath: row.file_path,
      symbolId: row.id,
      symbolName: row.name,
      description: `Class "${row.name}" has ${row.line_count} lines (threshold: ${GOD_CLASS_LINE_THRESHOLD})`,
      evidence: `line_count = ${row.line_count}`,
      suggestion:
        'Split this class into smaller, focused classes following the Single Responsibility Principle. ' +
        'Extract cohesive groups of methods into separate classes or modules.',
    });
  }

  // Files where method count > 20 (god class by method count)
  const highMethodFiles = db
    .prepare<[string, number], MethodCountRow>(
      `SELECT file_path, COUNT(*) AS method_count
       FROM symbols
       WHERE repo_id = ? AND kind = 'method'
       GROUP BY file_path
       HAVING COUNT(*) > ?`,
    )
    .all(repoId, GOD_CLASS_METHOD_THRESHOLD);

  // Map already-found class files to avoid double-reporting
  const alreadyLarge = new Set(largeClasses.map((r) => r.file_path));

  for (const row of highMethodFiles) {
    if (alreadyLarge.has(row.file_path)) continue; // Already caught by line_count check
    // Find the class symbol in this file (if any)
    const classSymbol = db
      .prepare<[string, string], { id: string; name: string }>(
        `SELECT id, name FROM symbols WHERE repo_id = ? AND file_path = ? AND kind = 'class' LIMIT 1`,
      )
      .get(repoId, row.file_path);

    findings.push({
      check: 'god_class',
      severity: 'error',
      filePath: row.file_path,
      symbolId: classSymbol?.id,
      symbolName: classSymbol?.name,
      description: `File "${row.file_path}" has ${row.method_count} methods (threshold: ${GOD_CLASS_METHOD_THRESHOLD})`,
      evidence: `method_count = ${row.method_count}`,
      suggestion:
        'Extract groups of related methods into separate classes or service objects. ' +
        'Each class should have one primary responsibility.',
    });
  }

  return findings;
}

function checkHighCoupling(db: Database.Database, repoId: string): AntipatternFinding[] {
  const highCoupling = db
    .prepare<[string, number], CouplingRow>(
      `SELECT target_file, COUNT(DISTINCT source_file) AS importer_count
       FROM dep_edges
       WHERE repo_id = ?
       GROUP BY target_file
       HAVING COUNT(DISTINCT source_file) > ?
       ORDER BY importer_count DESC`,
    )
    .all(repoId, HIGH_COUPLING_WARNING);

  return highCoupling.map((row) => ({
    check: 'high_coupling' as AntipatternCheck,
    severity: (row.importer_count > HIGH_COUPLING_ERROR ? 'error' : 'warning') as 'warning' | 'error',
    filePath: row.target_file,
    description:
      `"${row.target_file}" is imported by ${row.importer_count} files ` +
      `(warning >${HIGH_COUPLING_WARNING}, error >${HIGH_COUPLING_ERROR})`,
    evidence: `importer_count = ${row.importer_count}`,
    suggestion:
      'Consider splitting this module into smaller, more focused modules. ' +
      'If this is intentional (e.g. a shared utility), add a barrel export to control the public API surface.',
  }));
}

function checkDeadCode(db: Database.Database, repoId: string): AntipatternFinding[] {
  const deadSymbols = findDeadExports(db, repoId);

  // Group by file to reduce noise — report one finding per file
  const byFile = new Map<string, typeof deadSymbols>();
  for (const sym of deadSymbols) {
    if (!byFile.has(sym.filePath)) byFile.set(sym.filePath, []);
    byFile.get(sym.filePath)!.push(sym);
  }

  const findings: AntipatternFinding[] = [];
  for (const [filePath, syms] of byFile) {
    findings.push({
      check: 'dead_code',
      severity: 'warning',
      filePath,
      description: `File "${filePath}" is never imported by any other file in the repo (${syms.length} symbol${syms.length === 1 ? '' : 's'})`,
      evidence: `symbols: ${syms.slice(0, 5).map((s) => s.name).join(', ')}${syms.length > 5 ? ` …+${syms.length - 5} more` : ''}`,
      suggestion:
        'Verify this file is an intended entry point. If not, remove it or wire it into the dependency graph.',
    });
  }

  return findings;
}

function checkDeepNesting(db: Database.Database, repoId: string): AntipatternFinding[] {
  const symbols = db
    .prepare<[string, number], MetricSymbolRow>(
      `SELECT id, name, kind, file_path, nesting_depth
       FROM symbols
       WHERE repo_id = ? AND nesting_depth > ? AND nesting_depth IS NOT NULL
       ORDER BY nesting_depth DESC`,
    )
    .all(repoId, DEEP_NESTING_THRESHOLD);

  return symbols.map((row) => ({
    check: 'deep_nesting' as AntipatternCheck,
    severity: 'error' as const,
    filePath: row.file_path,
    symbolId: row.id,
    symbolName: row.name,
    description: `"${row.name}" has nesting depth ${row.nesting_depth} (threshold: ${DEEP_NESTING_THRESHOLD})`,
    evidence: `nesting_depth = ${row.nesting_depth}`,
    suggestion:
      'Refactor deeply nested logic using early returns (guard clauses), extract inner blocks into helper functions, ' +
      'or replace nested conditionals with a lookup table or strategy pattern.',
  }));
}

function checkLongParameterList(db: Database.Database, repoId: string): AntipatternFinding[] {
  const symbols = db
    .prepare<[string, number], MetricSymbolRow>(
      `SELECT id, name, kind, file_path, param_count
       FROM symbols
       WHERE repo_id = ? AND param_count > ? AND param_count IS NOT NULL
         AND kind IN ('function', 'method', 'hook', 'composable', 'middleware', 'route')
       ORDER BY param_count DESC`,
    )
    .all(repoId, LONG_PARAM_WARNING);

  return symbols.map((row) => ({
    check: 'long_parameter_list' as AntipatternCheck,
    severity: ((row.param_count ?? 0) > LONG_PARAM_ERROR ? 'error' : 'warning') as 'warning' | 'error',
    filePath: row.file_path,
    symbolId: row.id,
    symbolName: row.name,
    description:
      `"${row.name}" has ${row.param_count} parameters ` +
      `(warning >${LONG_PARAM_WARNING}, error >${LONG_PARAM_ERROR})`,
    evidence: `param_count = ${row.param_count}`,
    suggestion:
      'Group related parameters into a single options/config object. ' +
      'This improves readability and makes the function easier to call with optional arguments.',
  }));
}

async function checkDuplicateCode(
  db: Database.Database,
  repoId: string,
  notes: string[],
): Promise<AntipatternFinding[]> {
  const embeddingCount = countEmbeddings(db, repoId);
  if (embeddingCount === 0) {
    notes.push(
      'duplicate_code check skipped: no semantic index found. ' +
        'Run index_folder with semantic.enabled=true to enable this check.',
    );
    return [];
  }

  // Load all embeddings
  const embeddings = loadEmbeddings(db, repoId);

  // Load symbol metadata for all embedded symbols
  const symbolIds = Array.from(embeddings.keys());
  if (symbolIds.length > 2000) {
    notes.push(
      `duplicate_code check: limited to first 2000 symbols (repo has ${symbolIds.length} embeddings) ` +
        'to avoid excessive computation.',
    );
    symbolIds.length = 2000;
  }

  if (symbolIds.length < 2) return [];

  // Fetch symbol metadata in bulk
  const placeholders = symbolIds.map(() => '?').join(',');
  const rows = db
    .prepare<string[], EmbeddingSymbolRow>(
      `SELECT id, name, kind, file_path FROM symbols
       WHERE id IN (${placeholders}) AND kind IN ('function', 'method', 'hook', 'composable')`,
    )
    .all(...symbolIds);

  // Group by kind for comparison
  const byKind = new Map<string, EmbeddingSymbolRow[]>();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind)!.push(row);
  }

  const findings: AntipatternFinding[] = [];
  const reportedPairs = new Set<string>();

  for (const [, kindRows] of byKind) {
    for (let i = 0; i < kindRows.length; i++) {
      for (let j = i + 1; j < kindRows.length; j++) {
        const a = kindRows[i]!;
        const b = kindRows[j]!;
        if (a.file_path === b.file_path) continue; // Skip same-file pairs

        const vecA = embeddings.get(a.id);
        const vecB = embeddings.get(b.id);
        if (!vecA || !vecB) continue;

        const sim = cosineSimilarity(vecA, vecB);
        if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) {
          const pairKey = [a.id, b.id].sort().join(':');
          if (!reportedPairs.has(pairKey)) {
            reportedPairs.add(pairKey);
            findings.push({
              check: 'duplicate_code',
              severity: 'warning',
              filePath: a.file_path,
              symbolId: a.id,
              symbolName: a.name,
              description:
                `"${a.name}" and "${b.name}" are ${(sim * 100).toFixed(1)}% similar ` +
                `(threshold: ${(DUPLICATE_SIMILARITY_THRESHOLD * 100).toFixed(0)}%)`,
              evidence: `similarity = ${sim.toFixed(4)}, compared with "${b.name}" in ${b.file_path}`,
              suggestion:
                'Extract shared logic into a common utility function that both call. ' +
                'Small differences can often be parameterized.',
            });
          }
        }
      }
    }
  }

  return findings;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  checks?: AntipatternCheck[];
  severity?: 'all' | 'warning' | 'error';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, checks, severity = 'all' } = args;
  const ALL_CHECKS: AntipatternCheck[] = [
    'circular_dependencies',
    'god_class',
    'high_coupling',
    'dead_code',
    'deep_nesting',
    'long_parameter_list',
    'duplicate_code',
  ];
  const activeChecks = checks ?? ALL_CHECKS;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found` }) }],
        isError: true,
      };
    }

    const findings: AntipatternFinding[] = [];
    const notes: string[] = [];

    if (activeChecks.includes('circular_dependencies')) {
      findings.push(...checkCircularDependencies(db, repoId));
    }
    if (activeChecks.includes('god_class')) {
      findings.push(...checkGodClass(db, repoId));
    }
    if (activeChecks.includes('high_coupling')) {
      findings.push(...checkHighCoupling(db, repoId));
    }
    if (activeChecks.includes('dead_code')) {
      findings.push(...checkDeadCode(db, repoId));
    }
    if (activeChecks.includes('deep_nesting')) {
      findings.push(...checkDeepNesting(db, repoId));
    }
    if (activeChecks.includes('long_parameter_list')) {
      findings.push(...checkLongParameterList(db, repoId));
    }
    if (activeChecks.includes('duplicate_code')) {
      findings.push(...(await checkDuplicateCode(db, repoId, notes)));
    }

    // Apply severity filter
    const filtered =
      severity === 'all'
        ? findings
        : findings.filter((f) => f.severity === severity);

    const errorCount = filtered.filter((f) => f.severity === 'error').length;
    const warningCount = filtered.filter((f) => f.severity === 'warning').length;

    // healthScore: 100 - (errors × 10 + warnings × 2), clamped to [0, 100]
    const healthScore = Math.max(0, Math.min(100, 100 - errorCount * 10 - warningCount * 2));

    const output: DetectAntipatternsOutput = {
      repoId,
      findingsCount: filtered.length,
      errorCount,
      warningCount,
      findings: filtered,
      healthScore,
      notes,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
