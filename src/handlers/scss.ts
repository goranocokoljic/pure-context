/**
 * SCSS / SASS language handler — regex-based.
 *
 * Handles: .scss (SCSS syntax), .sass (indented Sass syntax)
 *
 * Symbols extracted:
 *   @mixin name(params)    → kind: 'function'
 *   @function name(params) → kind: 'function'
 *   $variable: value       → kind: 'const'  (top-level only)
 *   %placeholder           → kind: 'class'
 *   @keyframes name        → kind: 'type'
 *
 * Imports:
 *   @import 'path'         → ImportRecord
 *   @use 'path'            → ImportRecord
 *   @forward 'path'        → ImportRecord
 *
 * Note: plain selectors (.class, #id, element) are intentionally not indexed —
 * they are not reusable named symbols. Only mixins, functions, variables,
 * placeholders, and keyframes qualify as navigable constructs.
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
    byteOffset += lineBytes + 1; // +1 for the \n
  }
  return lines;
}

/**
 * Find block end by counting braces. Returns the endByte of the line that
 * contains the closing `}` for the block opened at startLineIdx.
 * Used for .scss files only — .sass uses indentation, not braces.
 */
function findScssBlockEnd(lines: LineInfo[], startLineIdx: number): number {
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

/**
 * Find the nearest CSS-style comment preceding lineIdx.
 * Supports // single-line and /* ... * / block comments.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;
  while (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const above = lines[i]!.text;

  // Single-line comment: // text
  const slMatch = /\/\/\s*(.+)/.exec(above);
  if (slMatch) return trunc(slMatch[1]!);

  // Inline block comment: /* text */
  const inlineMatch = /\/\*\s*(.*?)\s*\*\//.exec(above);
  if (inlineMatch) return trunc(inlineMatch[1]!);

  // End of multi-line block comment
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

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  const isSass = filePath.endsWith('.sass');

  let depth = 0;          // {} nesting depth (tracked for .scss only)
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

    // Strip // single-line comments (simplified: first occurrence not inside string)
    const slIdx = lineText.indexOf('//');
    if (slIdx !== -1) lineText = lineText.slice(0, slIdx);

    // Handle /* ... */ on the current line
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

    // ── Depth tracking (.scss only — .sass uses indentation) ─────────────────
    const prevDepth = depth;
    if (!isSass) {
      for (const ch of lineText) {
        if (ch === '{') depth++;
        else if (ch === '}') { if (depth > 0) depth--; }
      }
    }

    if (!trimmed) continue;

    // ── @mixin ───────────────────────────────────────────────────────────────
    let m = /^@mixin\s+([\w-]+)\s*(\([^)]*\))?/.exec(trimmed);
    if (m) {
      const name = m[1]!;
      const params = m[2] ?? '';
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: line.startByte,
        endByte: isSass ? line.endByte : findScssBlockEnd(lines, i),
        signature: trunc(`@mixin ${name}${params}`),
        summary: precedingComment(lines, i) ?? `SCSS mixin: ${name}`,
      });
      continue;
    }

    // ── @function ────────────────────────────────────────────────────────────
    m = /^@function\s+([\w-]+)\s*(\([^)]*\))?/.exec(trimmed);
    if (m) {
      const name = m[1]!;
      const params = m[2] ?? '';
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: line.startByte,
        endByte: isSass ? line.endByte : findScssBlockEnd(lines, i),
        signature: trunc(`@function ${name}${params}`),
        summary: precedingComment(lines, i) ?? `SCSS function: ${name}`,
      });
      continue;
    }

    // ── @keyframes (including vendor-prefixed) ───────────────────────────────
    m = /^@(?:-\w+-)?keyframes\s+([\w-]+)/.exec(trimmed);
    if (m) {
      const name = m[1]!;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: line.startByte,
        endByte: isSass ? line.endByte : findScssBlockEnd(lines, i),
        signature: trunc(`@keyframes ${name}`),
        summary: precedingComment(lines, i) ?? `CSS keyframes: ${name}`,
      });
      continue;
    }

    // ── %placeholder ─────────────────────────────────────────────────────────
    m = /^(%[\w-]+)/.exec(trimmed);
    if (m) {
      const name = m[1]!;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: line.startByte,
        endByte: isSass ? line.endByte : findScssBlockEnd(lines, i),
        signature: trunc(name),
        summary: precedingComment(lines, i) ?? `SCSS placeholder: ${name}`,
      });
      continue;
    }

    // ── $variable (top-level only) ────────────────────────────────────────────
    // For .scss: use brace depth (prevDepth === 0 means before any open block).
    // For .sass: use indentation — no leading whitespace means top-level.
    const isTopLevel = isSass
      ? !/^\s/.test(line.text)
      : prevDepth === 0;

    if (isTopLevel) {
      m = /^(\$[\w-]+)\s*:(.+)$/.exec(trimmed);
      if (m) {
        const name = m[1]!;
        const rawValue = m[2]!
          .replace(/\s*!(?:default|global|important)\s*/g, '')
          .replace(/;\s*$/, '')
          .trim();
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: line.startByte,
          endByte: line.endByte,
          signature: trunc(`${name}: ${rawValue}`),
          summary: precedingComment(lines, i) ?? `SCSS variable: ${name}`,
        });
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
    const m = /^\s*@(?:import|use|forward)\s+['"]([^'"]+)['"]/.exec(text);
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

export const scssHandler: LanguageHandler = {
  extensions: () => ['.scss', '.sass'],
  grammarPath: () => null, // regex-based; no WASM grammar needed
  extractSymbols,
  extractImports,
  extractDocstring,
};
