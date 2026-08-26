import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import { getSymbolsByFile, getSymbolById, getSymbolsByRepo } from '../core/db/symbol-store.js';
import { getForwardDeps, getReverseDeps, getImportersOf, findDeadExports, getAllDepEdges, findClassesExtending, findClassOrInterfaceByName } from '../core/db/dep-store.js';
import { getFileContent } from '../core/db/file-store.js';

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

// ─── Import cycle detection ───────────────────────────────────────────────────

export interface CyclePath {
  /** Ordered list of files forming the cycle (last file imports the first). */
  files: string[];
  /** Number of files in the cycle. */
  length: number;
  /** 'error' for tight 2–3-node cycles; 'warning' for longer chains. */
  severity: 'warning' | 'error';
}

export interface FindCyclesResult {
  cycles: CyclePath[];
  totalFound: number;
  /** true if maxCycles caused some results to be omitted. */
  truncated: boolean;
}

/**
 * Detect all import cycles in the repo's dependency graph.
 *
 * Algorithm: DFS with path stack. Deduplication trick: only explore paths
 * where all intermediate nodes are lexicographically greater than the starting
 * node. This ensures each cycle is found exactly once, rooted at its
 * lexicographically smallest file path, without needing a post-dedup step.
 *
 * When `filePath` is provided, only cycles involving that file are returned.
 * The `maxCycles` cap is applied after any filePath filter.
 */
export function findImportCycles(
  repoId: string,
  db: Database.Database,
  filePath?: string,
  maxCycles = 20,
  minLength = 2,
): FindCyclesResult {
  // Build adjacency list from all dep_edges (all stored edges are internal imports).
  const allEdges = getAllDepEdges(db, repoId);

  const adj = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.sourceFile === edge.targetFile) continue; // skip self-loops
    // DI edges (Phase 85) are excluded from cycle detection: Hilt's @Binds
    // pattern makes module ↔ implementation edge pairs BY DESIGN (the module
    // provides the interface and consumes the impl), so every binding would
    // report a false 2-cycle. Import cycles remain the tool's contract.
    if (edge.edgeType === 'di') continue;

    let targets = adj.get(edge.sourceFile);
    if (!targets) {
      targets = [];
      adj.set(edge.sourceFile, targets);
    }
    if (!targets.includes(edge.targetFile)) {
      targets.push(edge.targetFile);
    }
    // Ensure every target also has an entry (even if it has no outgoing edges).
    if (!adj.has(edge.targetFile)) {
      adj.set(edge.targetFile, []);
    }
  }

  // Sort each adjacency list for deterministic output.
  for (const targets of adj.values()) {
    targets.sort();
  }

  // When a filePath filter is in play we need to find enough total cycles before
  // filtering. Use a generous internal cap (at least 500) to avoid missing matches
  // on modest repos. Without a filter we can stop as soon as we have maxCycles + 1
  // (the +1 lets us detect truncation).
  const internalCap =
    filePath !== undefined ? Math.max(maxCycles * 20, 500) : maxCycles + 1;

  const found: CyclePath[] = [];

  const nodes = [...adj.keys()].sort();

  function dfs(start: string, path: string[], pathSet: Set<string>): void {
    if (found.length >= internalCap) return;
    const current = path[path.length - 1]!;
    for (const next of adj.get(current) ?? []) {
      if (found.length >= internalCap) return;

      if (next === start && path.length >= minLength) {
        // Cycle closes back to start — record it.
        found.push({
          files: [...path],
          length: path.length,
          severity: path.length <= 3 ? 'error' : 'warning',
        });
      } else if (!pathSet.has(next) && next > start) {
        // Only extend through nodes that come after start lexicographically.
        // This guarantees each cycle is discovered exactly once (rooted at the
        // lexicographically smallest node in the cycle).
        pathSet.add(next);
        path.push(next);
        dfs(start, path, pathSet);
        path.pop();
        pathSet.delete(next);
      }
    }
  }

  for (const node of nodes) {
    if (found.length >= internalCap) break;
    dfs(node, [node], new Set([node]));
  }

  // Apply filePath filter.
  const filtered =
    filePath !== undefined ? found.filter((c) => c.files.includes(filePath)) : found;

  // Apply maxCycles cap and compute truncated flag.
  const truncated = filtered.length > maxCycles;
  const cycles = filtered.slice(0, maxCycles);

  return { cycles, totalFound: cycles.length, truncated };
}

// ─── Class hierarchy ──────────────────────────────────────────────────────────

