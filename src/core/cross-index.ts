/**
 * Cross-index graph build support (Phase 99, Task 615).
 *
 * Wires the workspace rule (`workspace-links.ts`) into the two index-manager
 * graph-build sites:
 *   - a whole-tree run DISCOVERS links (`resolveLinks`) and, after building,
 *     stores them in `repo_links` with each sibling's HEAD sha;
 *   - a targeted `reindexFiles` re-uses the STORED links (no index-dir scan
 *     per edited file) unless the caller asks for a refresh (worktree clone).
 * Each linked index is opened once per build and exposed to `buildGraph` as a
 * lazy `LinkedGraphTarget`: its file set and family resolvers are built only
 * when a local miss actually asks for them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ImportRecord, IndexOptions, IndexResult } from './types.js';
import { getIndexDir, openDatabase } from './db/schema.js';
import { getSymbolsByFile } from './db/symbol-store.js';
import { getImportRecordsByFile } from './db/import-store.js';
import { getForwardDeps } from './db/dep-store.js';
import { getFileContent } from './db/file-store.js';
import { getAllFileHashes } from './db/file-store.js';
import { getRepoLinks, replaceRepoLinks, recordReverseLink, type LinkRelation, type RepoLink } from './db/link-store.js';
import { gitHeadSha } from './git-head.js';
import { logger } from './logger.js';
import { resolveLinks, type LinkedIndex, type UnlinkedSibling } from './workspace-links.js';
import type { FamilyResolvers, LinkedGraphTarget } from '../graph/graph-builder.js';
import { workspaceResolverFor, type WorkspacePackageResolver } from '../graph/workspace-packages.js';
import { buildFamilyResolvers } from '../graph/family-resolvers.js';
import { buildIndexedFileSet, type IndexedFileSet } from '../graph/prefilled-targets.js';

function inverseRelation(r: LinkRelation): LinkRelation {
  if (r === 'nested') return 'parent';
  if (r === 'parent') return 'nested';
  return r;
}

/**
 * Has the workspace changed since this index last built its graph? True when
 * a link appeared or vanished, when a stored link was recorded by the OTHER
 * side only (`built = 0`), or when a linked sibling's checkout moved. A
 * whole-tree run then re-resolves the WHOLE graph from stored import records
 * (no re-parse) instead of only the reprocessed files' — the documented
 * "run index_folder on this root" repair.
 */
export function linksChangedSince(stored: RepoLink[], live: LinkedIndex[]): boolean {
  if (stored.length !== live.length) return true;
  const byId = new Map(stored.map((s) => [s.linkedRepoId, s] as const));
  for (const l of live) {
    const s = byId.get(l.repoId);
    if (!s || !s.built) return true;
    const now = existsSync(l.rootPath) ? gitHeadSha(l.rootPath) : null;
    if ((s.linkedSha ?? null) !== now) return true;
  }
  return false;
}

export interface LinkedBuild {
  /** Links in resolution order (sorted by root path). */
  links: LinkedIndex[];
  /** Candidates the rule rejected (discovery mode only). */
  unlinked: UnlinkedSibling[];
  /** What `buildGraph` consumes. Empty when there are no links. */
  targets: LinkedGraphTarget[];
  /** Persist the link set (with the siblings' CURRENT HEAD shas) into `repo_links`. */
  commit(db: Database.Database, repoId: string): void;
  /** Close every linked handle. Always call (finally). */
  close(): void;
  /** For the result payload. */
  summary(): NonNullable<IndexResult['linksUsed']>;
}

export interface PrepareLinksOptions extends Pick<IndexOptions, 'crossIndex' | 'linkedRepos' | 'maxLinkedRepos'> {
  /**
   * true  → run the workspace rule now (whole-tree runs, worktree clones);
   * false → read the links the last whole-tree build stored (targeted runs).
   */
  discover: boolean;
}

/**
 * Open the linked indexes for one graph build. Never throws for a missing or
 * unreadable sibling — that link is skipped (and, on commit, not recorded).
 */
