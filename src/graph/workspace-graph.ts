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
