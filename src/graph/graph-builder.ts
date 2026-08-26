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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Per-family import resolvers (Phase 84; Wave 2 families in Phase 86). Each
 * is optional — the index manager builds a family's resolver only when the
 * batch contains that family's source files, so a pure-TS index pays nothing.
 */
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
): DepEdge[] {
  const families: FamilyResolvers =
    familyResolvers === undefined
      ? {}
      : typeof (familyResolvers as JvmResolver).resolve === 'function'
        ? { jvm: familyResolvers as JvmResolver }
        : (familyResolvers as FamilyResolvers);
  const dispatch = buildDispatch(families);

  // Deduplicate by (sourceFile, targetFile) to avoid flooding the dep table
  // with one row per named import specifier from the same module.
  const seen = new Set<string>();
  const edges: DepEdge[] = [];

  for (const rec of imports) {
    if (!rec.sourceFile) continue; // guard against unfilled sourceFile

    // Resolve the path(s) if the handler left resolvedPath null
    let targetFiles: string[];
    if (rec.resolvedPath !== null) {
      targetFiles = [rec.resolvedPath];
    } else {
      const familyFn = dispatch.get(extOf(rec.sourceFile));
      if (familyFn) {
        targetFiles = familyFn(rec);
      } else {
        const resolved = resolver.resolve(rec.specifier, rec.sourceFile);
        targetFiles = resolved === null ? [] : [resolved];
      }
    }

    for (const targetFile of targetFiles) {
      const key = `${rec.sourceFile}\0${targetFile}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        repoId,
        sourceFile: rec.sourceFile,
        sourceSymbolId: null,
        targetFile,
        targetSymbolId: null,
        edgeType: detectEdgeType(rec),
        specifier: rec.specifier,
      });
    }
  }

  return edges;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectEdgeType(rec: ImportRecord): string {
  // re-exports: `export { foo } from './foo'` — importedNames contains
  // re-exported names. We can't distinguish this from a regular named import
  // at the ImportRecord level in Phase 1, so everything is 'import'.
  void rec;
  return 'import';
}
