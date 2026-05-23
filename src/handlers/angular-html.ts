/**
 * Angular HTML template handler — regex-based extraction.
 *
 * Only indexes `.html` files that are Angular templates, identified by:
 *   1. A sibling `.component.ts` file (same stem), OR
 *   2. Angular markers in the first 4KB (ngIf, ngFor, routerLink, etc.)
 *
 * Symbols extracted:
 *   <app-foo>, <my-component>       → kind: 'component', name: tag-name
 *   *ngIf, *ngFor, *ngSwitch        → kind: 'property',  name: *ngIf etc.
 *   @if, @for, @switch (v17+ flow)  → kind: 'property',  name: @if etc.
 *   (click)="onSave()"              → kind: 'property',  name: (click), sig: onSave()
 *   #userInput                      → kind: 'const',     name: userInput
 *   routerLink="..."                → kind: 'const',     name: routerLink
 */
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import type {
  LanguageHandler,
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
  '*ngIf', '*ngFor', '*ngSwitch', '[(ng', '@for', '@if', 'routerLink', '[(ngModel)]',
];
// Angular event binding syntax (click)="..." is uniquely Angular
const EVENT_BINDING_DETECT_RE = /\([a-z]\w*\)\s*=/;

/**
 * Returns true if the file should be treated as an Angular template.
 * Checks for sibling .component.ts or Angular markers in first 4KB.
 */
function isAngularTemplate(source: Buffer, filePath: string): boolean {
  // Check sibling .component.ts (filePath is relative, but we check fs anyway)
  const stem = basename(filePath);
  const noExt = stem.endsWith('.html') ? stem.slice(0, -5) : stem;
  const siblingTs = join(dirname(filePath), noExt + '.component.ts');
  if (existsSync(siblingTs)) return true;

  const peek = source.slice(0, 4 * 1024).toString('utf8');
  return ANGULAR_MARKERS.some((m) => peek.includes(m)) || EVENT_BINDING_DETECT_RE.test(peek);
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// Kebab-case multi-segment component selectors (at least one hyphen)
const COMPONENT_TAG_RE = /<([\w]+-[\w-]+)[\s>]/g;
// Structural directive usage: *ngIf, *ngFor, *ngSwitch
const STRUCT_DIRECTIVE_RE = /\*ng(If|For|Switch)\b/g;
// Angular 17+ control flow: @if, @for, @switch, @defer, @placeholder, @loading, @error
const CONTROL_FLOW_RE = /@(if|for|switch|defer|placeholder|loading|error)\b/g;
// Event binding: (eventName)="handler()"
const EVENT_BINDING_RE = /\(([a-z]\w*)\)\s*=\s*"([^"]+)"/g;
// Template reference variable: #varName
const TEMPLATE_REF_RE = /#(\w+)\b/g;
// routerLink attribute presence
const ROUTER_LINK_RE = /\brouterLink\s*=/;

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

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  if (!isAngularTemplate(source, filePath)) return [];

  const text = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  const startByte = 0;
  const endByte = source.length;

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
      startByte,
      endByte,
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
      startByte,
      endByte,
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
    symbols.push({
      id: makeId(filePath, name, 'property'),
      name,
      kind: 'property',
      filePath,
      startByte,
      endByte,
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
      startByte,
      endByte,
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
      startByte,
      endByte,
      signature: trunc(`#${refName}`),
      summary: `Template reference variable: #${refName}`,
    });
  }

  // ── routerLink ────────────────────────────────────────────────────────────
  if (ROUTER_LINK_RE.test(text) && !seenRefs.has('routerLink')) {
    symbols.push({
      id: makeId(filePath, 'routerLink', 'const'),
      name: 'routerLink',
      kind: 'const',
      filePath,
      startByte,
      endByte,
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
