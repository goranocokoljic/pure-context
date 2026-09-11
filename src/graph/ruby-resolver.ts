/**
 * Ruby import resolver (Phase 103, Task 641).
 *
 * Before this module every Ruby repo indexed to ZERO dependency edges: the
 * handler emitted `require` records with `resolvedPath: null` and nothing
 * consumed them (gap-analysis MEDIUM; brew / rails / mastodon / discourse all
 * reported `graphCoverage: 'empty'`). Three record shapes come from
 * `src/handlers/ruby.ts`, all validated against the indexed file set (P2 —
 * never a dangling row):
 *
 *  1. `require 'a/b'`      → `<root>/a/b.rb` for a LOAD-PATH ROOT;
 *  2. `./x` (require_relative, normalised by the handler)
 *                          → `<dir of importer>/x.rb`;
 *  3. `Admin::User`        → Zeitwerk: `<root>/admin/user.rb`
 *                            (ActiveSupport `underscore` per segment), then
 *                            the symbol table (a class / module declared in
 *                            exactly ONE file) as the fallback.
 *
 * Load-path roots are not declared anywhere Ruby-side (`$LOAD_PATH` is
 * assembled at runtime), so they are DISCOVERED:
 *   - by convention: the repo root, every `lib/` directory, every `app/<x>/`
 *     directory and its `concerns/` (Rails autoload paths);
 *   - by evidence: a directory A is a root when some indexed Ruby file below
 *     it does `require 'x/y'` and `A/x/y.rb` is indexed (the multi-segment
 *     shape is the safeguard against gem-name coincidences). This is how
 *     Homebrew's `Library/Homebrew/` — never a `lib/` — earns its edges.
 * A stdlib / default-gem name (`json`, `net/http`, `set`; config
 * `graph.reservedRubyModules`) resolves to nothing, so
 * `active_support/json.rb` can never capture `require "json"` (the Phase-98
 * Python rule). Several roots answering → the ones sharing the longest
 * directory prefix with the importer; a rootless multi-way tie is dropped.
 * Phase-98 hygiene applies: a first-party importer never resolves into a
 * foreign directory, a production importer never into a test file.
 */

import type Database from 'better-sqlite3';
import { getConfig } from '../config/config-loader.js';
import { isTestFilePath } from '../core/test-paths.js';
import { dropForeignCandidates } from '../core/library-paths.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const RUBY_FAMILY_EXTENSIONS = new Set(['.rb']);

export function isRubySourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.rb');
}

export interface RubyResolverOptions {
  /** Override config `graph.reservedRubyModules`; [] disables the check. */
  reservedModules?: string[];
}