export interface HierarchyNode {
  /** null for external (unindexed) base classes/interfaces. */
  symbolId: string | null;
  name: string;
  /** null for external. */
  filePath: string | null;
  startLine: number;
  signature: string;
  isAbstract: boolean;
  isInterface: boolean;
  /** Interface names from `implements` clause (not necessarily indexed). */
  implementedInterfaces: string[];
  /** 0 = root, negative = ancestor, positive = descendant. */
  depth: number;
  children: HierarchyNode[];
}

export interface ClassHierarchyResult {
  root: HierarchyNode;
  totalNodes: number;
}

/** Extract the first parent name from `extends ClassName` in a signature. */
function parseExtendsName(signature: string): string | null {
  const m = signature.match(/\bextends\s+([A-Za-z_$][\w$]*)/);
  return m ? (m[1] ?? null) : null;
}

/** Extract interface names from `implements A, B<T>, C` in a signature. */
function parseImplementsNames(signature: string): string[] {
  const m = signature.match(/\bimplements\s+([\w$<>, ]+?)(?:\s*\{|$)/);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
}

/** Escape special regex characters in a symbol name for use in RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

function bytesToLine(content: Buffer, offset: number): number {
  const slice = content.slice(0, Math.min(offset, content.length));
  let line = 1;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0x0a) line++;
  }
  return line;
}

type SymbolLike = {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startByte: number;
  signature: string;
};

function makeHierarchyNode(
  sym: SymbolLike | null,
  externalName: string | null,
  depth: number,
  repoId: string,
  db: Database.Database,
  counter: { count: number },
): HierarchyNode {
  counter.count++;

  if (!sym) {
    return {
      symbolId: null,
      name: externalName ?? 'unknown',
      filePath: null,
      startLine: 0,
      signature: '',
      isAbstract: false,
      isInterface: false,
      implementedInterfaces: [],
      depth,
      children: [],
    };
  }

  let startLine = 1;
  const content = getFileContent(db, repoId, sym.filePath);
  if (content) {
    startLine = bytesToLine(content, sym.startByte);
  }

  return {
    symbolId: sym.id,
    name: sym.name,
    filePath: sym.filePath,
    startLine,
    signature: sym.signature,
    isAbstract: sym.signature.includes('abstract '),
    isInterface: sym.kind === 'interface',
    implementedInterfaces: parseImplementsNames(sym.signature),
    depth,
    children: [],
  };
}

/**
 * Build the full inheritance chain for a class or interface.
 *
 * - Ancestors: follows `extends` clauses upward; external base classes become
 *   leaf nodes with `symbolId: null`.
 * - Descendants: finds all classes/interfaces whose signature contains
 *   `extends TargetName` (word-boundary-checked) using a LIKE query.
 * - When `includeInterfaces` is true (default), the `implements` clause is also
 *   traversed for ancestor nodes, and interface subclasses are included as
 *   descendants.
 */
export function buildClassHierarchy(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  direction: 'ancestors' | 'descendants' | 'both',
  maxDepth: number,
  includeInterfaces: boolean,
): ClassHierarchyResult | null {
  const rootSymbol = getSymbolById(db, repoId, symbolId);
  if (!rootSymbol) return null;

  const counter = { count: 0 };
  const root = makeHierarchyNode(rootSymbol, null, 0, repoId, db, counter);

  if (direction === 'ancestors' || direction === 'both') {
    const ancestorVisited = new Set<string>([rootSymbol.id]);
    addAncestors(root, rootSymbol, 0, ancestorVisited);
  }

  if (direction === 'descendants' || direction === 'both') {
    const descVisited = new Set<string>([rootSymbol.id]);
    addDescendants(root, rootSymbol.name, 0, descVisited);
  }

  return { root, totalNodes: counter.count };

  // ── inner helpers (closures capture db, repoId, maxDepth, includeInterfaces, counter) ──

  function addAncestors(
    node: HierarchyNode,
    sym: SymbolLike,
    currentDepth: number,
    visited: Set<string>,
  ): void {
    if (Math.abs(currentDepth) >= maxDepth) return;

    const parentName = parseExtendsName(sym.signature);
    if (parentName) {
      const parentSym = findClassOrInterfaceByName(db, repoId, parentName);
      const parentDepth = currentDepth - 1;
      if (parentSym) {
        if (!visited.has(parentSym.id)) {
          visited.add(parentSym.id);
          const parentNode = makeHierarchyNode(parentSym, null, parentDepth, repoId, db, counter);
          node.children.push(parentNode);
          addAncestors(parentNode, parentSym, parentDepth, visited);
        }
      } else {
        // External base class — leaf node
        node.children.push(makeHierarchyNode(null, parentName, parentDepth, repoId, db, counter));
      }
    }

    if (includeInterfaces) {
      for (const ifaceName of parseImplementsNames(sym.signature)) {
        const ifaceSym = findClassOrInterfaceByName(db, repoId, ifaceName);
        const ifaceDepth = currentDepth - 1;
        if (ifaceSym) {
          if (!visited.has(ifaceSym.id)) {
            visited.add(ifaceSym.id);
            const ifaceNode = makeHierarchyNode(ifaceSym, null, ifaceDepth, repoId, db, counter);
            node.children.push(ifaceNode);
            // Recurse into interface ancestors too
            addAncestors(ifaceNode, ifaceSym, ifaceDepth, visited);
          }
        } else {
          node.children.push(makeHierarchyNode(null, ifaceName, ifaceDepth, repoId, db, counter));
        }
      }
    }
  }

  function addDescendants(
    node: HierarchyNode,
    name: string,
    currentDepth: number,
    visited: Set<string>,
  ): void {
    if (currentDepth >= maxDepth) return;

    // Word-boundary regex to avoid false positives (e.g. Animal vs AnimalBase)
    const nameRe = new RegExp(`\\bextends\\s+${escapeRegex(name)}\\b`);
    const candidates = findClassesExtending(db, repoId, name);
    const subclasses = candidates.filter((c) => nameRe.test(c.signature));

    for (const sub of subclasses) {
      if (visited.has(sub.id)) continue;
      if (!includeInterfaces && sub.kind === 'interface') continue;
      visited.add(sub.id);
      const subNode = makeHierarchyNode(sub, null, currentDepth + 1, repoId, db, counter);
      node.children.push(subNode);
      addDescendants(subNode, sub.name, currentDepth + 1, visited);
    }
  }
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

// ─── Call hierarchy ───────────────────────────────────────────────────────────

export interface CallNode {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  /** How many times this symbol calls / is called by its parent in the tree. */
  callCount: number;
  /** true when this node closes a cycle back to an ancestor — children are empty. */
  cyclic: boolean;
  children: CallNode[];
}

export interface CallHierarchyResult {
  root: CallNode;
  direction: 'callers' | 'callees' | 'both';
  totalNodes: number;
  /** true when maxNodes or maxDepth cut the tree short. */
  truncated: boolean;
}

// Symbol kinds that can contain function calls (skip type-only declarations).
const CALLABLE_KINDS = new Set([
  'function', 'method', 'hook', 'component', 'composable',
  'middleware', 'const', 'route', 'decorator',
]);

// Identifiers that look like calls but are language keywords / control flow.
const CALL_SKIP = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch',
  'finally', 'try', 'new', 'return', 'throw', 'typeof', 'instanceof',
  'function', 'class', 'import', 'export', 'const', 'let', 'var',
  'async', 'await', 'yield', 'delete', 'void', 'in', 'of', 'super',
  'this', 'true', 'false', 'null', 'undefined',
]);

