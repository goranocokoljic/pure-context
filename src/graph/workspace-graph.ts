/**
 * Workspace graph (Phase 99, Task 616): traversal over an index AND the
 * indexes it links to.
 *
 * A file identity is `{ repoId, path }`. Local files keep bare paths in every
 * output (P3 — a repo with zero links is byte-identical to pre-99); files
 * reached through a link carry their owning index. Forward hops follow a
 * cross edge into the linked database and continue the walk THERE (that
 * index's local edges, and its own cross edges to indexes that are ALSO in
 * this workspace). Reverse hops ask each database in the workspace for edges
 * whose `target_repo_id` names the current node's index (the v12 index makes
 * that a point lookup). Depth and `truncated` semantics are unchanged.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import { getIndexDir, openDatabase } from '../core/db/schema.js';
import { getRepoLinks } from '../core/db/link-store.js';
import { getSymbolsByFile } from '../core/db/symbol-store.js';
import { getFileSizesBatch } from '../core/db/file-store.js';
import {
  getAllDepEdges,
  getCrossDepEdges,
  getCrossImportersOf,
  getForwardDeps,
  getImportersOf,
  getReverseDeps,
} from '../core/db/dep-store.js';

// ─── Workspace handle ─────────────────────────────────────────────────────────

export interface WorkspaceMember {
  repoId: string;
  rootPath: string;
  db: Database.Database;
}

export interface Workspace {
  local: WorkspaceMember;
  /** Linked indexes that could be opened, in stored (root-path) order. */
  links: WorkspaceMember[];
  /** Links recorded but whose index file is gone — cross edges into them dangle. */
  missing: Array<{ repoId: string; rootPath: string }>;
  member(repoId: string): WorkspaceMember | undefined;
  /** Close the LINKED handles only — the local `db` belongs to the caller. */
  close(): void;
}

/**
 * Open the workspace for `(db, repoId)` from its stored `repo_links`. A repo
 * with no links yields `links: []` and every traversal below takes the
 * pre-99 code path exactly.
 */
