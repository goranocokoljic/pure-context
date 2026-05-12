/**
 * check-move-safe.ts
 *
 * MCP tool: check_move_safe
 *
 * Pre-flight check for moving a file to a new location. Returns:
 *   - All import statements that need updating (importUpdates), with exact
 *     current and new paths, plus the line number of each import.
 *   - Whether the move would introduce import cycles at the new location
 *     (wouldIntroduceCycles).
 *
 * Safety definition:
 *   safe: false — if the move would place the file in an existing import cycle
 *                 (the cycle moves with the file to its new location).
 *   safe: true  — if all affected imports can be updated mechanically and the
 *                 new location has no cycle involvement.
 *
 * Note: all moves are mechanically doable — the only hard blocker is cycle
 * risk. `importUpdates` is the primary output: an exact checklist of the
 * import statements that must be updated after the move.
 */

import { z } from 'zod';
import { dirname, extname, relative, sep } from 'path';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getFileContent } from '../../core/db/file-store.js';
import { getImportersOf, getAllDepEdges } from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import type { DepEdge } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

export const name = 'check_move_safe';

export const description =
  'Pre-flight check for moving a file to a new location. Returns a checklist of ' +
  'import statements that need updating (importUpdates) plus cycle-risk analysis ' +
  '(wouldIntroduceCycles). ' +
  'safe: false only when the move would place the file inside an existing import cycle. ' +
  'All moves are mechanically doable — importUpdates gives you the exact edits needed. ' +
  'Use find_importers to preview which files depend on a module before moving it.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .describe('Current file path relative to the repo root (e.g. "src/utils/hash.ts")'),
  newFilePath: z
    .string()
    .describe('Proposed new location relative to the repo root (e.g. "src/core/hash.ts")'),
  checkCycles: z
    .boolean()
    .optional()
    .describe(
      'Simulate the move in the dependency graph and detect any import cycles ' +
      'that would involve the new location. Default true.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportUpdate {
  importerFilePath: string;
  currentImportPath: string;
  newImportPath: string;
  line: number;
}

interface CheckMoveSafeOutput {
  safe: boolean;
  verdict: string;
  filePath: string;
  newFilePath: string;
  importUpdates: ImportUpdate[];
  importUpdateCount: number;
  newCycles: string[][];
  wouldIntroduceCycles: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize path separators to forward slashes. */
function normalizeSep(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Compute the new import specifier from `importerFilePath` to `newTargetPath`,
 * preserving whether the original specifier had a file extension.
 *
 * Examples:
 *   importerFilePath = 'src/main.ts', newTargetPath = 'src/core/hash.ts',
 *   currentSpecifier = './utils/hash'
 *   → './core/hash' (no extension, matching original)
 *
 *   importerFilePath = 'src/deep/nested/consumer.ts', newTargetPath = 'src/deep/parser.ts',
 *   currentSpecifier = '../../lib/parser'
 *   → '../parser'
 */
function computeNewImportPath(
  importerFilePath: string,
  newTargetPath: string,
  currentSpecifier: string,
): string {
  const importerDir = dirname(importerFilePath);
  const rawRelative = normalizeSep(relative(normalizeSep(importerDir), normalizeSep(newTargetPath)));

  // Add './' prefix when the path doesn't start with '../'
  const withPrefix = rawRelative.startsWith('../') ? rawRelative : `./${rawRelative}`;

  // Match extension presence from the original specifier
  if (!extname(currentSpecifier)) {
    // Original had no extension → strip extension from computed path
    const ext = extname(withPrefix);
    return ext ? withPrefix.slice(0, -ext.length) : withPrefix;
  }

  return withPrefix;
}

/** Find the 1-based line number of the first import containing `specifier`. */
function findImportLine(content: Buffer | null, specifier: string): number {
  if (!content) return 0;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  // Match the raw specifier surrounded by any quote character
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`['"\`]${escaped}['"\`]`);

  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 1;
  }
  return 0;
}

/**
 * Get the import specifier used by `importerFile` when importing `targetFile`.
 * Returns the first matching edge's specifier, or an empty string if not found.
 */
function getSpecifier(
  db: Database.Database,
  repoId: string,
  importerFile: string,
  targetFile: string,
): string {
  const row = db
    .prepare<[string, string, string], { specifier: string }>(
      `SELECT specifier FROM dep_edges
       WHERE repo_id = ? AND source_file = ? AND target_file = ?
       LIMIT 1`,
    )
    .get(repoId, importerFile, targetFile);
  return row?.specifier ?? '';
}

/**
 * Detect all import cycles in a modified dependency graph where `oldPath` has
 * been renamed to `newPath`. Returns cycles that involve `newPath`.
 *
 * Uses the same DFS algorithm as findImportCycles: each cycle is reported
 * exactly once, rooted at its lexicographically smallest file.
 */
