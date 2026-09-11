/**
 * Symbol-level `ref` edges (Phase 101, Task 630).
 *
 * Derives "symbol S in file A refers to symbol T in file B" from three facts
 * the index already holds — never from a fresh parse (P2):
 *   1. A's import records (`importedNames`, per specifier) and the file edges
 *      those records produced (local or cross-index);
 *   2. B's symbol table (from B's own index when the edge crosses a link);
 *   3. A's bytes and its symbols' byte spans.
 *
 * One alternation regex runs over A ONCE; each hit is attributed to the
 * innermost symbol span that contains it (a class span contains its methods'
 * spans — per-span scanning would double-count). Hits outside every span
 * (module-level statements, the import lines themselves) produce nothing:
 * the file edge already covers them.
 *
 * Every edge is `confidence: 'lexical'` (P3): a word-boundary text match.
 * Shadowed locals, strings and comments are false positives by construction.
 * The rules that keep the rate down: a name A itself declares is never
 * matched (shadow rule); a bare token is never matched right after `.`
 * (member access on some other object); open imports (`*`, package/namespace
 * imports) are capped by `graph.maxWildcardFanout`.
 *
 * Per-language matching rules: dev-docs/in-progress/phase101-design.md §3.
 */
import type { DepEdge, ImportRecord, SymbolRecord } from '../core/types.js';
import type { SymbolRef } from '../core/db/symbol-ref-store.js';
import { buildOffsetConverter } from '../core/offsets.js';

// ─── Index view ───────────────────────────────────────────────────────────────

/**
 * What the builder needs from ONE index. The index manager supplies a view
 * over the local database and one per linked index (open during the build).
 */
export interface RefIndexView {
  repoId: string;
  symbolsByFile(path: string): SymbolRecord[];
  importRecordsByFile(path: string): ImportRecord[];
  /** File edges out of `path`, INCLUDING cross rows (`targetRepoId` set). */
  forwardDeps(path: string): DepEdge[];
  fileContent(path: string): Buffer | null;
}

export interface BuildSymbolEdgesOptions {
  /** Cap on names an open import may expand to per (source, target) pair. 0 = uncapped. */
  maxWildcardFanout: number;
  /** Re-export hops followed when the imported name is not declared in the target file. Default 3. */
  maxReExportHops?: number;
  /** Linked indexes by repoId (Phase 99 workspace) — targets of cross edges. */
  links?: Map<string, RefIndexView>;
}

export interface SymbolEdgeBuildResult {
  refs: SymbolRef[];
  /** Source files that had at least one file edge and were scanned. */
  filesScanned: number;
  /** (source, target) pairs whose open-import expansion hit the fanout cap. */
  cappedExpansions: number;
}

// ─── Per-family rules ─────────────────────────────────────────────────────────

type Sep = '.' | '::';

interface FamilyRule {
  /** Qualifier separator for `q<sep>Name` forms. */
  sep: Sep;
  /** Meaning of an import record with NO names: all bare names, a qualified package, or nothing. */
  emptyNames: 'bare' | 'qualified' | 'none';
  /** Qualifier for `emptyNames: 'qualified'` (Go package, Python module). */
  qualifierOf?: (specifier: string) => string | null;
  /** Treat every record as an open bare import regardless of names (Fortran USE). */
  ignoreNames?: boolean;
}

const DEFAULT_RULE: FamilyRule = { sep: '.', emptyNames: 'bare' };

function goQualifier(spec: string): string | null {
  const parts = spec.split('/').filter(Boolean);
  let last = parts[parts.length - 1] ?? '';
  // Module-path version suffix: `github.com/x/y/v2` → package `y`.
  if (/^v\d+$/.test(last) && parts.length >= 2) last = parts[parts.length - 2]!;
  // `gopkg.in/yaml.v3` → `yaml`.
  last = last.replace(/\.v\d+$/, '');
  return /^[A-Za-z_]\w*$/.test(last) ? last : null;
}