export function openWorkspace(db: Database.Database, repoId: string, rootPath = ''): Workspace {
  const links: WorkspaceMember[] = [];
  const missing: Array<{ repoId: string; rootPath: string }> = [];
  let stored: ReturnType<typeof getRepoLinks> = [];
  try {
    stored = getRepoLinks(db, repoId);
  } catch {
    stored = []; // pre-v12 DB opened read-only elsewhere — no table yet
  }
  for (const l of stored) {
    if (!existsSync(join(getIndexDir(), `${l.linkedRepoId}.db`))) {
      missing.push({ repoId: l.linkedRepoId, rootPath: l.linkedRootPath });
      continue;
    }
    try {
      links.push({ repoId: l.linkedRepoId, rootPath: l.linkedRootPath, db: openDatabase(l.linkedRepoId) });
    } catch {
      missing.push({ repoId: l.linkedRepoId, rootPath: l.linkedRootPath });
    }
  }
  const local: WorkspaceMember = { repoId, rootPath, db };
  const byId = new Map<string, WorkspaceMember>([[repoId, local], ...links.map((m) => [m.repoId, m] as const)]);
  return {
    local,
    links,
    missing,
    member: (id) => byId.get(id),
    close() {
      for (const m of links) {
        try {
          m.db.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

// ─── Node identity ────────────────────────────────────────────────────────────

export interface FileNode {
  repoId: string;
  path: string;
}

const keyOf = (n: FileNode) => `${n.repoId}\0${n.path}`;

// ─── BFS ──────────────────────────────────────────────────────────────────────

export type Direction = 'forward' | 'reverse';

export interface WorkspaceWalk {
  /** Every visited node (start included), in BFS order. */
  visited: FileNode[];
  truncated: boolean;
}

/**
 * BFS over the workspace from a LOCAL start file. Mirrors `bfsFiles` in
 * graph-traversal.ts (same queue discipline, same truncation rule) with the
 * node identity widened to `(repoId, path)`.
 */
export function walkWorkspace(
  ws: Workspace,
  startFile: string,
  maxDepth: number,
  direction: Direction,
): WorkspaceWalk {
  const start: FileNode = { repoId: ws.local.repoId, path: startFile };
  const queue: Array<[FileNode, number]> = [[start, 0]];
  const seen = new Set<string>();
  const visited: FileNode[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const [node, depth] = queue.shift()!;
    const k = keyOf(node);
    if (seen.has(k)) continue;
    seen.add(k);
    visited.push(node);

    for (const next of neighbors(ws, node, direction)) {
      if (seen.has(keyOf(next))) continue;
      if (depth >= maxDepth) {
        truncated = true;
      } else {
        queue.push([next, depth + 1]);
      }
    }
  }
  return { visited, truncated };
}

function neighbors(ws: Workspace, node: FileNode, direction: Direction): FileNode[] {
  const owner = ws.member(node.repoId);
  if (!owner) return [];
  const out: FileNode[] = [];
  if (direction === 'forward') {
    for (const e of getForwardDeps(owner.db, owner.repoId, node.path, undefined, true)) {
      if (e.targetRepoId) {
        // Follow only into indexes that are part of THIS workspace (P5).
        if (ws.member(e.targetRepoId)) out.push({ repoId: e.targetRepoId, path: e.targetFile });
      } else {
        out.push({ repoId: owner.repoId, path: e.targetFile });
      }
    }
    return out;
  }
  // reverse: local importers in the node's own index …
  for (const e of getReverseDeps(owner.db, owner.repoId, node.path)) {
    out.push({ repoId: owner.repoId, path: e.sourceFile });
  }
  // … plus every OTHER member's cross edges that land on this node.
  for (const m of [ws.local, ...ws.links]) {
    if (m.repoId === node.repoId) continue;
    for (const src of getCrossImportersOf(m.db, m.repoId, node.repoId, node.path)) {
      out.push({ repoId: m.repoId, path: src });
    }
  }
  return out;
}

// ─── Collection helpers ───────────────────────────────────────────────────────

export interface LinkedFileGroup {
  repoId: string;
  rootPath: string;
  files: string[];
  symbols: SymbolRecord[];
}

/** Split a walk into local files and per-linked-index groups (with symbols). */
export function collectWalk(ws: Workspace, walk: WorkspaceWalk): {
  localFiles: string[];
  localSymbols: SymbolRecord[];
  linked: LinkedFileGroup[];
} {
  const localFiles: string[] = [];
  const localSymbols: SymbolRecord[] = [];
  const groups = new Map<string, LinkedFileGroup>();
  for (const n of walk.visited) {
    const m = ws.member(n.repoId);
    if (!m) continue;
    if (n.repoId === ws.local.repoId) {
      localFiles.push(n.path);
      localSymbols.push(...getSymbolsByFile(m.db, m.repoId, n.path));
      continue;
    }
    let g = groups.get(n.repoId);
    if (!g) {
      g = { repoId: m.repoId, rootPath: m.rootPath, files: [], symbols: [] };
      groups.set(n.repoId, g);
    }
    g.files.push(n.path);
    g.symbols.push(...getSymbolsByFile(m.db, m.repoId, n.path));
  }
  return { localFiles, localSymbols, linked: [...groups.values()] };
}

/** Raw byte size of files across the workspace (for `_meta.rawBytes`). */
export function workspaceRawBytes(ws: Workspace, nodes: FileNode[]): number {
  const byRepo = new Map<string, string[]>();
  for (const n of nodes) {
    const list = byRepo.get(n.repoId) ?? [];
    list.push(n.path);
    byRepo.set(n.repoId, list);
  }
  let total = 0;
  for (const [id, paths] of byRepo) {
    const m = ws.member(id);
    if (!m) continue;
    const sizes = getFileSizesBatch(m.db, m.repoId, paths);
    for (const p of paths) total += sizes.get(p) ?? 0;
  }
  return total;
}

// ─── Reverse one-hop across the seam (find_importers) ─────────────────────────

export interface LinkedImporter {
  repoId: string;
  rootPath: string;
  file: string;
  symbols: SymbolRecord[];
}

/** Files in LINKED indexes that import the local `filePath` directly. */
export function findLinkedImporters(ws: Workspace, filePath: string): LinkedImporter[] {
  const out: LinkedImporter[] = [];
  for (const m of ws.links) {
    for (const src of getCrossImportersOf(m.db, m.repoId, ws.local.repoId, filePath)) {
      out.push({ repoId: m.repoId, rootPath: m.rootPath, file: src, symbols: getSymbolsByFile(m.db, m.repoId, src) });
    }
  }
  return out;
}

/** Local importers, kept here so consumers have one module for both sides. */
export function findLocalImporterFiles(ws: Workspace, filePath: string): string[] {
  return getImportersOf(ws.local.db, ws.local.repoId, filePath);
}

/**
 * Files of the LOCAL index that some linked index imports (any file). Used to
 * keep `find_dead_code` from calling a cross-imported file dead.
 */
export function crossImportedLocalFiles(ws: Workspace): Set<string> {
  const out = new Set<string>();
  for (const m of ws.links) {
    const rows = m.db
      .prepare<[string, string], { target_file: string }>(
        'SELECT DISTINCT target_file FROM dep_edges WHERE repo_id = ? AND target_repo_id = ?',
      )
      .all(m.repoId, ws.local.repoId);
    for (const r of rows) out.add(r.target_file);
  }
  return out;
}

// ─── Phase 102: one union adjacency for cycles / layers / coupling / render ──

/** `${repoId}\0${path}` — the node identity used by `workspaceAdjacency`. */
export const nodeKey = keyOf;

export function parseNodeKey(key: string): FileNode {
  const i = key.indexOf('\0');
  return i < 0 ? { repoId: '', path: key } : { repoId: key.slice(0, i), path: key.slice(i + 1) };
}

/**
 * Display name of a node outside the local index — the `get_graph` convention
 * (`<linkedRepoId>:<path>`). Local nodes stay bare so a repo with no links is
 * byte-identical to the local-only reader (P1).
 */
export function displayNode(ws: Workspace, n: FileNode): string {
  return n.repoId === ws.local.repoId ? n.path : `${n.repoId}:${n.path}`;
}

/**
 * Short human root label for a linked index: the basename of its root path,
 * or the repo id when two links share a basename. Used by the layer-rule
 * prefix form (`<rootName>:<glob>`, Task 637) and diagram labels.
 */
export function rootLabels(ws: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  const counts = new Map<string, number>();
  const nameOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  for (const m of ws.links) counts.set(nameOf(m.rootPath), (counts.get(nameOf(m.rootPath)) ?? 0) + 1);
  for (const m of ws.links) {
    const n = nameOf(m.rootPath);
    out.set(m.repoId, (counts.get(n) ?? 0) > 1 ? m.repoId : n);
  }
  return out;
}

export interface WorkspaceEdge {
  source: FileNode;
  target: FileNode;
  edgeType: string;
  specifier: string;
}

export interface WorkspaceAdjacency {
  /** Every distinct (source, target, specifier) edge of every member, cross rows included. */
  edges: WorkspaceEdge[];
  /** node key → sorted, de-duplicated neighbour keys (source → target). Every target key has an entry. */
  adj: Map<string, string[]>;
  /** node key → node. */
  nodes: Map<string, FileNode>;
}

export interface AdjacencyOptions {
  /** Edge types to drop (default: `['di']` — Hilt @Binds pairs are 2-cycles by design). */
  excludeEdgeTypes?: string[];
  /** true (default): drop `a → a`. */
  skipSelfLoops?: boolean;
  /**
   * 'all' (default) — local + cross edges of every member (the union graph);
   * 'local-source' — only edges whose SOURCE is the local index (its local
   * rows and its own cross rows): what a per-root rule set may judge.
   */
  scope?: 'all' | 'local-source';
}

/**
 * The union file graph over the workspace (P2 — the ONE builder every
 * cross-aware reader consumes). Nodes are `(repoId, path)`; a cross row of a
 * member is followed only when its target index is also a member. Built per
 * call: one `SELECT * FROM dep_edges` scan per member.
 */
export function workspaceAdjacency(ws: Workspace, opts: AdjacencyOptions = {}): WorkspaceAdjacency {
  const exclude = new Set(opts.excludeEdgeTypes ?? ['di']);
  const skipSelf = opts.skipSelfLoops ?? true;
  const members = opts.scope === 'local-source' ? [ws.local] : [ws.local, ...ws.links];
  const edges: WorkspaceEdge[] = [];
  const seen = new Set<string>();
  const nodes = new Map<string, FileNode>();
  const adjSets = new Map<string, Set<string>>();

  const add = (source: FileNode, target: FileNode, edgeType: string, specifier: string) => {
    if (exclude.has(edgeType)) return;
    const sk = keyOf(source);
    const tk = keyOf(target);
    if (skipSelf && sk === tk) return;
    const ek = `${sk}\0${tk}\0${specifier}`;
    if (seen.has(ek)) return;
    seen.add(ek);
    edges.push({ source, target, edgeType, specifier });
    if (!nodes.has(sk)) nodes.set(sk, source);
    if (!nodes.has(tk)) nodes.set(tk, target);
    let s = adjSets.get(sk);
    if (!s) {
      s = new Set();
      adjSets.set(sk, s);
    }
    s.add(tk);
    if (!adjSets.has(tk)) adjSets.set(tk, new Set());
  };

  for (const m of members) {
    for (const e of getAllDepEdges(m.db, m.repoId)) {
      add({ repoId: m.repoId, path: e.sourceFile }, { repoId: m.repoId, path: e.targetFile }, e.edgeType, e.specifier);
    }
    for (const e of getCrossDepEdges(m.db, m.repoId)) {
      if (!e.targetRepoId || !ws.member(e.targetRepoId)) continue; // dangling / outside the workspace
      add({ repoId: m.repoId, path: e.sourceFile }, { repoId: e.targetRepoId, path: e.targetFile }, e.edgeType, e.specifier);
    }
  }

  const adj = new Map<string, string[]>();
  for (const [k, s] of adjSets) adj.set(k, [...s].sort());
  return { edges, adj, nodes };
}

// ─── Phase 102 (Task 636): symbol-level keep-alive across the seam ───────────

export interface CrossRef {
  repoId: string;
  rootPath: string;
  file: string;
}

export interface CrossReferencedFile {
  filePath: string;
  /** Linked files that import this file (file-level rows). */
  referencedBy: CrossRef[];
  /**
   * Per local symbol id: linked files that NAME it — Phase 101 `symbol_refs`
   * rows when the linked index has them, else the `imported_names` of the
   * import record behind the cross edge. A symbol absent here is kept alive
   * by the file import only.
   */
  symbolRefs: Map<string, CrossRef[]>;
}

/**
 * Local files some LINKED index imports, with the symbol-level evidence
 * behind each. Keyed by local path. Empty when nothing links.
 */
export function crossReferencedLocalFiles(ws: Workspace): Map<string, CrossReferencedFile> {
  const out = new Map<string, CrossReferencedFile>();
  if (ws.links.length === 0) return out;
  const entry = (file: string): CrossReferencedFile => {
    let e = out.get(file);
    if (!e) {
      e = { filePath: file, referencedBy: [], symbolRefs: new Map() };
      out.set(file, e);
    }
    return e;
  };
  const pushRef = (list: CrossRef[], ref: CrossRef) => {
    if (!list.some((r) => r.repoId === ref.repoId && r.file === ref.file)) list.push(ref);
  };
  // Local symbols by (file, name) for the name-match fallback.
  let byFileName: Map<string, string> | null = null;
  const symbolIdOf = (file: string, name: string): string | undefined => {
    if (!byFileName) {
      byFileName = new Map();
      const rows = ws.local.db
        .prepare<[string], { id: string; name: string; file_path: string }>(
          'SELECT id, name, file_path FROM symbols WHERE repo_id = ?',
        )
        .all(ws.local.repoId);
      for (const r of rows) byFileName.set(`${r.file_path}\0${r.name}`, r.id);
    }
    return byFileName.get(`${file}\0${name}`);
  };

  for (const m of ws.links) {
    const fileRows = m.db
      .prepare<[string, string], { source_file: string; target_file: string; specifier: string }>(
        'SELECT DISTINCT source_file, target_file, specifier FROM dep_edges WHERE repo_id = ? AND target_repo_id = ?',
      )
      .all(m.repoId, ws.local.repoId);
    if (fileRows.length === 0) continue;
    for (const r of fileRows) pushRef(entry(r.target_file).referencedBy, { repoId: m.repoId, rootPath: m.rootPath, file: r.source_file });

    let hasRefs = false;
    try {
      hasRefs =
        (m.db
          .prepare<[string, string], { n: number }>(
            'SELECT COUNT(*) AS n FROM symbol_refs WHERE repo_id = ? AND target_repo_id = ?',
          )
          .get(m.repoId, ws.local.repoId)?.n ?? 0) > 0;
    } catch {
      hasRefs = false; // pre-v14 linked index
    }
    if (hasRefs) {
      const refRows = m.db
        .prepare<[string, string], { source_file: string; target_file: string; target_symbol_id: string }>(
          'SELECT DISTINCT source_file, target_file, target_symbol_id FROM symbol_refs WHERE repo_id = ? AND target_repo_id = ?',
        )
        .all(m.repoId, ws.local.repoId);
      for (const r of refRows) {
        const e = entry(r.target_file);
        const list = e.symbolRefs.get(r.target_symbol_id) ?? [];
        pushRef(list, { repoId: m.repoId, rootPath: m.rootPath, file: r.source_file });
        e.symbolRefs.set(r.target_symbol_id, list);
      }
      continue;
    }
    // Fallback: the import record behind each cross edge names what it imports.
    const nameRows = m.db
      .prepare<[string, string], { source_file: string; target_file: string; imported_names: string }>(
        `SELECT DISTINCT e.source_file, e.target_file, r.imported_names
         FROM dep_edges e
         JOIN import_records r ON r.repo_id = e.repo_id AND r.source_file = e.source_file AND r.specifier = e.specifier
         WHERE e.repo_id = ? AND e.target_repo_id = ?`,
      )
      .all(m.repoId, ws.local.repoId);
    for (const r of nameRows) {
      let names: string[] = [];
      try {
        const parsed = JSON.parse(r.imported_names) as unknown;
        if (Array.isArray(parsed)) names = parsed.filter((n): n is string => typeof n === 'string');
      } catch {
        names = [];
      }
      for (const n of names) {
        const id = symbolIdOf(r.target_file, n);
        if (!id) continue;
        const e = entry(r.target_file);
        const list = e.symbolRefs.get(id) ?? [];
        pushRef(list, { repoId: m.repoId, rootPath: m.rootPath, file: r.source_file });
        e.symbolRefs.set(id, list);
      }
    }
  }
  return out;
}

// ─── Phase 102 (Task 638): coupling over the workspace ──────────────────────

export interface WorkspaceCouplingRow {
  filePath: string;
  efferentCoupling: number;
  afferentCoupling: number;
  instability: number;
  /** Local targets bare; linked targets `<repoId>:<path>`. */
  efferentDeps: string[];
  afferentDeps: string[];
  /** How many of the efferent / afferent deps live in a LINKED index. */
  crossEfferent: number;
  crossAfferent: number;
}

/**
 * Per-LOCAL-file coupling (Martin's instability) counting cross rows in both
 * directions: what this file imports in linked roots, and which linked files
 * import it. Every edge type counts (as `getCouplingMap` does). Rows exist
 * for local files only; linked files show up inside the dep lists.
 */
export function workspaceCouplingMap(ws: Workspace, filePath?: string): WorkspaceCouplingRow[] {
  const { edges } = workspaceAdjacency(ws, { excludeEdgeTypes: [], skipSelfLoops: false });
  const local = ws.local.repoId;
  type Side = { deps: Set<string>; cross: Set<string> };
  const eff = new Map<string, Side>();
  const aff = new Map<string, Side>();
  const sideOf = (map: Map<string, Side>, file: string): Side => {
    let s = map.get(file);
    if (!s) {
      s = { deps: new Set(), cross: new Set() };
      map.set(file, s);
    }
    return s;
  };
  for (const e of edges) {
    if (e.source.repoId === local && (filePath === undefined || e.source.path === filePath)) {
      const s = sideOf(eff, e.source.path);
      const d = displayNode(ws, e.target);
      s.deps.add(d);
      if (e.target.repoId !== local) s.cross.add(d);
    }
    if (e.target.repoId === local && (filePath === undefined || e.target.path === filePath)) {
      const s = sideOf(aff, e.target.path);
      const d = displayNode(ws, e.source);
      s.deps.add(d);
      if (e.source.repoId !== local) s.cross.add(d);
    }
  }
  const rows: WorkspaceCouplingRow[] = [];
  for (const file of new Set([...eff.keys(), ...aff.keys()])) {
    const e = eff.get(file);
    const a = aff.get(file);
    const efferentDeps = [...(e?.deps ?? [])];
    const afferentDeps = [...(a?.deps ?? [])];
    const ce = efferentDeps.length;
    const ca = afferentDeps.length;
    const total = ce + ca;
    rows.push({
      filePath: file,
      efferentCoupling: ce,
      afferentCoupling: ca,
      instability: total === 0 ? 0 : Math.round((ce / total) * 1000) / 1000,
      efferentDeps,
      afferentDeps,
      crossEfferent: e?.cross.size ?? 0,
      crossAfferent: a?.cross.size ?? 0,
    });
  }
  return rows;
}
