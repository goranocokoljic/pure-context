/**
 * Symbol-granular traversal (Phase 101, Task 631).
 *
 * The file walks in graph-traversal.ts answer "which FILES depend on the
 * file this symbol lives in". These walk the `symbol_refs` table (plus the
 * Phase-85 DI rows, which already carry symbol ids) and answer "which
 * SYMBOLS reference this symbol" — reverse for a blast radius, forward for a
 * context bundle — N hops, across linked indexes through the Phase-99
 * workspace (node identity `(repoId, symbolId)`, R4).
 *
 * Every consumer keeps the FILE answer as the upper bound (P1/P4): a ref is a
 * lexical match, so the symbol radius can only be a subset of the file radius
 * when both are computed over the same edges. A repo with no refs (indexed
 * before v14, or `graph.symbolEdges: 'off'`) reports `available: false` and
 * the tools fall back to the file answer.
 */
import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import { getSymbolById, getSymbolsByFile } from '../core/db/symbol-store.js';
import { getSymbolEdgesFrom, getSymbolEdgesTo } from '../core/db/dep-store.js';
import {
  countSymbolRefs,
  getCrossReverseRefs,
  getForwardRefs,
  getReferencingSymbols,
} from '../core/db/symbol-ref-store.js';
import { getFileContent } from '../core/db/file-store.js';
import type { Workspace } from './workspace-graph.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SymbolHop {
  repoId: string;
  symbol: SymbolRecord;
  /** Hops from the start symbol (0 = the start itself). */
  depth: number;
  /** Occurrences on the edge that first reached this symbol (0 for the start / DI rows). */
  refCount: number;
  /** The matched name on that edge ('' for the start; 'di:<Type>' for DI wiring). */
  via: string;
  /** The hop this one was reached from (`repoId\0symbolId`); absent on the start. */
  from?: string;
}

export interface LinkedSymbolGroup {
  repoId: string;
  rootPath: string;
  files: string[];
  symbols: SymbolRecord[];
}

export interface SymbolTraversalResult {
  /** Every reached symbol (start included), BFS order, with depth. */
  hops: SymbolHop[];
  /** Local symbols reached (start included). */
  symbols: SymbolRecord[];
  /** Distinct local files those symbols live in. */
  files: string[];
  /** Symbols reached in linked indexes, grouped per index (absent without links). */
  linked?: LinkedSymbolGroup[];
  truncated: boolean;
  tokenEstimate: number;
}

type Direction = 'forward' | 'reverse';

// ─── Availability ─────────────────────────────────────────────────────────────

/** True when this index holds at least one `ref` row (the readers' switch). */
export function symbolRefsAvailable(db: Database.Database, repoId: string): boolean {
  try {
    return countSymbolRefs(db, repoId) > 0;
  } catch {
    return false; // pre-v14 table missing on a read-only open
  }
}

// ─── Neighbours ───────────────────────────────────────────────────────────────

interface Neighbour {
  repoId: string;
  symbol: SymbolRecord;
  refCount: number;
  via: string;
}

interface Member {
  repoId: string;
  db: Database.Database;
}

function membersOf(db: Database.Database, repoId: string, ws?: Workspace): { local: Member; all: Member[]; byId: Map<string, Member> } {
  const local: Member = { repoId, db };
  const all: Member[] = [local, ...(ws?.links ?? []).map((m) => ({ repoId: m.repoId, db: m.db }))];
  return { local, all, byId: new Map(all.map((m) => [m.repoId, m])) };
}

