/**
 * Hilt/Dagger DI edges (Phase 85).
 *
 * "DI is precisely the coupling import analysis misses": a Hilt consumer never
 * imports its provider — Dagger wires them at compile time — so the static
 * import graph shows zero coupling between, say, a ViewModel and the module
 * that provides its repository. This module derives those edges from the
 * frameworkMeta.di annotations the android adapter records on symbols.
 *
 * Pure, MCP-free, thin consumer of the symbols table (adapters emit symbols
 * only — they cannot insert edges, so this runs at graph-build time from
 * index-manager step 10).
 *
 * Matching (v1, stated bound): NAME-BASED only.
 *   - Providers: @Provides/@Binds return types, plus every class with an
 *     @Inject constructor (such a class is injectable as its own type — the
 *     most common provision in Hilt code).
 *   - Consumers: @Inject constructor/field parameter types, plus the parameter
 *     of an @Binds binding (the module depends on the bound implementation).
 *   - Types compare by bare name (package-qualified prefixes stripped, generics
 *     already stripped at extraction). An ambiguous type name gets edges to ALL
 *     providers — over-approximation is the safe direction for blast radius
 *     (Phase-82 rule). No interface-hierarchy walk, no @Named disambiguation.
 *
 * Edge direction follows dep_edges semantics: source depends on target, i.e.
 * consumer file → provider file. edge_type 'di', specifier 'di:<TypeName>'.
 * Same-file pairs are skipped (self-edges are noise, Phase-82 rule).
 */

import type Database from 'better-sqlite3';
import type { DepEdge } from '../core/types.js';
import { getConfig } from '../config/config-loader.js';
import { isTestFilePath } from '../core/test-paths.js';
import { deleteEdgesByType, insertEdges } from '../core/db/dep-store.js';
import { openWorkspace } from './workspace-graph.js';
import { logger } from '../core/logger.js';

interface DiSymbolRow {
  id: string;
  name: string;
  file_path: string;
  framework_meta: string;
}

interface DiInfo {
  role?: string;
  providedType?: string;
  consumedTypes?: string[];
  injectConstructor?: boolean;
}