function detectCyclesAfterMove(
  edges: DepEdge[],
  oldPath: string,
  newPath: string,
  maxCycles = 20,
): string[][] {
  // Build adjacency list with oldPath renamed to newPath
  const adj = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.sourceFile === edge.targetFile) continue;
    const src = edge.sourceFile === oldPath ? newPath : edge.sourceFile;
    const tgt = edge.targetFile === oldPath ? newPath : edge.targetFile;
    if (src === tgt) continue;

    const srcList = adj.get(src) ?? [];
    if (!srcList.includes(tgt)) srcList.push(tgt);
    adj.set(src, srcList);
    if (!adj.has(tgt)) adj.set(tgt, []);
  }

  for (const v of adj.values()) v.sort();

  const found: string[][] = [];
  const cap = maxCycles + 1;
  const nodes = [...adj.keys()].sort();

  function dfs(start: string, path: string[], pathSet: Set<string>): void {
    if (found.length >= cap) return;
    const cur = path[path.length - 1]!;
    for (const next of adj.get(cur) ?? []) {
      if (found.length >= cap) return;
      if (next === start && path.length >= 2) {
        found.push([...path]);
      } else if (!pathSet.has(next) && next > start) {
        pathSet.add(next);
        path.push(next);
        dfs(start, path, pathSet);
        path.pop();
        pathSet.delete(next);
      }
    }
  }

  for (const node of nodes) {
    if (found.length >= cap) break;
    dfs(node, [node], new Set([node]));
  }

  // Return only cycles that involve the new (moved) path, capped at maxCycles
  return found.filter((c) => c.includes(newPath)).slice(0, maxCycles);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath: string;
  newFilePath: string;
  checkCycles?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, filePath, newFilePath, checkCycles = true } = args;

  // Normalize separators so the paths match what's stored in the DB
  const normalizedFilePath = normalizeSep(filePath);
  const normalizedNewFilePath = normalizeSep(newFilePath);

  if (normalizedFilePath === normalizedNewFilePath) {
    const output: CheckMoveSafeOutput = {
      safe: true,
      verdict: 'Safe to move: source and destination paths are the same (no-op).',
      filePath: normalizedFilePath,
      newFilePath: normalizedNewFilePath,
      importUpdates: [],
      importUpdateCount: 0,
      newCycles: [],
      wouldIntroduceCycles: false,
      _tokenEstimate: 0,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 1. Find all direct importers ──────────────────────────────────────────

    const importerFiles = getImportersOf(db, repoId, normalizedFilePath);

    // ── 2. Build ImportUpdate list ────────────────────────────────────────────

    const importUpdates: ImportUpdate[] = [];

    for (const importerFilePath of importerFiles) {
      const specifier = getSpecifier(db, repoId, importerFilePath, normalizedFilePath);
      if (!specifier) continue; // edge without specifier — skip

      const newImportPath = computeNewImportPath(
        importerFilePath,
        normalizedNewFilePath,
        specifier,
      );

      const content = getFileContent(db, repoId, importerFilePath);
      const line = findImportLine(content, specifier);

      importUpdates.push({
        importerFilePath,
        currentImportPath: specifier,
        newImportPath,
        line,
      });
    }

    // Sort by importer path for deterministic output
    importUpdates.sort((a, b) => a.importerFilePath.localeCompare(b.importerFilePath));

    // ── 3. Cycle detection ────────────────────────────────────────────────────

    let newCycles: string[][] = [];

    if (checkCycles) {
      const allEdges = getAllDepEdges(db, repoId);
      newCycles = detectCyclesAfterMove(allEdges, normalizedFilePath, normalizedNewFilePath);
    }

    const wouldIntroduceCycles = newCycles.length > 0;

    // ── 4. Verdict ────────────────────────────────────────────────────────────

    const safe = !wouldIntroduceCycles;

    let verdict: string;
    if (safe) {
      const count = importUpdates.length;
      if (count === 0) {
        verdict = 'Safe to move: no importers found. No import statements need updating.';
      } else {
        verdict =
          `Safe to move: ${count} import statement${count !== 1 ? 's' : ''} will need updating across ` +
          `${new Set(importUpdates.map((u) => u.importerFilePath)).size} file${importUpdates.length !== 1 ? 's' : ''}. No cycles.`;
      }
    } else {
      verdict =
        `Move introduces ${newCycles.length} import cycle${newCycles.length !== 1 ? 's' : ''} at the new location. ` +
        `${importUpdates.length} import statement${importUpdates.length !== 1 ? 's' : ''} also need updating.`;
    }

    const responseText = JSON.stringify({ importUpdates, newCycles });
    const output: CheckMoveSafeOutput = {
      safe,
      verdict,
      filePath: normalizedFilePath,
      newFilePath: normalizedNewFilePath,
      importUpdates,
      importUpdateCount: importUpdates.length,
      newCycles,
      wouldIntroduceCycles,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  } finally {
    db.close();
  }
}
