/**
 * Shared "not first-party" path predicate (Phase 98, Task 611).
 *
 * One vocabulary for the three places that must agree on what counts as
 * vendored / dependency / build-output code:
 *   - the ranker's library-path penalty (`relevance-ranker.ts`, which owned
 *     this list since Phase 71 — it is re-exported from here unchanged),
 *   - the family resolvers (an importer OUTSIDE a foreign directory never
 *     resolves INTO one — the Go vendor rule generalized; an importer that
 *     itself lives under `deps/` keeps resolving its siblings, which is how
 *     rabbitmq-server lays out its own components),
 *   - file discovery's built-in excludes for the segments that are never
 *     source at all (virtualenvs, site-packages, CocoaPods checkouts,
 *     Elixir/Erlang build output).
 */

/** Directory segments that mark library / third-party code (ranker penalty). */
export const LIBRARY_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'system',
  'vendor',
  'third_party',
  'node_modules',
  'bower_components',
  // Phase 71 additions:
  'engine',
  'erts',
  'contrib',
]);

/**
 * Multi-segment path substrings that identify library/low-priority code.
 * Checked case-insensitively against the full lowercased path.
 *
 *   /lib/wx/    Erlang/OTP wxWidgets C++ bindings
 *   /blas/      BLAS numerical library wrappers
 *   /lapack/    LAPACK numerical library wrappers
 */
export const LIBRARY_PATH_SUBSTRINGS: ReadonlyArray<string> = ['/lib/wx/', '/blas/', '/lapack/'];

/**
 * Directory segments a resolver must never register as an edge TARGET for a
 * first-party importer: dependency checkouts and build output. Narrower than
 * the ranker list on purpose — `engine/`, `contrib/`, `system/` are
 * low-priority but still resolvable first-party code.
 */
export const FOREIGN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'deps',
  '_build',
  '.venv',
  'venv',
  'site-packages',
  'pods',
  'testdata',
]);

function segmentsOf(filePath: string): string[] {
  return filePath.replace(/\\/g, '/').toLowerCase().split('/');
}

/** True when the path sits under a dependency / build-output directory. */
export function isForeignPath(filePath: string): boolean {
  const segs = segmentsOf(filePath);
  for (let i = 0; i < segs.length - 1; i++) {
    if (FOREIGN_PATH_SEGMENTS.has(segs[i]!)) return true;
  }
  return false;
}

/**
 * Resolver hygiene filter: a first-party importer never gets an edge into a
 * foreign directory. An importer that is itself foreign (rabbitmq-server's
 * `deps/rabbit/...`, a vendored package importing its own sibling) is left
 * alone — the rule is about crossing the boundary, not about the directory.
 */
export function dropForeignCandidates(candidates: string[], sourceFile: string): string[] {
  if (candidates.length === 0 || isForeignPath(sourceFile)) return candidates;
  return candidates.filter((c) => !isForeignPath(c));
}

/**
 * Ranker predicate (unchanged behavior, moved here from relevance-ranker.ts):
 * true when the path contains a library segment or substring.
 */
export function isLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.split('/').some((seg) => LIBRARY_PATH_SEGMENTS.has(seg))) return true;
  const withLeadingSlash = '/' + normalized;
  return LIBRARY_PATH_SUBSTRINGS.some((sub) => withLeadingSlash.includes(sub));
}