export interface RubyResolver {
  /**
   * Resolve a specifier to repo-relative file paths (as stored in the DB).
   * Empty array = external (gem, stdlib) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string, nesting?: string[]): string[];
  /** Discovered load-path roots (normalised, '' = repo root) — for tests / diagnostics. */
  roots(): string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function dirOf(norm: string): string {
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : norm.slice(0, i);
}

function joinNorm(dir: string, rel: string): string {
  return dir === '' ? rel : `${dir}/${rel}`;
}

/** Resolve `./x`, `../x` against a directory, collapsing `.` and `..` segments. */
function resolveRelative(dir: string, rel: string): string | null {
  const out = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes the repo
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** ActiveSupport `underscore` (no acronym table): `HTMLParser` → `html_parser`. */
export function underscoreRuby(segment: string): string {
  return segment
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

const CONSTANT_PATH = /^[A-Z][A-Za-z0-9_]*(::[A-Z][A-Za-z0-9_]*)*$/;

function sharedPrefixSegments(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/**
 * Several indexed candidates: keep the ones sharing the longest directory
 * prefix with the importer; a multi-way tie with NO shared prefix is dropped
 * (the Phase-98 suffix rule — a rootless fan-out is a guess, not an edge).
 */
function preferNearest(candidates: string[], sourceFile: string): string[] {
  if (candidates.length <= 1) return candidates;
  const srcDir = dirOf(normalize(sourceFile));
  let best = -1;
  let bestList: string[] = [];
  for (const c of candidates) {
    const n = sharedPrefixSegments(dirOf(c), srcDir);
    if (n > best) {
      best = n;
      bestList = [c];
    } else if (n === best) {
      bestList.push(c);
    }
  }
  if (bestList.length > 1 && best === 0) return [];
  return bestList;
}

/** Phase-98 hygiene: foreign boundary + production-never-into-tests. */
function hygiene(candidates: string[], sourceFile: string): string[] {
  const foreignFiltered = dropForeignCandidates(candidates, sourceFile);
  if (isTestFilePath(sourceFile)) return foreignFiltered;
  return foreignFiltered.filter((f) => !isTestFilePath(f));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRubyResolver(
  db: Database.Database,
  repoId: string,
  _projectRoot: string,
  options?: RubyResolverOptions,
): RubyResolver {
  const reserved = new Set<string>(
    options?.reservedModules ?? getConfig().graph.reservedRubyModules,
  );

  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);

  const storedByNorm = new Map<string, string>();
  const rbFiles: string[] = [];
  for (const stored of allPaths) {
    const n = normalize(stored);
    storedByNorm.set(n, stored);
    if (isRubySourceFile(n)) rbFiles.push(n);
  }
  const indexed = (norm: string): string | undefined => storedByNorm.get(norm);

  // ── Load-path roots ──────────────────────────────────────────────────────
  const roots = new Set<string>(['']);
  const zeitwerkRoots = new Set<string>();
  for (const f of rbFiles) {
    const segs = dirOf(f).split('/');
    if (segs.length === 1 && segs[0] === '') continue;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const prefix = segs.slice(0, i + 1).join('/');
      if (seg === 'lib') {
        roots.add(prefix);
        zeitwerkRoots.add(prefix);
      } else if (i > 0 && segs[i - 1] === 'app') {
        roots.add(prefix);
        zeitwerkRoots.add(prefix);
        if (segs[i + 1] === 'concerns') {
          const concerns = `${prefix}/concerns`;
          roots.add(concerns);
          zeitwerkRoots.add(concerns);
        }
      }
    }
  }
  // Evidence roots: an importer below A requires `x/y` and `A/x/y.rb` exists.
  if (rbFiles.length > 0) {
    const rows = db
      .prepare<[string], { source_file: string; specifier: string }>(
        'SELECT source_file, specifier FROM import_records WHERE repo_id = ?',
      )
      .all(repoId);
    for (const { source_file, specifier } of rows) {
      if (!isRubySourceFile(source_file)) continue;
      if (specifier.startsWith('.') || specifier.indexOf('/') < 0) continue;
      if (CONSTANT_PATH.test(specifier)) continue;
      const rel = `${specifier.replace(/\.rb$/, '')}.rb`;
      let dir: string | null = dirOf(normalize(source_file));
      while (dir !== null) {
        if (indexed(joinNorm(dir, rel)) !== undefined) {
          roots.add(dir);
          zeitwerkRoots.add(dir);
        }
        dir = dir === '' ? null : dirOf(dir);
      }
    }
  }
  const rootList = [...roots];
  const zeitwerkList = [...zeitwerkRoots, ''];

  // ── Symbol table (Zeitwerk fallback): constant SEGMENT → declaring files ──
  // `module Admin; class User` declares `Admin` and `User` in one file, and
  // the compact `class Admin::User` declares the symbol `Admin::User` — both
  // register the file under each segment, so a lookup for `Admin::User`
  // intersects the declarers of `Admin` and of `User`.
  let segmentFiles: Map<string, Set<string>> | null = null;
  const symbolTable = (): Map<string, Set<string>> => {
    if (segmentFiles) return segmentFiles;
    segmentFiles = new Map();
    const rbSet = new Set(rbFiles);
    const rows = db
      .prepare<[string], { name: string; kind: string; file_path: string }>(
        "SELECT name, kind, file_path FROM symbols WHERE repo_id = ? AND kind IN ('class', 'type')",
      )
      .all(repoId);
    for (const { name, file_path } of rows) {
      const n = normalize(file_path);
      if (!rbSet.has(n)) continue;
      for (const seg of name.split('::')) {
        if (seg.length === 0) continue;
        const set = segmentFiles.get(seg);
        if (set) set.add(n);
        else segmentFiles.set(seg, new Set([n]));
      }
    }
    return segmentFiles;
  };

  /** Files declaring EVERY segment of a constant path (empty when any segment is unknown). */
  const declarersOf = (full: string): string[] => {
    const table = symbolTable();
    const segs = full.split('::');
    const first = table.get(segs[0] ?? '');
    if (!first) return [];
    let acc: string[] = [...first];
    for (const seg of segs.slice(1)) {
      const set = table.get(seg);
      if (!set) return [];
      acc = acc.filter((f) => set.has(f));
      if (acc.length === 0) return [];
    }
    return acc;
  };

  const finish = (candidates: string[], sourceFile: string): string[] => {
    const src = normalize(sourceFile);
    const own = hygiene(
      candidates.filter((c) => c !== src),
      sourceFile,
    );
    return preferNearest(own, sourceFile).map((n) => indexed(n) ?? n);
  };

  function resolveRequire(spec: string, sourceFile: string): string[] {
    if (/\.(so|bundle|o|dll)$/.test(spec)) return [];
    const rel = `${spec.replace(/\.rb$/, '')}.rb`;
    const first = rel.split('/')[0].replace(/\.rb$/, '');
    if (reserved.has(first)) return [];
    const hits: string[] = [];
    for (const root of rootList) {
      const cand = joinNorm(root, rel);
      if (indexed(cand) !== undefined) hits.push(cand);
    }
    return finish(hits, sourceFile);
  }

  function resolveRelativeRequire(spec: string, sourceFile: string): string[] {
    const target = resolveRelative(dirOf(normalize(sourceFile)), spec.replace(/\.rb$/, ''));
    if (target === null) return [];
    const cand = `${target}.rb`;
    return indexed(cand) !== undefined ? finish([cand], sourceFile) : [];
  }

  /**
   * Ruby constant lookup replayed on the file system: for a reference written
   * inside `module A; module B`, try `A::B::C`, then `A::C`, then `C` —
   * first as a Zeitwerk path under every root, then as a symbol-table match
   * that must be UNIQUE (one file declares every segment). Never a fan-out.
   */
  function resolveConstant(spec: string, sourceFile: string, nesting: string[]): string[] {
    const scopes: string[] = [];
    const segs = nesting.flatMap((n) => n.split('::')).filter((n) => n.length > 0);
    for (let i = segs.length; i >= 0; i--) scopes.push(segs.slice(0, i).join('::'));
    const fulls = scopes.map((scope) => (scope ? `${scope}::${spec}` : spec));

    const src = normalize(sourceFile);
    for (const full of fulls) {
      const segsOfFull = full.split('::');
      const last = segsOfFull[segsOfFull.length - 1];
      const rel = `${segsOfFull.map(underscoreRuby).join('/')}.rb`;
      const hits: string[] = [];
      for (const root of zeitwerkList) {
        const cand = joinNorm(root, rel);
        if (indexed(cand) !== undefined) hits.push(cand);
      }
      // `underscore` is lossy (`PATH` and `Path` both map to `path.rb`): when
      // the index declares the constant somewhere, the hit must be a declarer.
      const declarers = symbolTable().get(last);
      const consistent = declarers ? hits.filter((h) => declarers.has(h)) : hits;
      // The importer itself answers → the constant is local; no edge, no guess.
      if (consistent.includes(src)) return [];
      const byPath = finish(consistent, sourceFile);
      if (byPath.length > 0) return byPath;
    }
    // Uniqueness is judged over the WHOLE index, before hygiene: `Base` declared
    // in one first-party file and six vendored gems is still ambiguous (brew's
    // `RuboCop::Cop::Base` is the gem's, not `Cask::DSL::Base`).
    for (const full of fulls) {
      const declared = declarersOf(full);
      if (declared.includes(src)) return [];
      if (declared.length === 0) continue;
      if (declared.length > 1) return []; // ambiguous at this scope — Ruby would pick one, we do not guess
      const clean = hygiene(declared, sourceFile);
      return clean.length === 1 ? [indexed(clean[0]) ?? clean[0]] : [];
    }
    return [];
  }

  return {
    resolve(specifier: string, sourceFile: string, nesting: string[] = []): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];
      if (spec.startsWith('.')) return resolveRelativeRequire(spec, sourceFile);
      if (CONSTANT_PATH.test(spec)) return resolveConstant(spec, sourceFile, nesting);
      return resolveRequire(spec, sourceFile);
    },
    roots: () => [...rootList].sort(),
  };
}