function reverseNeighbours(node: { repoId: string; symbol: SymbolRecord }, members: ReturnType<typeof membersOf>): Neighbour[] {
  const owner = members.byId.get(node.repoId);
  if (!owner) return [];
  const out: Neighbour[] = [];
  // Local referencers (joined to symbols — a re-keyed source is skipped).
  for (const r of getReferencingSymbols(owner.db, owner.repoId, node.symbol.id)) {
    out.push({ repoId: owner.repoId, symbol: r.symbol, refCount: r.refCount, via: r.name });
  }
  // DI consumers wired to this provider.
  for (const e of getSymbolEdgesTo(owner.db, owner.repoId, node.symbol.id)) {
    const s = getSymbolById(owner.db, owner.repoId, e.sourceSymbolId!);
    if (s) out.push({ repoId: owner.repoId, symbol: s, refCount: 0, via: e.specifier });
  }
  // Referencers in every OTHER workspace member whose rows land on this node.
  for (const m of members.all) {
    if (m.repoId === node.repoId) continue;
    for (const r of getCrossReverseRefs(m.db, m.repoId, node.repoId, node.symbol.id)) {
      const s = getSymbolById(m.db, m.repoId, r.sourceSymbolId);
      if (s) out.push({ repoId: m.repoId, symbol: s, refCount: r.refCount, via: r.name });
    }
  }
  return out;
}

function forwardNeighbours(node: { repoId: string; symbol: SymbolRecord }, members: ReturnType<typeof membersOf>): Neighbour[] {
  const owner = members.byId.get(node.repoId);
  if (!owner) return [];
  const out: Neighbour[] = [];
  for (const r of getForwardRefs(owner.db, owner.repoId, node.symbol.id)) {
    const targetRepo = r.targetRepoId ?? owner.repoId;
    const m = members.byId.get(targetRepo);
    if (!m) continue; // link not in this workspace (P5) — file edge only
    const s = getSymbolById(m.db, m.repoId, r.targetSymbolId);
    if (s) out.push({ repoId: m.repoId, symbol: s, refCount: r.refCount, via: r.name });
  }
  for (const e of getSymbolEdgesFrom(owner.db, owner.repoId, node.symbol.id)) {
    const s = getSymbolById(owner.db, owner.repoId, e.targetSymbolId!);
    if (s) out.push({ repoId: owner.repoId, symbol: s, refCount: 0, via: e.specifier });
  }
  return out;
}

// ─── BFS ──────────────────────────────────────────────────────────────────────

