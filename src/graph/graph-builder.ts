import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ImportRecord, DepEdge } from '../core/types.js';
import type { PathResolver } from './path-resolver.js';
import { DECLARED_MODULE_EXTENSIONS, type JvmResolver } from './jvm-resolver.js';
import { PYTHON_FAMILY_EXTENSIONS, type PythonResolver } from './python-resolver.js';
import { GO_FAMILY_EXTENSIONS, type GoResolver } from './go-resolver.js';
import { PHP_FAMILY_EXTENSIONS, type PhpResolver } from './php-resolver.js';
import { HASKELL_FAMILY_EXTENSIONS, type HaskellResolver } from './haskell-resolver.js';
import { ELIXIR_FAMILY_EXTENSIONS, type ElixirResolver } from './elixir-resolver.js';
import { ERLANG_FAMILY_EXTENSIONS, type ErlangResolver } from './erlang-resolver.js';
import { FORTRAN_FAMILY_EXTENSIONS, type FortranResolver } from './fortran-resolver.js';
import { RUST_FAMILY_EXTENSIONS, type RustResolver } from './rust-resolver.js';
import { DART_FAMILY_EXTENSIONS, type DartResolver } from './dart-resolver.js';
import { RUBY_FAMILY_EXTENSIONS, type RubyResolver } from './ruby-resolver.js';
import { SWIFT_FAMILY_EXTENSIONS, type SwiftResolver } from './swift-resolver.js';
import { resolvePrefilledTarget, type IndexedFileSet } from './prefilled-targets.js';
import { isJsFamilyFile, type WorkspacePackageResolver } from './workspace-packages.js';
import type { RefIndexView } from './symbol-edges.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Per-family import resolvers (Phase 84; Wave 2 families in Phase 86). Each
 * is optional — the index manager builds a family's resolver only when the
 * batch contains that family's source files, so a pure-TS index pays nothing.
 */
export interface BuildGraphOptions {
  /**
   * Phase 98 (Task 608): the repo's indexed files. When supplied, a
   * handler-prefilled `resolvedPath` is VALIDATED against this set (exact,
   * sibling, stylesheet partial, Lua module, Terraform directory, suffix and
   * disk-resolver probes — see prefilled-targets.ts) and dropped when no
   * indexed file matches. Omitted → pre-98 verbatim behavior.
   */
  indexedFiles?: IndexedFileSet;
  /**
   * Phase 99 (Task 615): linked indexes, in link order. A record the LOCAL
   * resolution leaves empty is offered to each link in turn — the first one
   * that answers wins (deterministic: callers pass links sorted by root
   * path). A hit becomes a CROSS edge: `targetFile` is relative to the linked
   * root and `targetRepoId` names it. Validation is the Phase-98 rule applied
   * to the linked index's own file set — never a dangling row.
   */
  links?: LinkedGraphTarget[];
  /**
   * Phase 100 (Task 627): npm/pnpm/yarn workspace package names of THIS
   * root. Consulted for a bare TS/JS specifier AFTER the path resolver's
   * relative + tsconfig-alias strategies returned null and BEFORE it is
   * treated as external. Built with the indexed file set so a target that is
   * not an indexed file is dropped (Phase-98 rule).
   */
  workspacePackages?: WorkspacePackageResolver | null;
}

/**
 * One linked index as the graph builder sees it. Both accessors are LAZY so
 * a build where every import resolves locally never pays for a sibling's
 * resolver maps (the JVM map on a jenkins-sized tree is ~1 s).
 */
export interface LinkedGraphTarget {
  repoId: string;
  /** Absolute root of the linked index. */
  rootPath: string;
  indexedFiles(): IndexedFileSet;
  families(): FamilyResolvers | undefined;
  /** Phase 100: the linked root's workspace packages (lazy; null = none). */
  workspacePackages?(): WorkspacePackageResolver | null;
  /**
   * Phase 101: the linked index as the symbol-edge builder sees it (its
   * symbol tables, import records, file edges) — the target side of a cross
   * `ref` edge and the far end of a re-export chain that crosses the seam.
   */
  refView?(): RefIndexView;
}

