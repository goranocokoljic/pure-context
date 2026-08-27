/**
 * Angular HTML template handler — regex-based extraction.
 *
 * Only indexes `.html` files that are Angular templates, identified by:
 *   1. A sibling `.ts` file with the same stem (foo.component.html →
 *      foo.component.ts), resolved against the repo root passed via
 *      HandlerContext (Phase 94, Task 585 — the pre-94 check built
 *      `foo.component.component.ts` against process.cwd(): dead code), OR
 *   2. At least TWO distinct Angular markers in the first 4KB (one marker
 *      alone false-positived on plain HTML: `(e) =>` arrows, `href="#top"`).
 *
 * Symbols extracted (one per distinct name, real match-local byte spans):
 *   <app-foo>, <my-component>       → kind: 'component', name: tag-name
 *   *ngIf, *ngFor, *ngSwitch        → kind: 'property',  name: *ngIf etc.
 *   @if, @for, @switch (v17+ flow)  → kind: 'property',  name: @if etc.
 *   (click)="onSave()"              → kind: 'property',  name: (click), sig: onSave()
 *   #userInput                      → kind: 'const',     name: userInput
 *   routerLink="..."                → kind: 'const',     name: routerLink
 *
 * Regex-handler contract (file-processor header): this handler computes TRUE
 * byte offsets itself — char match indices are converted via the shared
 * offset converter.
 */
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { buildOffsetConverter } from '../core/offsets.js';
import type {
  LanguageHandler,
  HandlerContext,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function trunc(s: string, max = 120): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// ─── Angular detection ────────────────────────────────────────────────────────

const ANGULAR_MARKERS = [
  '*ngIf', '*ngFor', '*ngSwitch', '[(ng', '@for ', '@if ', '@if(', '@for(', 'routerLink', '[(ngModel)]',
];
// Attribute-position event binding: whitespace, then (event)=" — never matches
// arrow functions `(e) =>` (no `="`) or call arguments.
const EVENT_BINDING_DETECT_RE = /\s\([a-z][\w.]*\)\s*=\s*"/;
// Attribute-position property binding [prop]=" — Angular-specific (Vue uses :prop).
const PROPERTY_BINDING_DETECT_RE = /\s\[[A-Za-z][\w.-]*\]\s*=\s*"/;
// Interpolation — weak alone (handlebars/vue share it), counts as ONE marker.
const INTERPOLATION_DETECT_RE = /\{\{/;

/** Count DISTINCT Angular marker types present in the first 4KB. */
function countMarkers(peek: string): number {
  let count = 0;
  for (const m of ANGULAR_MARKERS) {
    if (peek.includes(m)) count++;
  }
  if (EVENT_BINDING_DETECT_RE.test(peek)) count++;
  if (PROPERTY_BINDING_DETECT_RE.test(peek)) count++;
  if (INTERPOLATION_DETECT_RE.test(peek)) count++;
  return count;
}

/**
 * Returns true if the file should be treated as an Angular template.
 * Sibling `.ts` colocation (needs context.rootPath) or ≥2 distinct markers.
 */
function isAngularTemplate(source: Buffer, filePath: string, context?: HandlerContext): boolean {
  if (context?.rootPath) {
    const stem = basename(filePath);
    const noExt = stem.endsWith('.html') ? stem.slice(0, -5) : stem;
    const siblingTs = join(context.rootPath, dirname(filePath), noExt + '.ts');
    if (existsSync(siblingTs)) return true;
  }

  const peek = source.slice(0, 4 * 1024).toString('utf8');
  return countMarkers(peek) >= 2;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// Kebab-case multi-segment component selectors (at least one hyphen)
const COMPONENT_TAG_RE = /<([\w]+-[\w-]+)[\s>]/g;
// Structural directive usage: *ngIf, *ngFor, *ngSwitch
const STRUCT_DIRECTIVE_RE = /\*ng(If|For|Switch)\b/g;
// Angular 17+ control flow: @if, @for, @switch, @defer, @placeholder, @loading,
// @error — anchored to a preceding start/whitespace/brace so email addresses
// and CSS at-rules in inline styles don't match.
const CONTROL_FLOW_RE = /(?:^|[\s{}])@(if|for|switch|defer|placeholder|loading|error)\b/g;
// Event binding at attribute position: (eventName)="handler()"
const EVENT_BINDING_RE = /\s\(([a-z][\w.]*)\)\s*=\s*"([^"]+)"/g;
// Template reference variable at attribute position: #varName followed by an
// attribute/tag delimiter — kills href="#top", &#39;, color:#fff.
const TEMPLATE_REF_RE = /\s#([A-Za-z_]\w*)(?=[\s=>/])/g;
// routerLink attribute presence
const ROUTER_LINK_RE = /\brouterLink\s*=/g;

// Standard HTML elements to exclude from component detection
const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'body',
  'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data',
  'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em',
  'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script',
  'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  'mat-icon', 'mat-button', 'mat-card', 'mat-toolbar', // common Angular Material
]);

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(
  _tree: Tree,
  source: Buffer,
  filePath: string,
  context?: HandlerContext,
): SymbolRecord[] {
  if (!isAngularTemplate(source, filePath, context)) return [];

  const text = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  // Regex-handler contract: convert char match indices to TRUE byte offsets.
  const conv = buildOffsetConverter(source, text);
  const span = (charStart: number, charEnd: number) => ({
    startByte: conv.charToByte(charStart),
    endByte: conv.charToByte(charEnd),
  });

  // ── Component selectors ───────────────────────────────────────────────────
  const seenComponents = new Set<string>();
  COMPONENT_TAG_RE.lastIndex = 0;
  let m;
  while ((m = COMPONENT_TAG_RE.exec(text)) !== null) {
    const tag = m[1]!.toLowerCase();
    if (seenComponents.has(tag) || HTML_ELEMENTS.has(tag)) continue;
    seenComponents.add(tag);
    symbols.push({
      id: makeId(filePath, tag, 'component'),
      name: tag,
      kind: 'component',
      filePath,
      ...span(m.index, m.index + m[0].length),
      signature: trunc(`<${tag}>`),
      summary: `Angular component: ${tag}`,
    });
  }

  // ── Structural directives ─────────────────────────────────────────────────
  const seenDirectives = new Set<string>();
  STRUCT_DIRECTIVE_RE.lastIndex = 0;
  while ((m = STRUCT_DIRECTIVE_RE.exec(text)) !== null) {
    const name = `*ng${m[1]!}`;
    if (seenDirectives.has(name)) continue;
    seenDirectives.add(name);
    symbols.push({
      id: makeId(filePath, name, 'property'),
      name,
      kind: 'property',
      filePath,
      ...span(m.index, m.index + m[0].length),
      signature: trunc(name),
      summary: `Angular structural directive: ${name}`,
    });
  }

  // ── Angular 17+ control flow ──────────────────────────────────────────────
  const seenFlow = new Set<string>();
  CONTROL_FLOW_RE.lastIndex = 0;
  while ((m = CONTROL_FLOW_RE.exec(text)) !== null) {
    const name = `@${m[1]!}`;
    if (seenFlow.has(name)) continue;
    seenFlow.add(name);
    const atIdx = m.index + m[0].indexOf('@');
    symbols.push({
      id: makeId(filePath, name, 'property'),
      name,
      kind: 'property',
      filePath,
      ...span(atIdx, atIdx + name.length),
      signature: trunc(name),
      summary: `Angular control flow: ${name}`,
    });
  }

  // ── Event bindings ────────────────────────────────────────────────────────
  const seenEvents = new Set<string>();
  EVENT_BINDING_RE.lastIndex = 0;
  while ((m = EVENT_BINDING_RE.exec(text)) !== null) {
    const eventName = `(${m[1]!})`;
    const handler = m[2]!.trim();
    if (seenEvents.has(eventName)) continue;
    seenEvents.add(eventName);
    symbols.push({
      id: makeId(filePath, eventName, 'property'),
      name: eventName,
      kind: 'property',
      filePath,
      ...span(m.index + 1, m.index + m[0].length),
      signature: trunc(handler),
      summary: `Event binding ${eventName}: ${handler}`,
    });
  }

  // ── Template reference variables ──────────────────────────────────────────
  const seenRefs = new Set<string>();
  TEMPLATE_REF_RE.lastIndex = 0;
  while ((m = TEMPLATE_REF_RE.exec(text)) !== null) {
    const refName = m[1]!;
    if (seenRefs.has(refName)) continue;
    seenRefs.add(refName);
    symbols.push({
      id: makeId(filePath, refName, 'const'),
      name: refName,
      kind: 'const',
      filePath,
      ...span(m.index + 1, m.index + m[0].length),
      signature: trunc(`#${refName}`),
      summary: `Template reference variable: #${refName}`,
    });
  }

  // ── routerLink ────────────────────────────────────────────────────────────
  ROUTER_LINK_RE.lastIndex = 0;
  const rl = ROUTER_LINK_RE.exec(text);
  if (rl !== null && !seenRefs.has('routerLink')) {
    symbols.push({
      id: makeId(filePath, 'routerLink', 'const'),
      name: 'routerLink',
      kind: 'const',
      filePath,
      ...span(rl.index, rl.index + rl[0].length),
      signature: 'routerLink',
      summary: 'Angular router link binding',
    });
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(_tree: Tree, _source: Buffer): ImportRecord[] {
  return [];
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const angularHtmlHandler: LanguageHandler = {
  extensions: () => ['.html'],
  grammarPath: () => null,
  extractSymbols,
  extractImports,
  extractDocstring,
};
