/**
 * CSS language handler — regex-based, opt-in.
 *
 * Handles: .css (only when `indexing.cssVariables` is true in config)
 *
 * Symbols extracted:
 *   --custom-property: value  → kind: 'const'  (CSS custom properties)
 *
 * Only custom properties at shallow nesting depth (≤ 1) are extracted.
 * This covers both `:root { --var: value; }` and `@layer { --var: value; }`.
 * Deeply nested custom properties (inside media queries AND selectors) are
 * excluded as they are typically not reusable design tokens.
 *
 * Imports:
 *   @import url('path')       → ImportRecord
 *   @import 'path'            → ImportRecord
 *
 * This handler is registered conditionally in bootstrap() based on config:
 *   if (cfg.indexing.cssVariables) registerHandler(cssHandler);
 *
 * Plain CSS selectors (.class, #id, element) are intentionally not indexed.
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

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let lineText = line.text;

    // ── Handle block comments ────────────────────────────────────────────────
    if (inBlockComment) {
      const closeIdx = lineText.indexOf('*/');
      if (closeIdx !== -1) {
        inBlockComment = false;
        lineText = lineText.slice(closeIdx + 2);
      } else {
        continue;
      }
    }

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

    // ── CSS custom property (--variable: value) ───────────────────────────────
    // Only at shallow depth (≤ 1) to capture :root and @layer but not deeply nested.
    if (prevDepth <= 1) {
      const m = /(--[\w-]+)\s*:([^;{]+)/.exec(trimmed);
      if (m) {
        const name = m[1]!;
        if (!seen.has(`${filePath}:${name}`)) {
          seen.add(`${filePath}:${name}`);
          const rawValue = m[2]!.trim();
          symbols.push({
            id: makeId(filePath, name, 'const'),
            name,
            kind: 'const',
            filePath,
            startByte: line.startByte,
            endByte: line.endByte,
            signature: trunc(`${name}: ${rawValue}`),
            summary: `CSS custom property: ${name}`,
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
    // @import url('path') or @import 'path'
    let m = /^\s*@import\s+url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(text);
    if (!m) m = /^\s*@import\s+['"]([^'"]+)['"]/.exec(text);
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
  return null;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const cssHandler: LanguageHandler = {
  extensions: () => ['.css'],
  grammarPath: () => null,
  extractSymbols,
  extractImports,
  extractDocstring,
};