export interface FamilyResolvers {
  jvm?: JvmResolver;
  python?: PythonResolver;
  go?: GoResolver;
  php?: PhpResolver;
  haskell?: HaskellResolver;
  elixir?: ElixirResolver;
  erlang?: ErlangResolver;
  fortran?: FortranResolver;
  rust?: RustResolver;
  dart?: DartResolver;
  ruby?: RubyResolver;
  swift?: SwiftResolver;
}

type FamilyResolveFn = (rec: ImportRecord) => string[];

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? '' : filePath.slice(dot).toLowerCase();
}

/**
 * Extension → resolve-function dispatch map (Phase 86: replaces the growing
 * per-family if-chain). Only families with a built resolver claim their
 * extensions; everything else falls through to the path resolver.
 */
function buildDispatch(families: FamilyResolvers): Map<string, FamilyResolveFn> {
  const byExt = new Map<string, FamilyResolveFn>();
  const add = (exts: Iterable<string>, fn: FamilyResolveFn) => {
    for (const ext of exts) byExt.set(ext, fn);
  };
  if (families.jvm) {
    add(DECLARED_MODULE_EXTENSIONS, (r) => families.jvm!.resolve(r.specifier, r.sourceFile));
  }
  if (families.python) {
    add(PYTHON_FAMILY_EXTENSIONS, (r) =>
      families.python!.resolve(r.specifier, r.sourceFile, r.importedNames),
    );
  }
  if (families.go) {
    add(GO_FAMILY_EXTENSIONS, (r) => families.go!.resolve(r.specifier, r.sourceFile));
  }
  if (families.php) {
    add(PHP_FAMILY_EXTENSIONS, (r) => families.php!.resolve(r.specifier, r.sourceFile));
  }
  if (families.haskell) {
    add(HASKELL_FAMILY_EXTENSIONS, (r) => families.haskell!.resolve(r.specifier, r.sourceFile));
  }
  if (families.elixir) {
    add(ELIXIR_FAMILY_EXTENSIONS, (r) => families.elixir!.resolve(r.specifier, r.sourceFile));
  }
  if (families.erlang) {
    add(ERLANG_FAMILY_EXTENSIONS, (r) => families.erlang!.resolve(r.specifier, r.sourceFile));
  }
  if (families.fortran) {
    add(FORTRAN_FAMILY_EXTENSIONS, (r) => families.fortran!.resolve(r.specifier, r.sourceFile));
  }
  if (families.rust) {
    add(RUST_FAMILY_EXTENSIONS, (r) =>
      families.rust!.resolve(r.specifier, r.sourceFile, r.importedNames),
    );
  }
  if (families.dart) {
    add(DART_FAMILY_EXTENSIONS, (r) => families.dart!.resolve(r.specifier, r.sourceFile));
  }
  if (families.ruby) {
    add(RUBY_FAMILY_EXTENSIONS, (r) =>
      families.ruby!.resolve(r.specifier, r.sourceFile, r.importedNames),
    );
  }
  if (families.swift) {
    add(SWIFT_FAMILY_EXTENSIONS, (r) => families.swift!.resolve(r.specifier, r.sourceFile));
  }
  return byExt;
}

/**
 * Convert a batch of ImportRecords into DepEdges.
 *
 * Each ImportRecord may or may not have `resolvedPath` pre-filled; if it is
 * null a resolver is called to fill it. Imports from a family's source files
 * go through that family resolver when one is supplied — a family resolver
 * can yield SEVERAL targets (wildcard imports, whole Go packages,
 * cross-module ambiguity), each becoming an edge. All other files use the
 * path resolver, whose behavior is unchanged. Records that resolve to nothing
 * (external packages) are silently dropped — they don't belong in the
 * in-project graph.
 *
 * The 4th parameter accepts either a FamilyResolvers map or (back-compat with
 * the Phase 82 seam) a bare JvmResolver.
 *
 * Phase 1 emits one file-level edge per unique (sourceFile, targetFile) pair.
 * Symbol-level edge population is deferred to Phase 2 when we have a DB
 * handle available during incremental reindexing.
 */
