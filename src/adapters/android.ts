/**
 * Android framework adapter (Phase 85).
 *
 * Makes Compose UI, Hilt/Dagger DI, manifest entry points, and Gradle module
 * structure first-class:
 *
 *   @Composable fun HomeScreen()          → kind upgraded to 'composable'
 *                                           (+ frameworkMeta.android='compose',
 *                                            preview flag for @Preview funs)
 *   @Module / @Provides / @Binds /
 *   @Inject constructor / @HiltViewModel /
 *   @AndroidEntryPoint / scope annotations → frameworkMeta.di on the symbol
 *                                           (edges are built later by
 *                                            src/graph/di-edges.ts — adapters
 *                                            emit symbols only)
 *   AndroidManifest.xml components         → 'route' symbols with
 *                                           frameworkMeta.android='manifest'
 *                                           (activity/service/receiver/provider,
 *                                            exported + intent filters + LAUNCHER)
 *   Gradle module ownership                → frameworkMeta.gradleModule on every
 *                                           .kt/.java/manifest symbol, derived
 *                                           from the path segments before the
 *                                           first `src/` boundary (':app',
 *                                           ':feature:login', ':' for root).
 *
 * Statelessness rule (Phase 75 lesson): worker threads resolve adapters by name
 * from their own registry, so nothing computed in detect() may be relied on
 * later. All extraction derives from file path + file content alone. The only
 * module state is a bounded per-file annotation-facts cache that is written in
 * extractFrameworkSymbols and read synchronously afterwards by enrichMetadata
 * for the same file (no await between the two in processFile).
 *
 * Annotation extraction is regex/event-based (like spring-kotlin) — v1 bounds:
 * no KSP output, no qualifier (@Named) tracking beyond ignoring them, Java
 * field injection is attributed to the last class declared before the field.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync, type Dirent } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { DETECT_IGNORE_DIRS, DETECT_MAX_DEPTH, DETECT_MAX_DIRS } from './detect-utils.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

/** Last '.'-segment of a possibly qualified name ('Foo.bar' → 'bar'). */
function bareName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Char index → byte offset (handlers/adapters must store byte offsets). */
function byteOffset(text: string, charIdx: number): number {
  return Buffer.byteLength(text.slice(0, charIdx), 'utf8');
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Bounded recursive scan for Android markers: an AndroidManifest.xml anywhere,
 * or a build.gradle(.kts) applying com.android.application / com.android.library.
 * scanForFramework() only matches file names + package.json content, so this
 * is a sibling scan with the same bounds and ignore set.
 */
function scanForAndroid(
  dir: string,
  depth = 0,
  budget: { dirs: number } = { dirs: 0 },
): boolean {
  if (depth > DETECT_MAX_DEPTH || budget.dirs >= DETECT_MAX_DIRS) return false;
  budget.dirs++;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  const subDirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      if (e.name === 'AndroidManifest.xml') return true;
      if (e.name === 'build.gradle' || e.name === 'build.gradle.kts') {
        try {
          const content = readFileSync(`${dir}/${e.name}`, 'utf8');
          if (
            content.includes('com.android.application') ||
            content.includes('com.android.library')
          ) {
            return true;
          }
        } catch {
          // unreadable build file — ignore
        }
      }
    } else if (e.isDirectory() && !DETECT_IGNORE_DIRS.has(e.name)) {
      subDirs.push(e.name);
    }
  }

  for (const name of subDirs) {
    if (scanForAndroid(`${dir}/${name}`, depth + 1, budget)) return true;
  }
  return false;
}

// ─── Per-file annotation facts (Compose + DI) ─────────────────────────────────

export interface DiMeta {
  role?: 'module' | 'provider' | 'consumer';
  /** Return type of a @Provides/@Binds fun — generics stripped, may be qualified. */
  providedType?: string;
  /** Constructor/field/@Binds parameter types — generics stripped. */
  consumedTypes?: string[];
  /** True for @Binds bindings (providedType = bound interface). */
  binds?: boolean;
  /** Scope annotation name (Singleton, ViewModelScoped, …). */
  scope?: string;
  hiltViewModel?: boolean;
  androidEntryPoint?: boolean;
  /** Class has an @Inject constructor — it is itself injectable (a provider of its own type). */
  injectConstructor?: boolean;
  /** Class has @Inject fields (Java/Kotlin field injection). */
  injectedFields?: boolean;
}