export function prepareLinkedBuild(
  db: Database.Database,
  repoId: string,
  absRoot: string,
  /**
   * The import records the graph build will resolve — decides WHICH family
   * resolvers each linked index needs. A getter is accepted because
   * `indexFolder` decides between "reprocessed files only" and "every stored
   * record" only after it knows whether the link set changed; the linked
   * maps are built lazily, at which point the getter is final. (Passing the
   * reprocessed-files list on a no-op run built NO sibling resolver at all —
   * caught on jenkins: core's imports of cli classes never crossed.)
   */
  imports: ImportRecord[] | (() => ImportRecord[]),
  opts: PrepareLinksOptions,
): LinkedBuild {
  const importsOf = () => (typeof imports === 'function' ? imports() : imports);
  let links: LinkedIndex[] = [];
  let unlinked: UnlinkedSibling[] = [];
  if (opts.discover) {
    const res = resolveLinks(repoId, absRoot, {
      crossIndex: opts.crossIndex,
      linkedRepos: opts.linkedRepos,
      maxLinkedRepos: opts.maxLinkedRepos,
    });
    links = res.links;
    unlinked = res.unlinked;
  } else {
    links = getRepoLinks(db, repoId).map((l) => ({
      repoId: l.linkedRepoId,
      rootPath: l.linkedRootPath,
      relation: l.relation,
      source: l.source,
      sha: l.linkedSha,
    }));
  }

  const handles: Database.Database[] = [];
  const handleOf = new Map<string, Database.Database>();
  const targets: LinkedGraphTarget[] = [];
  const live: LinkedIndex[] = [];
  for (const link of links) {
    if (!existsSync(join(getIndexDir(), `${link.repoId}.db`))) {
      logger.debug(`cross-index: linked index ${link.repoId} (${link.rootPath}) is missing — skipped`);
      continue;
    }
    let ldb: Database.Database;
    try {
      ldb = openDatabase(link.repoId);
    } catch (err) {
      logger.debug(`cross-index: cannot open linked index ${link.repoId}: ${String(err)}`);
      continue;
    }
    handles.push(ldb);
    handleOf.set(link.repoId, ldb);
    live.push(link);
    let files: IndexedFileSet | null = null;
    let fams: FamilyResolvers | undefined;
    let famsBuilt = false;
    let wsp: WorkspacePackageResolver | null = null;
    let wspBuilt = false;
    const indexedFiles = () => {
      if (!files) files = buildIndexedFileSet(getAllFileHashes(ldb, link.repoId).keys());
      return files;
    };
    targets.push({
      repoId: link.repoId,
      rootPath: link.rootPath,
      indexedFiles,
      // Phase 100 (Task 627): the linked root's own workspace packages,
      // validated against ITS indexed files; built on first bare TS/JS miss.
      workspacePackages: () => {
        if (!wspBuilt) {
          wsp = workspaceResolverFor(link.rootPath, indexedFiles());
          wspBuilt = true;
        }
        return wsp;
      },
      // Phase 101: symbol tables / import records / file edges of the linked
      // index for the symbol-edge builder (same open handle; read-only).
      refView: () => ({
        repoId: link.repoId,
        symbolsByFile: (path) => getSymbolsByFile(ldb, link.repoId, path),
        importRecordsByFile: (path) => getImportRecordsByFile(ldb, link.repoId, path),
        forwardDeps: (path) => getForwardDeps(ldb, link.repoId, path, undefined, true),
        fileContent: (path) => getFileContent(ldb, link.repoId, path),
      }),
      families: () => {
        if (!famsBuilt) {
          const t0 = Date.now();
          fams = buildFamilyResolvers(ldb, link.repoId, link.rootPath, importsOf());
          famsBuilt = true;
          logger.debug(`cross-index: resolver maps for ${link.rootPath} built in ${Date.now() - t0} ms`);
        }
        return fams;
      },
    });
  }

  if (live.length > 0) {
    logger.info(`cross-index: ${live.length} linked index(es) for ${absRoot}`);
  }

  return {
    links: live,
    unlinked,
    targets,
    commit(target, id) {
      replaceRepoLinks(
        target,
        id,
        live.map((l) => ({
          linkedRepoId: l.repoId,
          linkedRootPath: l.rootPath,
          // The sibling's CHECKOUT head now: drift = it moved since this build.
          linkedSha: existsSync(l.rootPath) ? gitHeadSha(l.rootPath) : null,
          source: l.source,
          relation: l.relation,
        })),
      );
      // Reverse rows: each linked index learns about THIS one, so its reverse
      // traversals (blast radius / importers of a library file) open this DB
      // and find the edges stored here. Upsert — never replaces its own set.
      const mySha = gitHeadSha(absRoot);
      for (const l of live) {
        const ldb = handleOf.get(l.repoId);
        if (!ldb) continue;
        try {
          recordReverseLink(ldb, l.repoId, {
            linkedRepoId: id,
            linkedRootPath: absRoot,
            linkedSha: mySha,
            source: l.source,
            relation: inverseRelation(l.relation),
          });
        } catch (err) {
          logger.debug(`cross-index: could not record reverse link in ${l.repoId}: ${String(err)}`);
        }
      }
    },
    close() {
      for (const h of handles) {
        try {
          h.close();
        } catch {
          /* already closed */
        }
      }
    },
    summary() {
      return live.map((l) => ({ repoId: l.repoId, rootPath: l.rootPath, source: l.source, relation: l.relation }));
    },
  };
}
