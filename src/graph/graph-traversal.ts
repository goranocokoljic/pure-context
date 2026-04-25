import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import { getSymbolsByFile, getSymbolById } from '../core/db/symbol-store.js';
import { getForwardDeps, getReverseDeps, getImportersOf, findDeadExports } from '../core/db/dep-store.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface TraversalResult {
  symbols: SymbolRecord[];
  /** Distinct files included in this result. */
  files: string[];
  /** Rough token estimate (sum of signature + summary lengths ÷ 4). */
  tokenEstimate: number;
}

export interface ImporterInfo {
  file: string;
  symbols: SymbolRecord[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reverse-walk the dependency graph from a symbol outward.
 * Returns all symbols in files that (transitively) depend on the symbol's file,
 * up to `depth` hops. Useful for assessing blast radius of a change.
 */
export function getBlastRadius(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  depth = 3,
): TraversalResult {
  const startSymbol = getSymbolById(db, repoId, symbolId);
  if (!startSymbol) return empty();

  const visitedFiles = new Set<string>();
  bfsFiles(startSymbol.filePath, repoId, db, depth, visitedFiles, 'reverse');

  return collectResult(visitedFiles, repoId, db);
}

/**
 * Forward-walk the dependency graph from a symbol's file.
 * Returns the symbol itself plus all symbols in transitively imported files,
 * up to `depth` hops. Useful for gathering context needed to understand a symbol.
 */
export function getContextBundle(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  depth = 3,
): TraversalResult {
  const startSymbol = getSymbolById(db, repoId, symbolId);
  if (!startSymbol) return empty();

  const visitedFiles = new Set<string>();
  bfsFiles(startSymbol.filePath, repoId, db, depth, visitedFiles, 'forward');

  return collectResult(visitedFiles, repoId, db);
}

/**
 * Return distinct files that import `filePath`, along with the symbols
 * defined in each importing file.
 */
export function findImporters(
  filePath: string,
  repoId: string,
  db: Database.Database,
): ImporterInfo[] {
  const importerFiles = getImportersOf(db, repoId, filePath);
  return importerFiles.map((file) => ({
    file,
    symbols: getSymbolsByFile(db, repoId, file),
  }));
}

/**
 * Symbols in files that are never imported by any other file in the repo.
 * Delegates to the dep-store query.
 */
export function findDeadCode(
  repoId: string,
  db: Database.Database,
): SymbolRecord[] {
  return findDeadExports(db, repoId);
}

// ─── BFS helpers ─────────────────────────────────────────────────────────────

type Direction = 'forward' | 'reverse';

function bfsFiles(
  startFile: string,
  repoId: string,
  db: Database.Database,
  maxDepth: number,
  visited: Set<string>,
  direction: Direction,
): void {
  // Queue entries: [filePath, currentDepth]
  const queue: Array<[string, number]> = [[startFile, 0]];

  while (queue.length > 0) {
    const [file, depth] = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    if (depth >= maxDepth) continue;

    const edges =
      direction === 'forward'
        ? getForwardDeps(db, repoId, file)
        : getReverseDeps(db, repoId, file);

    for (const edge of edges) {
      const next = direction === 'forward' ? edge.targetFile : edge.sourceFile;
      if (!visited.has(next)) {
        queue.push([next, depth + 1]);
      }
    }
  }
}

function collectResult(
  files: Set<string>,
  repoId: string,
  db: Database.Database,
): TraversalResult {
  const symbols: SymbolRecord[] = [];
  for (const file of files) {
    symbols.push(...getSymbolsByFile(db, repoId, file));
  }
  return {
    symbols,
    files: [...files],
    tokenEstimate: estimateTokens(symbols),
  };
}

function estimateTokens(symbols: SymbolRecord[]): number {
  let chars = 0;
  for (const s of symbols) {
    chars += s.signature.length + s.summary.length + s.name.length;
  }
  return Math.ceil(chars / 4);
}

function empty(): TraversalResult {
  return { symbols: [], files: [], tokenEstimate: 0 };
}

// ─── Blast radius with depth info (used by web UI) ────────────────────────────

export interface BlastRadiusEntry {
  filePath: string;
  depth: number;
  symbolCount: number;
  symbols: Pick<SymbolRecord, 'id' | 'name' | 'kind' | 'signature' | 'summary'>[];
}

export interface BlastRadiusWithDepths {
  symbolId: string;
  symbolName: string;
  symbolKind: string;
  sourceFile: string;
  totalFiles: number;
  totalSymbols: number;
  entries: BlastRadiusEntry[];
}

/**
 * Reverse-walk the dependency graph from a symbol, returning each affected file
 * annotated with its hop distance from the source. Used by the web UI radial
 * blast radius visualization.
 */
export function getBlastRadiusWithDepths(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  maxDepth = 3,
): BlastRadiusWithDepths | null {
  const startSymbol = getSymbolById(db, repoId, symbolId);
  if (!startSymbol) return null;

  // BFS — track first-seen depth per file
  const depthMap = new Map<string, number>();
  const queue: Array<[string, number]> = [[startSymbol.filePath, 0]];

  while (queue.length > 0) {
    const [file, depth] = queue.shift()!;
    if (depthMap.has(file)) continue;
    depthMap.set(file, depth);
    if (depth >= maxDepth) continue;
    const edges = getReverseDeps(db, repoId, file);
    for (const edge of edges) {
      if (!depthMap.has(edge.sourceFile)) {
        queue.push([edge.sourceFile, depth + 1]);
      }
    }
  }

  const entries: BlastRadiusEntry[] = [];
  let totalSymbols = 0;

  for (const [filePath, depth] of depthMap) {
    const syms = getSymbolsByFile(db, repoId, filePath);
    totalSymbols += syms.length;
    entries.push({
      filePath,
      depth,
      symbolCount: syms.length,
      symbols: syms.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        summary: s.summary,
      })),
    });
  }

  return {
    symbolId,
    symbolName: startSymbol.name,
    symbolKind: startSymbol.kind,
    sourceFile: startSymbol.filePath,
    totalFiles: depthMap.size,
    totalSymbols,
    entries: entries.sort((a, b) => a.depth - b.depth || a.filePath.localeCompare(b.filePath)),
  };
}