export interface FileFacts {
  /** Bare fun name → compose facts. */
  composables: Map<string, { preview: boolean }>;
  /** Bare declaration name (fun or class) → DI facts. */
  di: Map<string, DiMeta>;
}

// Bounded cache written by extractFrameworkSymbols, read by enrichMetadata for
// the same file within the same processFile call. Cleared wholesale when full.
const factsCache = new Map<string, FileFacts>();
const FACTS_CACHE_MAX = 256;

function putFacts(filePath: string, facts: FileFacts): void {
  if (factsCache.size >= FACTS_CACHE_MAX) factsCache.clear();
  factsCache.set(filePath, facts);
}

/** Test hook — inspect/clear the facts cache. */
export function _factsCacheForTesting(): Map<string, FileFacts> {
  return factsCache;
}

const SCOPE_ANNOS = new Set([
  'Singleton',
  'Reusable',
  'ActivityScoped',
  'ActivityRetainedScoped',
  'ViewModelScoped',
  'ServiceScoped',
  'FragmentScoped',
  'ViewScoped',
]);

const MARKER_ANNOS = new Set([
  'Composable',
  'Preview',
  'Module',
  'Provides',
  'Binds',
  'Inject',
  'HiltViewModel',
  'AndroidEntryPoint',
]);

function isInterestingAnno(name: string): boolean {
  return MARKER_ANNOS.has(name) || SCOPE_ANNOS.has(name);
}

/**
 * True when the annotation at charIdx sits in TYPE position (`content:
 * @Composable () -> Unit`) or leads a parameter (`(@Composable content: …`),
 * not in declaration position. Declaration annotations follow a newline, '}',
 * ')' (a previous annotation's argument list), or another annotation name.
 */
function isTypePositionAnno(text: string, charIdx: number): boolean {
  for (let i = charIdx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ' ' || c === '\t') continue;
    return c === ':' || c === ',' || c === '(';
  }
  return false;
}

/** Index just past the ')' matching the '(' at openIdx, or -1. */
function scanParens(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Split on top-level commas — respects <> and () nesting ('-> Unit' safe). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<' || ch === '(') depth++;
    else if ((ch === '>' || ch === ')') && depth > 0) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function topLevelIndexOf(text: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' || ch === '(') depth++;
    else if ((ch === '>' || ch === ')') && depth > 0) depth--;
    else if (ch === needle && depth === 0) return i;
  }
  return -1;
}

/**
 * Normalize a type expression to a matchable name: strip parameter annotations,
 * modifiers, generics, nullability, arrays. Returns null for non-nominal types
 * (lambdas, wildcards).
 */
export function cleanType(raw: string): string | null {
  let t = raw.trim();
  t = t.replace(/@[\w.]+(\s*\([^)]*\))?\s*/g, '');
  t = t.replace(/\b(vararg|final|out|in|crossinline|noinline)\s+/g, '');
  const lt = t.indexOf('<');
  if (lt >= 0) t = t.slice(0, lt);
  t = t.replace(/\.\.\./g, '').replace(/\[\]$/, '').replace(/[?!]+$/, '').trim();
  if (!t || !/^[A-Za-z_][\w.]*$/.test(t)) return null;
  return t;
}

/** Kotlin parameter list text → cleaned param types. */
function kotlinParamTypes(paramText: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(paramText)) {
    let p = part;
    const eq = topLevelIndexOf(p, '=');
    if (eq >= 0) p = p.slice(0, eq);
    const colon = topLevelIndexOf(p, ':');
    if (colon < 0) continue;
    const t = cleanType(p.slice(colon + 1));
    if (t) out.push(t);
  }
  return out;
}