function bare(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Reserved-namespace check (Task 548) applied BEFORE bare() strips the
 * package: a provider of `android.util.Log` (a local shim) must not become a
 * provider of bare `Log`, and a consumer of a reserved type gets no edge —
 * the real provider is the platform SDK. Only fully-qualified names can be
 * checked; bare names carry no namespace and pass through.
 */
function isReservedType(name: string, reserved: string[]): boolean {
  for (const ns of reserved) {
    if (name === ns || name.startsWith(ns + '.')) return true;
  }
  return false;
}

/** A linked index whose DI providers may satisfy this repo's consumers (Phase 102). */
export interface DiLinkedIndex {
  repoId: string;
  db: Database.Database;
}

interface DiProvider {
  file: string;
  symbolId: string;
  /** null = this index; otherwise the linked index the provider lives in. */
  repoId: string | null;
}

const DI_ROWS_SQL = `SELECT id, name, file_path, framework_meta
       FROM symbols
       WHERE repo_id = ? AND framework_meta LIKE '%"di"%'`;

/**
 * Build DI edges for a repo from symbols carrying frameworkMeta.di.
 * Zero DI symbols ⇒ zero edges at the cost of one indexed LIKE scan.
 *
 * Phase 102 (Task 639): with `linked`, the consumed types of THIS index are
 * also matched against the providers of each linked index (same bare-name
 * rule; edges carry `targetRepoId`). Consumers come from this index only —
 * the importing side stores the edge, as for import rows. A linked index
 * contributes providers only if its own android adapter recorded `di` meta
 * (that is what "both roots have the adapter active" means in stored terms).
 * Local providers keep their pre-102 edges byte-for-byte; a linked provider
 * of the same type ADDS an edge (over-approximation, the Phase-82 rule).
 */
export function buildDiEdges(
  db: Database.Database,
  repoId: string,
  linked: DiLinkedIndex[] = [],
): DepEdge[] {
  const reserved = getConfig().graph.reservedNamespaces;
  const rows = db.prepare<[string], DiSymbolRow>(DI_ROWS_SQL).all(repoId);

  const providers = new Map<string, DiProvider[]>();
  const consumers: Array<{ file: string; symbolId: string; types: string[] }> = [];

  const addProvider = (typeName: string, row: DiSymbolRow, ownerRepoId: string | null): void => {
    const list = providers.get(typeName) ?? [];
    if (!list.some((p) => p.symbolId === row.id && p.repoId === ownerRepoId)) {
      list.push({ file: row.file_path, symbolId: row.id, repoId: ownerRepoId });
    }
    providers.set(typeName, list);
  };

  const collect = (diRows: DiSymbolRow[], ownerRepoId: string | null, withConsumers: boolean): void => {
    for (const row of diRows) {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(row.framework_meta) as Record<string, unknown>;
      } catch {
        continue;
      }
      const di = meta['di'] as DiInfo | undefined;
      if (!di || typeof di !== 'object') continue;

      if (
        di.role === 'provider' &&
        typeof di.providedType === 'string' &&
        !isReservedType(di.providedType, reserved)
      ) {
        addProvider(bare(di.providedType), row, ownerRepoId);
      }
      // A class with an @Inject constructor is injectable as its own type.
      if (di.injectConstructor === true && !isReservedType(row.name, reserved)) {
        addProvider(bare(row.name), row, ownerRepoId);
      }
      if (withConsumers && Array.isArray(di.consumedTypes) && di.consumedTypes.length > 0) {
        consumers.push({
          file: row.file_path,
          symbolId: row.id,
          types: di.consumedTypes
            .filter((t): t is string => typeof t === 'string')
            .filter((t) => !isReservedType(t, reserved))
            .map(bare),
        });
      }
    }
  };

  collect(rows, null, true);
  for (const l of linked) {
    let lrows: DiSymbolRow[] = [];
    try {
      lrows = l.db.prepare<[string], DiSymbolRow>(DI_ROWS_SQL).all(l.repoId);
    } catch {
      lrows = []; // unreadable / older linked index — no cross providers
    }
    collect(lrows, l.repoId, false);
  }

  const edges: DepEdge[] = [];
  const seen = new Set<string>();

  for (const c of consumers) {
    const consumerIsTest = isTestFilePath(c.file);
    for (const t of c.types) {
      const provs = providers.get(t);
      if (!provs) continue; // external/framework type — no edge
      for (const p of provs) {
        if (p.repoId === null && p.file === c.file) continue;
        // Task 549: a production consumer never depends on a test-double
        // provider (@TestInstallIn fakes, @BindValue stubs live in test
        // source sets — Dagger only wires them in test builds).
        if (!consumerIsTest && isTestFilePath(p.file)) continue;
        const key = `${c.file}\u0000${p.repoId ?? ''}\u0000${p.file}\u0000${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          repoId,
          sourceFile: c.file,
          sourceSymbolId: c.symbolId,
          targetFile: p.file,
          targetSymbolId: p.symbolId,
          edgeType: 'di',
          specifier: `di:${t}`,
          ...(p.repoId ? { targetRepoId: p.repoId } : {}),
        });
      }
    }
  }

  return edges;
}

/**
 * The repo-wide DI rebuild the index pipeline runs after the graph build
 * (delete-then-insert, so targeted and full runs agree). Opens the stored
 * `repo_links` (Phase 102) so providers in linked roots are matched too; a
 * repo without links takes the pre-102 path exactly. Returns the edge count.
 */
export function rebuildDiEdges(db: Database.Database, repoId: string): number {
  deleteEdgesByType(db, repoId, 'di');
  const ws = openWorkspace(db, repoId);
  let edges: DepEdge[];
  try {
    edges = buildDiEdges(db, repoId, ws.links.map((m) => ({ repoId: m.repoId, db: m.db })));
  } finally {
    ws.close();
  }
  if (edges.length > 0) insertEdges(db, edges);
  const cross = edges.filter((e) => e.targetRepoId).length;
  if (cross > 0) logger.debug(`di-edges: ${edges.length} edges, ${cross} into linked index(es)`);
  return edges.length;
}