export function buildGraph(
  imports: ImportRecord[],
  resolver: PathResolver,
  repoId: string,
  familyResolvers?: JvmResolver | FamilyResolvers,
  options?: BuildGraphOptions,
): DepEdge[] {
  const families: FamilyResolvers =
    familyResolvers === undefined
      ? {}
      : typeof (familyResolvers as JvmResolver).resolve === 'function'
        ? { jvm: familyResolvers as JvmResolver }
        : (familyResolvers as FamilyResolvers);
  const dispatch = buildDispatch(families);
  const links = options?.links ?? [];
  // Per-link dispatch maps, built on first use (the families() accessor is lazy).
  const linkDispatch = new Map<string, Map<string, FamilyResolveFn>>();
  const dispatchFor = (link: LinkedGraphTarget): Map<string, FamilyResolveFn> => {
    let d = linkDispatch.get(link.repoId);
    if (!d) {
      d = buildDispatch(link.families() ?? {});
      linkDispatch.set(link.repoId, d);
    }
    return d;
  };

  // Deduplicate by (sourceFile, targetRepo, targetFile) to avoid flooding the
  // dep table with one row per named import specifier from the same module.
  const seen = new Set<string>();
  const edges: DepEdge[] = [];
  const push = (rec: ImportRecord, targetFile: string, targetRepoId: string | null) => {
    const key = `${rec.sourceFile}\0${targetRepoId ?? ''}\0${targetFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      repoId,
      sourceFile: rec.sourceFile,
      sourceSymbolId: null,
      targetFile,
      targetSymbolId: null,
      edgeType: detectEdgeType(rec),
      specifier: rec.specifier,
      ...(targetRepoId ? { targetRepoId } : {}),
    });
  };

  for (const rec of imports) {
    if (!rec.sourceFile) continue; // guard against unfilled sourceFile

    // ── Local resolution (unchanged since Phase 98) ──────────────────────────
    let targetFiles: string[];
    let viaPathResolver = false;
    if (rec.resolvedPath !== null) {
      targetFiles = options?.indexedFiles
        ? resolvePrefilledTarget(rec, options.indexedFiles, resolver)
        : [rec.resolvedPath];
    } else {
      const familyFn = dispatch.get(extOf(rec.sourceFile));
      if (familyFn) {
        targetFiles = familyFn(rec);
      } else {
        viaPathResolver = true;
        let resolved = resolver.resolve(rec.specifier, rec.sourceFile);
        // Phase 100 (Task 627): a bare specifier naming a workspace package
        // (`@nuxt/kit`) resolves to that package's source entry.
        if (resolved === null && options?.workspacePackages && isBareSpecifier(rec.specifier)) {
          resolved = options.workspacePackages.resolve(rec.specifier);
          if (resolved !== null) viaPathResolver = false; // never "escapes the root"
        }
        targetFiles = resolved === null ? [] : [resolved];
      }
    }

    // ── Cross-index resolution (Phase 99) ───────────────────────────────────
    if (links.length > 0) {
      // (a) The disk path resolver followed `../../lib/x` OUT of this root.
      //     If a linked root holds that file, it is a cross edge; otherwise the
      //     pre-99 behavior stands (the row is the seam externalImports reports).
      if (viaPathResolver && targetFiles.length === 1 && escapesRoot(targetFiles[0]!)) {
        const cross = crossTargetFromDisk(targetFiles[0]!, resolver.projectRoot, links);
        if (cross) {
          push(rec, cross.targetFile, cross.repoId);
          continue;
        }
      }
      // (b) Nothing local answered: offer the record to each link in order.
      if (targetFiles.length === 0 && eligibleForLinks(rec)) {
        const cross = resolveAcrossLinks(rec, links, dispatchFor);
        if (cross) {
          for (const t of cross.targetFiles) push(rec, t, cross.repoId);
          continue;
        }
      }
    }

    for (const targetFile of targetFiles) push(rec, targetFile, null);
  }

  return edges;
}

// ─── Cross-index helpers (Phase 99) ──────────────────────────────────────────

/** The disk resolver is LOCAL; a linked probe must never consult it. */
const NULL_RESOLVER: PathResolver = { projectRoot: '', resolve: () => null };

/**
 * The importer's path as seen by a LINKED resolver. Family resolvers use the
 * source path for three things: self-exclusion (`f !== sourceFile`), the
 * same-module preference, and test-importer detection. Across a link the
 * first two are meaningless — and the self-exclusion is actively wrong when
 * both roots hold a file at the SAME relative path (jenkins: `core/` and
 * `test/` both have `src/test/java/jenkins/security/Security3657Test.java`;
 * the sibling's copy was dropped as "myself"). A prefix no index can contain
 * keeps the test-path shape (`/src/test/`) and defeats the other two.
 */
const CROSS_SOURCE_PREFIX = '__linked_importer__/';

/** Not relative, not absolute, not a `node:` builtin — a package-ish name. */
function isBareSpecifier(s: string): boolean {
  return s !== '' && !s.startsWith('.') && !s.startsWith('/') && !isAbsolute(s) && !s.startsWith('node:');
}

function escapesRoot(rel: string): boolean {
  const n = rel.replace(/\\/g, '/');
  return n === '..' || n.startsWith('../') || isAbsolute(rel);
}

/**
 * Relative / crate-relative specifiers name a place INSIDE the importer's own
 * tree; a same-shaped path in another index is a coincidence, not an import.
 */
function eligibleForLinks(rec: ImportRecord): boolean {
  const s = rec.specifier;
  if (s.startsWith('.')) return false;
  if (/^(crate|self|super)(::|$)/.test(s)) return false;
  return true;
}

function toLinkedRelative(absPath: string, linkedRoot: string): string | null {
  const rel = relative(linkedRoot, absPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

function crossTargetFromDisk(
  localRel: string,
  localRoot: string,
  links: LinkedGraphTarget[],
): { repoId: string; targetFile: string } | null {
  const abs = resolvePath(localRoot, localRel);
  for (const link of links) {
    const rel = toLinkedRelative(abs, link.rootPath);
    if (rel === null) continue;
    const stored = link.indexedFiles().byNorm.get(rel);
    if (stored !== undefined) return { repoId: link.repoId, targetFile: stored };
  }
  return null;
}

function resolveAcrossLinks(
  rec: ImportRecord,
  links: LinkedGraphTarget[],
  dispatchFor: (link: LinkedGraphTarget) => Map<string, FamilyResolveFn>,
): { repoId: string; targetFiles: string[] } | null {
  const ext = extOf(rec.sourceFile);
  for (const link of links) {
    let targets: string[] = [];
    if (rec.resolvedPath !== null) {
      // Prefilled targets: the Phase-98 validation against the LINKED file set
      // (repo-relative and suffix probes apply; importer-relative probes miss
      // by construction — the importer's directory is not in that index).
      targets = resolvePrefilledTarget(rec, link.indexedFiles(), NULL_RESOLVER);
    } else {
      const fn = dispatchFor(link).get(ext);
      if (fn) {
        targets = fn({ ...rec, sourceFile: CROSS_SOURCE_PREFIX + rec.sourceFile });
      } else if (isJsFamilyFile(rec.sourceFile) && isBareSpecifier(rec.specifier) && link.workspacePackages) {
        // Phase 100 (Task 627): a workspace split into several roots — the
        // package named by `@scope/pkg` lives in the linked root. Its
        // resolver is built with THAT root's indexed file set (validated).
        const hit = link.workspacePackages()?.resolve(rec.specifier) ?? null;
        if (hit !== null) targets = [hit];
      }
    }
    if (targets.length > 0) return { repoId: link.repoId, targetFiles: targets };
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectEdgeType(rec: ImportRecord): string {
  // re-exports: `export { foo } from './foo'` — importedNames contains
  // re-exported names. We can't distinguish this from a regular named import
  // at the ImportRecord level in Phase 1, so everything is 'import'.
  void rec;
  return 'import';
}