/** Java parameter list text → cleaned param types. */
function javaParamTypes(paramText: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(paramText)) {
    const p = part
      .replace(/@[\w.]+(\s*\([^)]*\))?\s*/g, '')
      .replace(/\bfinal\s+/g, '')
      .trim();
    const lastSpace = p.lastIndexOf(' ');
    if (lastSpace <= 0) continue;
    const t = cleanType(p.slice(0, lastSpace));
    if (t) out.push(t);
  }
  return out;
}

function mergeDi(facts: FileFacts, name: string, meta: DiMeta): void {
  const existing = facts.di.get(name);
  if (!existing) {
    facts.di.set(name, meta);
    return;
  }
  const consumed = [
    ...(existing.consumedTypes ?? []),
    ...(meta.consumedTypes ?? []),
  ];
  facts.di.set(name, {
    ...existing,
    ...meta,
    role: existing.role ?? meta.role,
    ...(consumed.length > 0 ? { consumedTypes: [...new Set(consumed)] } : {}),
  });
}

// ─── Kotlin fact collection ───────────────────────────────────────────────────

interface Ev {
  pos: number;
  type: 'anno' | 'fun' | 'class' | 'ctor' | 'var' | 'jmethod' | 'jctor' | 'jfield';
  name?: string;
  /** For fun/ctor/jmethod/jctor: char index of the opening '('. */
  parenIdx?: number;
  /** For jmethod: return type text; for var/jfield: declared type text. */
  typeText?: string;
}

export function collectKotlinFacts(text: string): FileFacts {
  const facts: FileFacts = { composables: new Map(), di: new Map() };
  const events: Ev[] = [];
  let m: RegExpExecArray | null;

  const annoRe = /@(?:field:|get:|set:|param:)?(\w+)/g;
  while ((m = annoRe.exec(text)) !== null) {
    const name = m[1];
    if (!isInterestingAnno(name)) continue;
    if (isTypePositionAnno(text, m.index)) continue;
    events.push({ pos: m.index, type: 'anno', name });
  }

  const funRe = /\bfun\s+(?:<[^>]*>\s*)?([A-Za-z_][\w.]*)\s*\(/g;
  while ((m = funRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'fun', name: m[1], parenIdx: m.index + m[0].length - 1 });
  }

  const classRe = /\b(?:class|object|interface)\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'class', name: m[1] });
  }

  const ctorRe = /\bconstructor\s*\(/g;
  while ((m = ctorRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'ctor', parenIdx: m.index + m[0].length - 1 });
  }

  const varRe = /\b(?:val|var)\s+(\w+)\s*:\s*([A-Za-z_][\w.<>?]*)/g;
  while ((m = varRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'var', name: m[1], typeText: m[2] });
  }

  events.sort((a, b) => a.pos - b.pos);

  let pending: string[] = [];
  let lastClass: string | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'anno':
        pending.push(ev.name!);
        break;

      case 'class': {
        const meta: DiMeta = {};
        if (pending.includes('Module')) meta.role = 'module';
        if (pending.includes('HiltViewModel')) meta.hiltViewModel = true;
        if (pending.includes('AndroidEntryPoint')) meta.androidEntryPoint = true;
        const scope = pending.find((a) => SCOPE_ANNOS.has(a));
        if (scope) meta.scope = scope;
        if (Object.keys(meta).length > 0) mergeDi(facts, ev.name!, meta);
        lastClass = ev.name!;
        pending = [];
        break;
      }

      case 'fun': {
        const bare = bareName(ev.name!);
        if (pending.includes('Composable')) {
          facts.composables.set(bare, { preview: pending.includes('Preview') });
        }
        if (pending.includes('Provides') || pending.includes('Binds')) {
          const isBinds = pending.includes('Binds');
          const paramEnd = scanParens(text, ev.parenIdx!);
          const meta: DiMeta = { role: 'provider' };
          if (paramEnd > 0) {
            const retM = text.slice(paramEnd).match(/^\s*:\s*([^={\n]+)/);
            if (retM) {
              const ret = cleanType(retM[1]);
              if (ret) meta.providedType = ret;
            }
            if (isBinds) {
              const pts = kotlinParamTypes(text.slice(ev.parenIdx! + 1, paramEnd - 1));
              if (pts.length > 0) meta.consumedTypes = pts;
            }
          }
          if (isBinds) meta.binds = true;
          const scope = pending.find((a) => SCOPE_ANNOS.has(a));
          if (scope) meta.scope = scope;
          mergeDi(facts, bare, meta);
        }
        pending = [];
        break;
      }

      case 'ctor': {
        if (pending.includes('Inject') && lastClass) {
          const paramEnd = scanParens(text, ev.parenIdx!);
          const meta: DiMeta = { role: 'consumer', injectConstructor: true };
          if (paramEnd > 0) {
            const pts = kotlinParamTypes(text.slice(ev.parenIdx! + 1, paramEnd - 1));
            if (pts.length > 0) meta.consumedTypes = pts;
          }
          mergeDi(facts, lastClass, meta);
        }
        pending = [];
        break;
      }

      case 'var': {
        // Kotlin field injection: @Inject lateinit var repo: UserRepository
        if (pending.includes('Inject') && lastClass) {
          const t = cleanType(ev.typeText!);
          if (t) {
            mergeDi(facts, lastClass, {
              role: 'consumer',
              injectedFields: true,
              consumedTypes: [t],
            });
          }
        }
        pending = [];
        break;
      }
    }
  }

  return facts;
}

