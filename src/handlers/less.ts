/**
 * LESS language handler — regex-based.
 *
 * Handles: .less
 *
 * Symbols extracted:
 *   .mixin-name(@params) {  → kind: 'function'  (parametric mixin definition)
 *   @variable: value;       → kind: 'const'  (top-level only; at-rules excluded)
 *   @keyframes name {       → kind: 'type'
 *
 * Imports:
 *   @import 'path'          → ImportRecord
 *   @import (reference) 'path' → ImportRecord
 *
 * Note: plain selectors (.class, #id, element) and mixin calls are not indexed.
 * Mixin definitions are distinguished from calls by requiring `(` after the name
 * AND `{` on the same line. Top-level vs nested is enforced by brace depth tracking.
 */
import { createHash } from 'crypto';
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

// ─── Line utilities ───────────────────────────────────────────────────────────

interface LineInfo {
  text: string;
  startByte: number;
  endByte: number;
}

function buildLineIndex(source: Buffer): LineInfo[] {
  const lines: LineInfo[] = [];
  let byteOffset = 0;
  for (const line of source.toString('utf8').split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    lines.push({ text: line, startByte: byteOffset, endByte: byteOffset + lineBytes });
    byteOffset += lineBytes + 1;
  }
  return lines;
}

/**
 * Find block end by counting braces. Returns endByte of the closing brace's line.
 */
function findBlockEnd(lines: LineInfo[], startLineIdx: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startLineIdx; i < lines.length; i++) {
    for (const ch of lines[i]!.text) {
      if (ch === '{') { depth++; foundOpen = true; }
      else if (ch === '}') {
        if (depth > 0) depth--;
        if (foundOpen && depth === 0) return lines[i]!.endByte;
      }
    }
  }
  return lines[startLineIdx]!.endByte;
}

function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;
  while (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const above = lines[i]!.text;

  const slMatch = /\/\/\s*(.+)/.exec(above);
  if (slMatch) return trunc(slMatch[1]!);

  const inlineMatch = /\/\*\s*(.*?)\s*\*\//.exec(above);
  if (inlineMatch) return trunc(inlineMatch[1]!);

  if (above.trimEnd().endsWith('*/')) {
    const docLines: string[] = [];
    while (i >= 0) {
      const t = lines[i]!.text;
      const cleaned = t
        .replace(/^\s*\/\*+/, '')
        .replace(/\*+\/\s*$/, '')
        .replace(/^\s*\*\s?/, '')
        .trim();
      if (cleaned) docLines.unshift(cleaned);
      if (t.includes('/*')) break;
      i--;
    }
    return docLines.length > 0 ? trunc(docLines.join(' ')) || null : null;
  }

  return null;
}

// ─── LESS at-rule keywords (must not be mistaken for @variable declarations) ──
//
// LESS variables are always `@word: value;`.  At-rules never have `:` right
// after the keyword (`@media (...)`, `@keyframes name`, `@import 'file'`).
// This set is a safety net for the extremely unlikely edge case where someone
// names a LESS variable the same as a CSS at-rule keyword.
const LESS_ATRULE_KEYWORDS = new Set([
  'charset', 'import', 'namespace', 'page', 'media',
  'keyframes', 'font-face', 'supports', 'layer', 'document',
  'viewport', 'counter-style', 'plugin', 'use', 'forward',
  'each', 'for', 'if', 'while',
]);

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let lineText = line.text;

    // ── Handle ongoing block comments ────────────────────────────────────────
    if (inBlockComment) {
      const closeIdx = lineText.indexOf('*/');
      if (closeIdx !== -1) {
        inBlockComment = false;
        lineText = lineText.slice(closeIdx + 2);
      } else {
        continue;
      }
    }

    // Strip // single-line comments
    const slIdx = lineText.indexOf('//');
    if (slIdx !== -1) lineText = lineText.slice(0, slIdx);

    // Handle /* ... */
    const bsIdx = lineText.indexOf('/*');
    if (bsIdx !== -1) {
      const beIdx = lineText.indexOf('*/', bsIdx + 2);
      if (beIdx === -1) {
        inBlockComment = true;
        lineText = lineText.slice(0, bsIdx);
      } else {
        lineText = lineText.slice(0, bsIdx) + lineText.slice(beIdx + 2);
      }
    }

    const trimmed = lineText.trim();

    // ── Depth tracking ───────────────────────────────────────────────────────
    const prevDepth = depth;
    for (const ch of lineText) {
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth > 0) depth--; }
    }

    if (!trimmed) continue;

    // ── @keyframes (including vendor-prefixed) ───────────────────────────────
    // Check before @variable to prevent `@keyframes:` from matching variables.
    let m = /^@(?:-\w+-)?keyframes\s+([\w-]+)/.exec(trimmed);
    if (m) {
      const name = m[1]!;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: line.startByte,
        endByte: findBlockEnd(lines, i),
        signature: trunc(`@keyframes ${name}`),
        summary: precedingComment(lines, i) ?? `CSS keyframes: ${name}`,
      });
      continue;
    }

    // ── .mixin-name(@params) { — parametric mixin definition ─────────────────
    // Mixin definitions: have `(...)` after the name and `{` on the same line.
    // prevDepth <= 1 to capture both top-level and namespace-scoped mixins.
    // This intentionally excludes mixin calls (which end with `;`, not `{`).
    if (prevDepth <= 1) {
      m = /^\.([\w-]+)\s*\(([^)]*)\)\s*(?:when[^{]*)?\{/.exec(trimmed);
      if (m) {
        const name = m[1]!;
        const params = m[2]!.trim();
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: line.startByte,
          endByte: findBlockEnd(lines, i),
          signature: trunc(`.${name}(${params})`),
          summary: precedingComment(lines, i) ?? `LESS mixin: ${name}`,
        });
        continue;
      }
    }

    // ── @variable: value (top-level only) ────────────────────────────────────
    if (prevDepth === 0) {
      m = /^@([\w-]+)\s*:(.+)$/.exec(trimmed);
      if (m) {
        const varName = m[1]!;
        if (!LESS_ATRULE_KEYWORDS.has(varName.toLowerCase())) {
          const rawValue = m[2]!.replace(/;\s*$/, '').trim();
          symbols.push({
            id: makeId(filePath, `@${varName}`, 'const'),
            name: `@${varName}`,
            kind: 'const',
            filePath,
            startByte: line.startByte,
            endByte: line.endByte,
            signature: trunc(`@${varName}: ${rawValue}`),
            summary: precedingComment(lines, i) ?? `LESS variable: @${varName}`,
          });
        }
      }
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];
  const seen = new Set<string>();

  for (const { text } of lines) {
    // @import 'path' or @import (keyword) 'path'
    const m = /^\s*@import\s+(?:\([^)]*\)\s+)?['"]([^'"]+)['"]/.exec(text);
    if (!m) continue;
    const specifier = m[1]!;
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: /^https?:\/\//.test(specifier) ? null : specifier,
      importedNames: [],
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based; no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const lessHandler: LanguageHandler = {
  extensions: () => ['.less'],
  grammarPath: () => null, // regex-based; no WASM grammar needed
  extractSymbols,
  extractImports,
  extractDocstring,
};
