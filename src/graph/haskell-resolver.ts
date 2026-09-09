/**
 * Haskell import resolver (Phase 86).
 *
 * Haskell's language rule makes this the simplest declared-module resolver:
 * ONE module per file, and the declared name includes the file's own identity
 * (`module A.B.C where` lives in `A/B/C.hs`). Resolution is an exact
 * module-name → file lookup — no package + member split at all.
 *
 * Primary source: `files.declared_package` (fed by the Haskell handler's
 * extractPackage). Fallback for headerless / pre-index files: dotted path
 * suffixes (`src/Data/Util.hs` answers to `Data.Util`).
 *
 * Unmatched specifiers (`Data.Map`, `Control.Monad`, any package dependency)
 * are external → no edge.
 */

import type Database from 'better-sqlite3';
import { isTestFilePath } from '../core/test-paths.js';
import { dropForeignCandidates } from '../core/library-paths.js';
import { getDeclaredPackages } from '../core/db/file-store.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const HASKELL_FAMILY_EXTENSIONS = new Set(['.hs', '.lhs']);

export function isHaskellSourceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.hs') || lower.endsWith('.lhs');
}

export interface HaskellResolver {
  /**
   * Resolve a module specifier to repo-relative file paths (as stored in the
   * DB). Empty array = external (base, package deps) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createHaskellResolver(
  db: Database.Database,
  repoId: string,
): HaskellResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const hsFiles = allPaths.filter(isHaskellSourceFile);

  const declared = getDeclaredPackages(db, repoId);

  // declared module name → files (exact — the primary lookup)
  const moduleFiles = new Map<string, string[]>();
  // dotted path suffix → files (fallback for files with no module header row)
  const suffixFiles = new Map<string, string[]>();

  function register(map: Map<string, string[]>, key: string, file: string) {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(file);
    else map.set(key, [file]);
  }

  for (const f of hsFiles) {
    const mod = declared.get(f);
    if (mod) {
      register(moduleFiles, mod, f);
      continue;
    }
    // No declared header: register every dotted path suffix of the file so
    // `import A.B.C` still finds `<anything>/A/B/C.hs`.
    const norm = f.replace(/\\/g, '/');
    const dot = norm.lastIndexOf('.');
    const stem = dot > 0 ? norm.slice(0, dot) : norm;
    const segs = stem.split('/').filter((s) => s.length > 0);
    // Phase 98 (Task 611): never register a ONE-segment suffix — every
    // `**/Types.hs` used to answer `import Types` from anywhere in the repo.
    for (let i = 0; i < segs.length - 1; i++) {
      register(suffixFiles, segs.slice(i).join('.'), f);
    }
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];
      const hits = moduleFiles.get(spec) ?? suffixFiles.get(spec) ?? [];
      return hygiene(hits.filter((f) => f !== sourceFile), sourceFile);
    },
  };
}

/**
 * Phase 98 (Task 611) resolver hygiene, applied to every candidate list:
 *   - a first-party importer never resolves into a foreign directory
 *     (deps/, vendor/, _build/, node_modules/ …) — the Go vendor rule;
 *   - a non-test importer never resolves to a test file (Phase-89 rule).
 * Test importers and importers that themselves live in a foreign directory
 * are left alone (rabbitmq-server keeps its components under deps/).
 */
function hygiene(candidates: string[], sourceFile: string): string[] {
  const foreignFiltered = dropForeignCandidates(candidates, sourceFile);
  if (isTestFilePath(sourceFile)) return foreignFiltered;
  return foreignFiltered.filter((f) => !isTestFilePath(f));
}