// ─── Java fact collection ─────────────────────────────────────────────────────

export function collectJavaFacts(text: string): FileFacts {
  const facts: FileFacts = { composables: new Map(), di: new Map() };
  const events: Ev[] = [];
  let m: RegExpExecArray | null;

  const annoRe = /@(\w+)/g;
  while ((m = annoRe.exec(text)) !== null) {
    const name = m[1];
    if (!isInterestingAnno(name)) continue;
    if (isTypePositionAnno(text, m.index)) continue;
    events.push({ pos: m.index, type: 'anno', name });
  }

  const classRe = /\b(?:class|interface|enum)\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'class', name: m[1] });
  }

  // ReturnType methodName(   — two identifiers then '(' (skips calls like foo.bar())
  const methodRe = /\b([A-Z][\w.]*(?:<[^>]*>)?(?:\[\])?)\s+([a-z]\w*)\s*\(/g;
  while ((m = methodRe.exec(text)) !== null) {
    events.push({
      pos: m.index,
      type: 'jmethod',
      name: m[2],
      typeText: m[1],
      parenIdx: m.index + m[0].length - 1,
    });
  }

  // Possible constructor: ClassName(   — validated against lastClass at consumption
  const jctorRe = /\b([A-Z]\w*)\s*\(/g;
  while ((m = jctorRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'jctor', name: m[1], parenIdx: m.index + m[0].length - 1 });
  }

  // Field declaration: Type name;
  const fieldRe = /\b([A-Z][\w.]*(?:<[^>]*>)?)\s+(\w+)\s*;/g;
  while ((m = fieldRe.exec(text)) !== null) {
    events.push({ pos: m.index, type: 'jfield', name: m[2], typeText: m[1] });
  }

  events.sort((a, b) => a.pos - b.pos);

  let pending: string[] = [];
  let lastClass: string | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'anno':
        pending.push(ev.name!);
        break;

      case 'class': {
        const meta: DiMeta = {};
        if (pending.includes('Module')) meta.role = 'module';
        if (pending.includes('HiltViewModel')) meta.hiltViewModel = true;
        if (pending.includes('AndroidEntryPoint')) meta.androidEntryPoint = true;
        const scope = pending.find((a) => SCOPE_ANNOS.has(a));
        if (scope) meta.scope = scope;
        if (Object.keys(meta).length > 0) mergeDi(facts, ev.name!, meta);
        lastClass = ev.name!;
        pending = [];
        break;
      }

      case 'jmethod': {
        if (pending.includes('Provides') || pending.includes('Binds')) {
          const isBinds = pending.includes('Binds');
          const meta: DiMeta = { role: 'provider' };
          const ret = cleanType(ev.typeText!);
          if (ret) meta.providedType = ret;
          if (isBinds) {
            meta.binds = true;
            const paramEnd = scanParens(text, ev.parenIdx!);
            if (paramEnd > 0) {
              const pts = javaParamTypes(text.slice(ev.parenIdx! + 1, paramEnd - 1));
              if (pts.length > 0) meta.consumedTypes = pts;
            }
          }
          const scope = pending.find((a) => SCOPE_ANNOS.has(a));
          if (scope) meta.scope = scope;
          mergeDi(facts, ev.name!, meta);
        }
        pending = [];
        break;
      }

      case 'jctor': {
        if (pending.includes('Inject') && lastClass && ev.name === lastClass) {
          const paramEnd = scanParens(text, ev.parenIdx!);
          const meta: DiMeta = { role: 'consumer', injectConstructor: true };
          if (paramEnd > 0) {
            const pts = javaParamTypes(text.slice(ev.parenIdx! + 1, paramEnd - 1));
            if (pts.length > 0) meta.consumedTypes = pts;
          }
          mergeDi(facts, lastClass, meta);
        }
        pending = [];
        break;
      }

      case 'jfield': {
        if (pending.includes('Inject') && lastClass) {
          const t = cleanType(ev.typeText!);
          if (t) {
            mergeDi(facts, lastClass, {
              role: 'consumer',
              injectedFields: true,
              consumedTypes: [t],
            });
          }
        }
        pending = [];
        break;
      }
    }
  }

  return facts;
}