function walk(
  start: SymbolRecord,
  repoId: string,
  db: Database.Database,
  maxDepth: number,
  direction: Direction,
  ws?: Workspace,
): SymbolTraversalResult {
  const members = membersOf(db, repoId, ws);
  const key = (r: string, id: string) => `${r}\0${id}`;
  const seen = new Set<string>([key(repoId, start.id)]);
  const hops: SymbolHop[] = [{ repoId, symbol: start, depth: 0, refCount: 0, via: '' }];
  const queue: SymbolHop[] = [hops[0]];
  let truncated = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    const next =
      direction === 'reverse' ? reverseNeighbours(node, members) : forwardNeighbours(node, members);
    for (const n of next) {
      const k = key(n.repoId, n.symbol.id);
      if (seen.has(k)) continue;
      if (node.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      seen.add(k);
      const hop: SymbolHop = {
        repoId: n.repoId,
        symbol: n.symbol,
        depth: node.depth + 1,
        refCount: n.refCount,
        via: n.via,
        from: key(node.repoId, node.symbol.id),
      };
      hops.push(hop);
      queue.push(hop);
    }
  }

  const symbols: SymbolRecord[] = [];
  const files = new Set<string>();
  const groups = new Map<string, LinkedSymbolGroup>();
  for (const h of hops) {
    if (h.repoId === repoId) {
      symbols.push(h.symbol);
      files.add(h.symbol.filePath);
      continue;
    }
    let g = groups.get(h.repoId);
    if (!g) {
      const m = ws?.member(h.repoId);
      g = { repoId: h.repoId, rootPath: m?.rootPath ?? '', files: [], symbols: [] };
      groups.set(h.repoId, g);
    }
    g.symbols.push(h.symbol);
    if (!g.files.includes(h.symbol.filePath)) g.files.push(h.symbol.filePath);
  }
  const est = (list: SymbolRecord[]) =>
    Math.ceil(list.reduce((n, s) => n + s.signature.length + s.summary.length + s.name.length, 0) / 4);
  const linked = [...groups.values()];
  return {
    hops,
    symbols,
    files: [...files],
    ...(ws && ws.links.length > 0 ? { linked } : {}),
    truncated,
    tokenEstimate: est(symbols) + linked.reduce((n, g) => n + est(g.symbols), 0),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Reverse walk: the symbols that (transitively) reference `symbolId`. */
export function getSymbolBlastRadius(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  depth = 3,
  ws?: Workspace,
): SymbolTraversalResult | null {
  const start = getSymbolById(db, repoId, symbolId);
  if (!start) return null;
  return walk(start, repoId, db, depth, 'reverse', ws);
}

/** Forward walk: the symbols `symbolId` (transitively) references. */
export function getSymbolContextBundle(
  symbolId: string,
  repoId: string,
  db: Database.Database,
  depth = 3,
  ws?: Workspace,
): SymbolTraversalResult | null {
  const start = getSymbolById(db, repoId, symbolId);
  if (!start) return null;
  return walk(start, repoId, db, depth, 'forward', ws);
}

/** One reverse hop: every symbol that references `symbolId` directly (local + linked). */
export function directReferencers(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  ws?: Workspace,
): SymbolHop[] {
  const start = getSymbolById(db, repoId, symbolId);
  if (!start) return [];
  return walk(start, repoId, db, 1, 'reverse', ws).hops.filter((h) => h.depth === 1);
}

// ─── Call-hierarchy helpers (local index) ─────────────────────────────────────

export interface CallEdge {
  sym: SymbolRecord;
  count: number;
}

/**
 * Callers of `sym` from refs (cross-file) plus a scan of `sym`'s OWN file for
 * same-file callers — refs are import-derived and never same-file (design note
 * §2.4). `callable` filters the kinds that can hold a call.
 */
export function refCallers(
  db: Database.Database,
  repoId: string,
  sym: SymbolRecord,
  callable: Set<string>,
  callPattern: (name: string) => RegExp,
): CallEdge[] {
  const out = new Map<string, CallEdge>();
  for (const r of getReferencingSymbols(db, repoId, sym.id)) {
    if (!callable.has(r.symbol.kind)) continue;
    out.set(r.symbol.id, { sym: r.symbol, count: r.refCount });
  }
  // Same-file callers by scan (bounded by one file).
  const buf = getFileContent(db, repoId, sym.filePath);
  if (buf) {
    const targetName = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
    const re = callPattern(targetName);
    for (const cand of getSymbolsByFile(db, repoId, sym.filePath)) {
      if (cand.id === sym.id || !callable.has(cand.kind) || out.has(cand.id)) continue;
      const text = buf.slice(cand.startByte, Math.min(cand.endByte, buf.length)).toString('utf8');
      const m = text.match(re);
      if (m && m.length > 0) out.set(cand.id, { sym: cand, count: m.length });
    }
  }
  return [...out.values()];
}

/**
 * Callees of `sym` from its forward refs (cross-file, kind-filtered) plus the
 * same-file candidates supplied by the caller's own name scan.
 */
export function refCallees(
  db: Database.Database,
  repoId: string,
  sym: SymbolRecord,
  callable: Set<string>,
  sameFileByScan: CallEdge[],
): CallEdge[] {
  const out = new Map<string, CallEdge>();
  for (const r of getForwardRefs(db, repoId, sym.id)) {
    if (r.targetRepoId) continue; // hierarchy tools stay local
    const t = getSymbolById(db, repoId, r.targetSymbolId);
    if (!t || !callable.has(t.kind)) continue;
    out.set(t.id, { sym: t, count: r.refCount });
  }
  for (const c of sameFileByScan) {
    if (c.sym.filePath !== sym.filePath) continue;
    if (!out.has(c.sym.id)) out.set(c.sym.id, c);
  }
  return [...out.values()];
}