/** Escape special regex characters for safe embedding in RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

/**
 * Extract call-target names from a block of source text.
 * Returns a Map<calleeName, occurrenceCount>.
 */
function extractCallNames(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Match any `identifier(` pattern — this over-approximates intentionally;
  // callers filter out keywords and non-symbol names afterwards.
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    if (!CALL_SKIP.has(name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Build the full call hierarchy for a function or method symbol.
 *
 * Strategy (query-time text scan):
 *  - Callees: scan the root symbol's source text for `name(` patterns, match
 *    them against all indexed symbols in the repo.
 *  - Callers: scan every callable symbol's source for references to the root
 *    symbol's name, file-content cache prevents repeated disk reads.
 *
 * The implementation does NOT require call edges in `dep_edges`; it derives
 * relationships at query time, making it safe to call on any indexed repo
 * without a re-index.
 */
export function buildCallHierarchy(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  direction: 'callers' | 'callees' | 'both',
  maxDepth: number,
  maxNodes: number,
): CallHierarchyResult | null {
  const rootSymbol = getSymbolById(db, repoId, symbolId);
  if (!rootSymbol) return null;

  // Load all symbols in the repo once (no artificial limit — we need the full set
  // to resolve callee/caller names across the codebase).
  const allSymbols = getSymbolsByRepo(db, repoId, 1_000_000);

  // Build name → SymbolRecord[] lookup. Methods are indexed as "Class.method";
  // we also key them by the short name "method" so simple `method(` calls match.
  const byName = new Map<string, SymbolRecord[]>();
  for (const sym of allSymbols) {
    const names = [sym.name];
    if (sym.name.includes('.')) {
      names.push(sym.name.split('.').pop()!);
    }
    for (const n of names) {
      const list = byName.get(n) ?? [];
      list.push(sym);
      byName.set(n, list);
    }
  }

  // File-content cache (lazy, per filePath).
  const fileCache = new Map<string, Buffer | null>();
  function getContent(filePath: string): Buffer | null {
    if (!fileCache.has(filePath)) {
      fileCache.set(filePath, getFileContent(db, repoId, filePath));
    }
    return fileCache.get(filePath) ?? null;
  }

  /** Extract the source text belonging to a symbol's byte range. */
  function symbolText(sym: SymbolRecord): string {
    const buf = getContent(sym.filePath);
    if (!buf) return '';
    return buf.slice(sym.startByte, Math.min(sym.endByte, buf.length)).toString('utf8');
  }

  /**
   * Find all distinct indexed symbols that `sym` calls.
   * Returns pairs of (callee SymbolRecord, call count).
   */
  function calleesOf(sym: SymbolRecord): Array<{ sym: SymbolRecord; count: number }> {
    const text = symbolText(sym);
    const callMap = extractCallNames(text);
    const result = new Map<string, { sym: SymbolRecord; count: number }>();

    for (const [calleeName, count] of callMap) {
      const candidates = byName.get(calleeName) ?? [];
      for (const cand of candidates) {
        // Do NOT skip self — self-calls are valid; cycle detection in expandCallees
        // handles them by marking the node cyclic: true with no children.
        if (!result.has(cand.id)) {
          result.set(cand.id, { sym: cand, count });
        }
      }
    }
    return Array.from(result.values());
  }

  /**
   * Find all distinct indexed symbols that call `sym`.
   * Returns pairs of (caller SymbolRecord, call count).
   */
  function callersOf(sym: SymbolRecord): Array<{ sym: SymbolRecord; count: number }> {
    // Short name handles both `funcName(` and `ClassName.methodName(` callee lookups.
    const targetName = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
    const re = new RegExp(`\\b${escapeRe(targetName)}\\s*\\(`, 'g');
    const result: Array<{ sym: SymbolRecord; count: number }> = [];

    for (const cand of allSymbols) {
      if (cand.id === sym.id) continue;
      if (!CALLABLE_KINDS.has(cand.kind)) continue;
      const text = symbolText(cand);
      const matches = text.match(re);
      if (matches && matches.length > 0) {
        result.push({ sym: cand, count: matches.length });
      }
    }
    return result;
  }

  // Shared counter across the entire tree build.
  const state = { totalNodes: 0, truncated: false };

  function makeNode(sym: SymbolRecord, count: number, cyclic: boolean): CallNode {
    state.totalNodes++;
    const buf = getContent(sym.filePath);
    let startLine = 1;
    if (buf) {
      startLine = bytesToLine(buf, sym.startByte);
    }
    return {
      symbolId: sym.id,
      name: sym.name,
      kind: sym.kind,
      filePath: sym.filePath,
      startLine,
      signature: sym.signature,
      callCount: count,
      cyclic,
      children: [],
    };
  }

  function expandCallees(
    node: CallNode,
    sym: SymbolRecord,
    depth: number,
    ancestors: Set<string>,
  ): void {
    if (depth >= maxDepth) return;

    const callees = calleesOf(sym);
    if (callees.length === 0) return;

    if (state.totalNodes >= maxNodes) {
      state.truncated = true;
      return;
    }

    for (const { sym: callee, count } of callees) {
      if (state.totalNodes >= maxNodes) { state.truncated = true; break; }

      if (ancestors.has(callee.id)) {
        node.children.push(makeNode(callee, count, true));
        continue;
      }

      const child = makeNode(callee, count, false);
      node.children.push(child);

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(callee.id);
      expandCallees(child, callee, depth + 1, nextAncestors);
    }
  }

  function expandCallers(
    node: CallNode,
    sym: SymbolRecord,
    depth: number,
    ancestors: Set<string>,
  ): void {
    if (depth >= maxDepth) return;

    const callers = callersOf(sym);
    if (callers.length === 0) return;

    if (state.totalNodes >= maxNodes) {
      state.truncated = true;
      return;
    }

    for (const { sym: caller, count } of callers) {
      if (state.totalNodes >= maxNodes) { state.truncated = true; break; }

      if (ancestors.has(caller.id)) {
        node.children.push(makeNode(caller, count, true));
        continue;
      }

      const child = makeNode(caller, count, false);
      node.children.push(child);

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(caller.id);
      expandCallers(child, caller, depth + 1, nextAncestors);
    }
  }

  const root = makeNode(rootSymbol, 0, false);
  const rootAncestors = new Set<string>([rootSymbol.id]);

  if (direction === 'callees' || direction === 'both') {
    expandCallees(root, rootSymbol, 0, rootAncestors);
  }
  if (direction === 'callers' || direction === 'both') {
    expandCallers(root, rootSymbol, 0, rootAncestors);
  }

  return { root, direction, totalNodes: state.totalNodes, truncated: state.truncated };
}