// ─── Manifest extraction ──────────────────────────────────────────────────────

const COMPONENT_TAGS = ['activity', 'service', 'receiver', 'provider'] as const;

function shortIntentName(qualified: string): string {
  const i = qualified.lastIndexOf('.');
  return i >= 0 ? qualified.slice(i + 1) : qualified;
}

export function extractManifestSymbols(source: Buffer, filePath: string): SymbolRecord[] {
  try {
    const text = source.toString('utf8');
    const pkgMatch = text.match(/<manifest\b[^>]*?\bpackage\s*=\s*"([^"]+)"/);
    const pkg = pkgMatch ? pkgMatch[1] : null;
    const symbols: SymbolRecord[] = [];
    const seen = new Set<string>();

    const compRe = new RegExp(`<(${COMPONENT_TAGS.join('|')})\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = compRe.exec(text)) !== null) {
      const tag = m[1];
      const start = m.index;

      // End of opening tag
      const gt = text.indexOf('>', start);
      if (gt < 0) continue;
      const selfClosing = text[gt - 1] === '/';
      let end: number;
      if (selfClosing) {
        end = gt + 1;
      } else {
        const close = text.indexOf(`</${tag}>`, gt);
        end = close >= 0 ? close + tag.length + 3 : gt + 1;
      }

      const openTag = text.slice(start, gt + 1);
      const nameM = openTag.match(/android:name\s*=\s*"([^"]+)"/);
      if (!nameM) continue;
      const rawName = nameM[1];
      let clsName = rawName;
      if (clsName.startsWith('.')) {
        // Leading-dot names resolve against the manifest package attr. Modern
        // manifests carry the namespace in build.gradle instead (not readable
        // here) — fall back to the bare class name. Documented v1 limitation.
        clsName = pkg ? pkg + clsName : clsName.slice(1);
      }
      if (seen.has(clsName)) continue;
      seen.add(clsName);

      const exportedM = openTag.match(/android:exported\s*=\s*"(true|false)"/);
      const elementText = text.slice(start, end);

      const intentFilters: string[] = [];
      let launcher = false;
      const ifRe = /<intent-filter\b[\s\S]*?<\/intent-filter>/g;
      let fm: RegExpExecArray | null;
      while ((fm = ifRe.exec(elementText)) !== null) {
        const block = fm[0];
        const names: string[] = [];
        const nRe = /<(?:action|category)\b[^>]*android:name\s*=\s*"([^"]+)"/g;
        let nm: RegExpExecArray | null;
        while ((nm = nRe.exec(block)) !== null) {
          names.push(shortIntentName(nm[1]));
        }
        if (names.length > 0) intentFilters.push(names.join('/'));
        if (
          block.includes('android.intent.action.MAIN') &&
          block.includes('android.intent.category.LAUNCHER')
        ) {
          launcher = true;
        }
      }

      symbols.push({
        id: makeId(filePath, clsName, 'route'),
        name: clsName,
        kind: 'route',
        filePath,
        startByte: byteOffset(text, start),
        endByte: byteOffset(text, end),
        signature: `<${tag} android:name="${rawName}">`,
        summary: `Android manifest ${tag}: ${clsName}${launcher ? ' (LAUNCHER)' : ''}`,
        frameworkMeta: {
          android: 'manifest',
          component: tag,
          ...(exportedM ? { exported: exportedM[1] === 'true' } : {}),
          ...(intentFilters.length > 0 ? { intentFilters } : {}),
          ...(launcher ? { launcher: true } : {}),
        },
      });
    }
    return symbols;
  } catch (err) {
    // A malformed manifest degrades to zero framework symbols — never throws.
    logger.warn(`Android manifest extraction failed for ${filePath}: ${String(err)}`);
    return [];
  }
}

// ─── Gradle module attribution ────────────────────────────────────────────────

/**
 * Owning Gradle module from the path convention: everything before the first
 * `src/` segment is the module path ('app/src/main/…' → ':app',
 * 'feature/login/src/…' → ':feature:login', 'src/…' → ':' root module).
 * Path-only so it works identically in worker threads (no settings.gradle
 * read — the documented layer-config recipe uses settings.gradle instead).
 */
export function gradleModuleOf(filePath: string): string | null {
  const segs = filePath.split('/');
  const idx = segs.indexOf('src');
  if (idx < 0) return null;
  if (idx === 0) return ':';
  return ':' + segs.slice(0, idx).join(':');
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

const COMPOSE_UPGRADEABLE = new Set(['function', 'method']);
const DI_KINDS = new Set(['class', 'interface', 'enum', 'function', 'method', 'const', 'property']);

export const androidAdapter: FrameworkAdapter = {
  name: 'android',

  /**
   * .xml so manifests stay discoverable even if the XML handler's extension
   * set changes ('.xml' is currently already registered by xmlHandler, so this
   * is defensive). fileFilter below still routes ONLY AndroidManifest.xml
   * through this adapter — res/** XML follows the normal handler path.
   */
  extensions: () => ['.xml'],

  detect(projectRoot: string): Promise<boolean> {
    return Promise.resolve(scanForAndroid(projectRoot));
  },

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.kt') ||
    filePath.endsWith('.java') ||
    filePath.endsWith('AndroidManifest.xml'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    if (filePath.endsWith('AndroidManifest.xml')) {
      return extractManifestSymbols(source, filePath);
    }
    const text = source.toString('utf8');
    if (filePath.endsWith('.kt')) {
      putFacts(filePath, collectKotlinFacts(text));
    } else if (filePath.endsWith('.java')) {
      putFacts(filePath, collectJavaFacts(text));
    }
    // Compose/DI enrich existing handler symbols via enrichMetadata — no new
    // symbols here (preserves the handler's real spans and signatures).
    return [];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    const fp = symbol.filePath;
    const isSource = fp.endsWith('.kt') || fp.endsWith('.java');
    const isManifest = fp.endsWith('AndroidManifest.xml');
    if (!isSource && !isManifest) return symbol;

    let s = symbol;

    if (isSource) {
      const facts = factsCache.get(fp);
      if (facts) {
        const bare = bareName(s.name);

        const comp = facts.composables.get(bare);
        if (comp && COMPOSE_UPGRADEABLE.has(s.kind)) {
          s = {
            ...s,
            kind: 'composable',
            id: makeId(fp, s.name, 'composable'),
            frameworkMeta: {
              ...s.frameworkMeta,
              android: 'compose',
              ...(comp.preview ? { preview: true } : {}),
            },
          };
        }

        const di = facts.di.get(bare);
        if (di && DI_KINDS.has(s.kind)) {
          s = { ...s, frameworkMeta: { ...s.frameworkMeta, di: { ...di } } };
        }
      }
    }

    const mod = gradleModuleOf(fp);
    if (mod !== null) {
      s = { ...s, frameworkMeta: { ...s.frameworkMeta, gradleModule: mod } };
    }

    return s;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(androidAdapter);
logger.debug("Adapter 'android' registered");