const RULES: Record<string, FamilyRule> = {
  '.go': { sep: '.', emptyNames: 'qualified', qualifierOf: goQualifier },
  // `import a.b` binds `a` and is used as `a.b.X`; the full dotted path is the qualifier.
  '.py': { sep: '.', emptyNames: 'qualified', qualifierOf: (s) => (/^[\w.]+$/.test(s) ? s : null) },
  '.pyi': { sep: '.', emptyNames: 'qualified', qualifierOf: (s) => (/^[\w.]+$/.test(s) ? s : null) },
  '.rs': { sep: '::', emptyNames: 'bare' },
  '.php': { sep: '::', emptyNames: 'bare' },
  '.c': { sep: '::', emptyNames: 'bare' },
  '.h': { sep: '::', emptyNames: 'bare' },
  '.cpp': { sep: '::', emptyNames: 'bare' },
  '.cc': { sep: '::', emptyNames: 'bare' },
  '.cxx': { sep: '::', emptyNames: 'bare' },
  '.c++': { sep: '::', emptyNames: 'bare' },
  '.hpp': { sep: '::', emptyNames: 'bare' },
  '.hh': { sep: '::', emptyNames: 'bare' },
  '.hxx': { sep: '::', emptyNames: 'bare' },
  '.h++': { sep: '::', emptyNames: 'bare' },
  '.f90': { sep: '.', emptyNames: 'bare', ignoreNames: true },
  '.f95': { sep: '.', emptyNames: 'bare', ignoreNames: true },
  '.f03': { sep: '.', emptyNames: 'bare', ignoreNames: true },
  '.f08': { sep: '.', emptyNames: 'bare', ignoreNames: true },
  '.for': { sep: '.', emptyNames: 'bare', ignoreNames: true },
  '.f': { sep: '.', emptyNames: 'bare', ignoreNames: true },
};

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? '' : filePath.slice(dot).toLowerCase();
}

function ruleFor(filePath: string): FamilyRule {
  return RULES[extOf(filePath)] ?? DEFAULT_RULE;
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/** Kinds an import can name at the top level — members are never open-import candidates. */
const MEMBER_KINDS = new Set(['method', 'property']);

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const MIN_OPEN_NAME_LENGTH = 2;

function escapeRe(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

/** `Class.method` → `Class`; `run` → `run`. */
function ownerOf(name: string): string {
  const dot = name.indexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

/** The importable (top-level) names a file declares, in declaration order, deduplicated. */
function declaredNames(symbols: SymbolRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (MEMBER_KINDS.has(s.kind)) continue;
    const n = ownerOf(s.name);
    if (!IDENT_RE.test(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Symbols of a file whose bare name is `name` (owner part for `Class.member`; exact for members). */
function symbolsNamed(symbols: SymbolRecord[], name: string, includeMembers: boolean): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const s of symbols) {
    if (MEMBER_KINDS.has(s.kind)) {
      // A static import of a method (`import static a.B.run`) targets the method itself.
      if (includeMembers && (s.name === name || s.name.endsWith(`.${name}`))) out.push(s);
      continue;
    }
    if (s.name === name || ownerOf(s.name) === name) out.push(s);
  }
  return out;
}

// ─── Target resolution ────────────────────────────────────────────────────────

interface TargetSymbol {
  repoId: string | null; // null = local index
  file: string;
  symbol: SymbolRecord;
}

interface Token {
  /** Canonical text: `Name` or `q<sep>Name` (whitespace-free). */
  key: string;
  /** Bare name that matched (for the row's `name` column). */
  name: string;
  targets: TargetSymbol[];
}

class ViewCache {
  private readonly symbols = new Map<string, SymbolRecord[]>();
  private readonly records = new Map<string, ImportRecord[]>();
  private readonly deps = new Map<string, DepEdge[]>();
  constructor(
    private readonly local: RefIndexView,
    private readonly links: Map<string, RefIndexView>,
  ) {}

  view(repoId: string | null): RefIndexView | undefined {
    return repoId === null || repoId === this.local.repoId ? this.local : this.links.get(repoId);
  }
  symbolsOf(repoId: string | null, file: string): SymbolRecord[] {
    const k = `${repoId ?? ''}\0${file}`;
    let v = this.symbols.get(k);
    if (!v) {
      v = this.view(repoId)?.symbolsByFile(file) ?? [];
      this.symbols.set(k, v);
    }
    return v;
  }
  recordsOf(repoId: string | null, file: string): ImportRecord[] {
    const k = `${repoId ?? ''}\0${file}`;
    let v = this.records.get(k);
    if (!v) {
      v = this.view(repoId)?.importRecordsByFile(file) ?? [];
      this.records.set(k, v);
    }
    return v;
  }
  depsOf(repoId: string | null, file: string): DepEdge[] {
    const k = `${repoId ?? ''}\0${file}`;
    let v = this.deps.get(k);
    if (!v) {
      v = this.view(repoId)?.forwardDeps(file) ?? [];
      this.deps.set(k, v);
    }
    return v;
  }
}

/** Does a stored record (by its names) offer `name` to importers of its file? */
function recordOffers(rec: ImportRecord, name: string): boolean {
  for (const n of rec.importedNames) {
    if (n === '*' || n === name) return true;
  }
  return false;
}

/**
 * `name` was imported from `file` but `file` declares no such symbol. Follow
 * `file`'s own imports that carry the name (a barrel's `export { x } from`,
 * `export * from`, a Python package `__init__` re-import) up to `maxHops`.
 */
function resolveThroughReExports(
  cache: ViewCache,
  repoId: string | null,
  file: string,
  name: string,
  hop: number,
  maxHops: number,
  seen: Set<string>,
): TargetSymbol[] {
  const key = `${repoId ?? ''}\0${file}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const here = symbolsNamed(cache.symbolsOf(repoId, file), name, false);
  if (here.length > 0) return here.map((symbol) => ({ repoId, file, symbol }));
  if (hop >= maxHops) return [];

  const offering = new Set<string>();
  for (const rec of cache.recordsOf(repoId, file)) {
    if (recordOffers(rec, name)) offering.add(rec.specifier);
  }
  if (offering.size === 0) return [];

  const out: TargetSymbol[] = [];
  for (const edge of cache.depsOf(repoId, file)) {
    if (!offering.has(edge.specifier)) continue;
    const nextRepo = edge.targetRepoId ?? repoId;
    if (nextRepo !== null && !cache.view(nextRepo)) continue; // link not in this workspace
    out.push(...resolveThroughReExports(cache, nextRepo, edge.targetFile, name, hop + 1, maxHops, seen));
  }
  return out;
}

// ─── Token planning for one source file ───────────────────────────────────────

interface FilePlan {
  tokens: Map<string, Token>;
  capped: number;
}

function planTokens(
  cache: ViewCache,
  sourceFile: string,
  shadow: Set<string>,
  opts: Required<Pick<BuildSymbolEdgesOptions, 'maxWildcardFanout' | 'maxReExportHops'>>,
): FilePlan {
  const rule = ruleFor(sourceFile);
  const tokens = new Map<string, Token>();
  let capped = 0;

  const addToken = (key: string, name: string, targets: TargetSymbol[]) => {
    if (targets.length === 0) return;
    let t = tokens.get(key);
    if (!t) {
      t = { key, name, targets: [] };
      tokens.set(key, t);
    }
    const have = new Set(t.targets.map((x) => `${x.repoId ?? ''}\0${x.symbol.id}`));
    for (const x of targets) {
      const k = `${x.repoId ?? ''}\0${x.symbol.id}`;
      if (!have.has(k)) {
        have.add(k);
        t.targets.push(x);
      }
    }
  };

  /**
   * All importable names of the target, capped, shadow-filtered. Bare
   * expansions also drop one-character names (`T`, `_` — noise); a qualifier
   * (`ns.a`, `m::f`) disambiguates, so qualified expansions keep them.
   */
  const openNames = (targetRepo: string | null, targetFile: string, qualified: boolean): string[] => {
    const decl = declaredNames(cache.symbolsOf(targetRepo, targetFile)).filter(
      (n) => (qualified || n.length >= MIN_OPEN_NAME_LENGTH) && !shadow.has(n),
    );
    if (opts.maxWildcardFanout > 0 && decl.length > opts.maxWildcardFanout) {
      capped++;
      return decl.slice(0, opts.maxWildcardFanout);
    }
    return decl;
  };

  const addBareOpen = (targetRepo: string | null, targetFile: string) => {
    const symbols = cache.symbolsOf(targetRepo, targetFile);
    for (const n of openNames(targetRepo, targetFile, false)) {
      addToken(
        n,
        n,
        symbolsNamed(symbols, n, false).map((symbol) => ({ repoId: targetRepo, file: targetFile, symbol })),
      );
    }
  };

  const addQualifiedOpen = (qualifier: string, targetRepo: string | null, targetFile: string) => {
    const symbols = cache.symbolsOf(targetRepo, targetFile);
    for (const n of openNames(targetRepo, targetFile, true)) {
      addToken(
        `${qualifier}${rule.sep}${n}`,
        n,
        symbolsNamed(symbols, n, false).map((symbol) => ({ repoId: targetRepo, file: targetFile, symbol })),
      );
    }
  };

  // Records grouped by specifier — several `import` lines of one module merge
  // (the file edge is one row per target). A record with NO names is kept as
  // the sentinel '' so `import util` next to `import u "util"` still yields the
  // plain-package qualifier (merging would otherwise drop it).
  const PLAIN = '';
  const namesBySpecifier = new Map<string, string[]>();
  for (const rec of cache.recordsOf(null, sourceFile)) {
    const list = namesBySpecifier.get(rec.specifier) ?? [];
    if (rec.importedNames.length === 0) list.push(PLAIN);
    else list.push(...rec.importedNames);
    namesBySpecifier.set(rec.specifier, list);
  }

  for (const edge of cache.depsOf(null, sourceFile)) {
    const targetRepo = edge.targetRepoId ?? null;
    if (targetRepo !== null && !cache.view(targetRepo)) continue; // unlinked / unopened — file edge only
    const targetFile = edge.targetFile;
    const targetSymbols = cache.symbolsOf(targetRepo, targetFile);
    // No record for this edge (prefilled / side-effect import) → the plain rule.
    const names = rule.ignoreNames ? [PLAIN] : (namesBySpecifier.get(edge.specifier) ?? [PLAIN]);

    for (const raw of names) {
      if (raw === PLAIN) {
        if (rule.ignoreNames || rule.emptyNames === 'bare') {
          addBareOpen(targetRepo, targetFile);
        } else if (rule.emptyNames === 'qualified') {
          const q = rule.qualifierOf?.(edge.specifier) ?? null;
          if (q) addQualifiedOpen(q, targetRepo, targetFile);
        }
        continue;
      }
      if (raw === '*') {
        addBareOpen(targetRepo, targetFile);
        continue;
      }
      if (raw.startsWith('* as ')) {
        const alias = raw.slice(5).trim();
        if (IDENT_RE.test(alias) && !shadow.has(alias)) addQualifiedOpen(alias, targetRepo, targetFile);
        continue;
      }
      // Scala `import a.b._` / `._` wildcard arrives as an empty list; a `_` name is the same thing.
      if (raw === '_') {
        addBareOpen(targetRepo, targetFile);
        continue;
      }
      if (!IDENT_RE.test(raw) || shadow.has(raw)) continue; // shadow rule (P3)

      // (1) declared in the target → bare token (members included: static method imports).
      const direct = symbolsNamed(targetSymbols, raw, true);
      if (direct.length > 0) {
        addToken(raw, raw, direct.map((symbol) => ({ repoId: targetRepo, file: targetFile, symbol })));
        continue;
      }
      // (2) not declared there → a re-export chain (barrel) …
      const viaChain = resolveThroughReExports(
        cache, targetRepo, targetFile, raw, 0, opts.maxReExportHops, new Set(),
      );
      if (viaChain.length > 0) {
        addToken(raw, raw, viaChain);
        continue;
      }
      // (3) … or the name IS the module (`use a::m;` then `m::f()`, `import utils from './utils'`
      //     then `utils.helper()`): qualified form over the target's names.
      addQualifiedOpen(raw, targetRepo, targetFile);
    }
  }

  return { tokens, capped };
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

/** Bare tokens: not preceded by an identifier char or `.` (member access), not followed by one. */
function buildRegex(tokens: Map<string, Token>, sep: Sep): RegExp | null {
  const bare: string[] = [];
  const qualified = new Map<string, string[]>(); // qualifier → names
  for (const key of tokens.keys()) {
    const at = key.lastIndexOf(sep);
    if (at < 0) {
      bare.push(key);
    } else {
      const q = key.slice(0, at);
      const n = key.slice(at + sep.length);
      const list = qualified.get(q) ?? [];
      list.push(n);
      qualified.set(q, list);
    }
  }
  const parts: string[] = [];
  const sepRe = sep === '.' ? '\\s*\\.\\s*' : '\\s*::\\s*';
  for (const [q, names] of qualified) {
    const qRe = q.split(sep).map(escapeRe).join(sepRe);
    names.sort((a, b) => b.length - a.length);
    parts.push(`${qRe}${sepRe}(?:${names.map(escapeRe).join('|')})`);
  }
  if (bare.length > 0) {
    bare.sort((a, b) => b.length - a.length);
    parts.push(`(?:${bare.map(escapeRe).join('|')})`);
  }
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\w$.:])(?:${parts.join('|')})(?![\\w$])`, 'g');
}

/** Innermost symbol whose span contains `byte`; symbols sorted by startByte. */
function innermostAt(sorted: SymbolRecord[], byte: number): SymbolRecord | null {
  // Upper bound: last symbol with startByte <= byte.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].startByte <= byte) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    const s = sorted[i];
    if (s.endByte > byte) return s; // last-starting container = innermost for nested spans
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build `ref` rows for `sourceFiles` of the LOCAL index. Callers delete the
 * files' previous rows first (the store's `deleteSymbolRefsBySource`) — the
 * builder is pure.
 */
export function buildSymbolEdges(
  local: RefIndexView,
  sourceFiles: Iterable<string>,
  options: BuildSymbolEdgesOptions,
): SymbolEdgeBuildResult {
  const cache = new ViewCache(local, options.links ?? new Map<string, RefIndexView>());
  const opts = {
    maxWildcardFanout: options.maxWildcardFanout,
    maxReExportHops: options.maxReExportHops ?? 3,
  };
  const refs: SymbolRef[] = [];
  let filesScanned = 0;
  let cappedExpansions = 0;

  for (const sourceFile of sourceFiles) {
    const deps = cache.depsOf(null, sourceFile);
    if (deps.length === 0) continue;
    const ownSymbols = cache.symbolsOf(null, sourceFile);
    if (ownSymbols.length === 0) continue; // nothing to attribute a hit to

    // Shadow set: every bare name this file declares (P3 — prefer a missed edge to a false one).
    const shadow = new Set<string>();
    for (const s of ownSymbols) {
      shadow.add(s.name);
      shadow.add(ownerOf(s.name));
      const dot = s.name.lastIndexOf('.');
      if (dot >= 0) shadow.add(s.name.slice(dot + 1));
    }

    const plan = planTokens(cache, sourceFile, shadow, opts);
    cappedExpansions += plan.capped;
    if (plan.tokens.size === 0) continue;

    const content = local.fileContent(sourceFile);
    if (!content) continue;
    filesScanned++;

    const rule = ruleFor(sourceFile);
    const re = buildRegex(plan.tokens, rule.sep);
    if (!re) continue;

    const text = content.toString('utf8');
    const conv = buildOffsetConverter(content, text);
    const sorted = [...ownSymbols].sort((a, b) => a.startByte - b.startByte || b.endByte - a.endByte);

    // (sourceSymbolId, targetRepoId, targetSymbolId) → aggregate
    const agg = new Map<string, SymbolRef>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[0].replace(/\s+/g, '');
      const token = plan.tokens.get(key);
      if (!token) continue;
      const byte = conv.charToByte(m.index);
      const holder = innermostAt(sorted, byte);
      if (!holder) continue;
      for (const t of token.targets) {
        // A symbol never references itself through an import (same-file targets cannot occur —
        // imports are cross-file — but a re-export chain can loop back).
        if (t.repoId === null && t.symbol.id === holder.id && t.file === sourceFile) continue;
        const k = `${holder.id}\0${t.repoId ?? ''}\0${t.symbol.id}`;
        const existing = agg.get(k);
        if (existing) {
          existing.refCount++;
        } else {
          agg.set(k, {
            repoId: local.repoId,
            sourceFile,
            sourceSymbolId: holder.id,
            targetFile: t.file,
            targetSymbolId: t.symbol.id,
            targetRepoId: t.repoId,
            name: token.name,
            confidence: 'lexical',
            refCount: 1,
          });
        }
      }
    }
    for (const r of agg.values()) refs.push(r);
  }

  return { refs, filesScanned, cappedExpansions };
}
