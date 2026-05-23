/**
 * HCL/Terraform language handler — regex-based extraction.
 *
 * Handles HCL files (.tf, .tfvars, .hcl). grammarPath returns null (regex-only).
 *
 * Symbols extracted (top-level blocks only):
 *   variable "name" { ... }       → kind: 'const',  name: name
 *   output "name" { ... }         → kind: 'const',  name: name
 *   resource "type" "name" { }    → kind: 'class',  name: type.name
 *   data "type" "name" { }        → kind: 'const',  name: type.name
 *   module "name" { ... }         → kind: 'class',  name: name
 *   provider "name" { ... }       → kind: 'const',  name: name
 *   locals { key = val, ... }     → kind: 'const',  name: key  (one per local)
 *
 * Summary: first `#` or `//` comment line immediately above the block.
 * Signature: `<block_type> "name"` (or `"type" "name"` for resource/data).
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
  const text = source.toString('utf8');
  const lines: LineInfo[] = [];
  let byteOffset = 0;
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    lines.push({ text: line, startByte: byteOffset, endByte: byteOffset + lineBytes });
    byteOffset += lineBytes + 1; // +1 for \n
  }
  return lines;
}

/** Find the closing brace that matches the opening brace on startLine. */
function findClosingBrace(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const t = lines[i]!.text;
    for (const ch of t) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Return the first comment line (`#` or `//`) immediately preceding lineIdx. */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;
  while (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;
  const t = lines[i]!.text.trim();
  if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim() || null;
  if (t.startsWith('//')) return t.replace(/^\/\/+\s*/, '').trim() || null;
  return null;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// Top-level block: keyword "label1" ["label2"] {
const BLOCK_RE = /^(variable|output|resource|data|module|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/;
// locals block
const LOCALS_RE = /^locals\s*\{/;
// Key = value inside locals (only simple word keys)
const LOCAL_ITEM_RE = /^\s+(\w[\w-]*)\s*=/gm;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  let i = 0;
  while (i < lines.length) {
    const lineText = lines[i]!.text;
    const trimmed = lineText.trim();

    // ── Top-level blocks ────────────────────────────────────────────────────
    const blockMatch = BLOCK_RE.exec(trimmed);
    if (blockMatch) {
      const blockType = blockMatch[1]!;
      const label1 = blockMatch[2]!;
      const label2 = blockMatch[3];
      const endLine = findClosingBrace(lines, i);
      const comment = precedingComment(lines, i);

      let name: string;
      let kind: SymbolKind;
      let signature: string;

      if (blockType === 'resource') {
        name = `${label1}.${label2 ?? ''}`;
        kind = 'class';
        signature = `resource "${label1}" "${label2 ?? ''}"`;
      } else if (blockType === 'data') {
        name = `data.${label1}.${label2 ?? ''}`;
        kind = 'const';
        signature = `data "${label1}" "${label2 ?? ''}"`;
      } else if (blockType === 'module') {
        name = `module.${label1}`;
        kind = 'class';
        signature = `module "${label1}"`;
      } else if (blockType === 'variable') {
        name = `var.${label1}`;
        kind = 'const';
        signature = `variable "${label1}"`;
      } else if (blockType === 'output') {
        name = `output.${label1}`;
        kind = 'const';
        signature = `output "${label1}"`;
      } else {
        // provider
        name = label1;
        kind = 'const';
        signature = `${blockType} "${label1}"`;
      }

      symbols.push({
        id: makeId(filePath, name, kind),
        name,
        kind,
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[endLine]!.endByte,
        signature: trunc(signature),
        summary: comment ?? trunc(signature),
        frameworkMeta: { blockType },
      });

      i = endLine + 1;
      continue;
    }

    // ── locals block ────────────────────────────────────────────────────────
    if (LOCALS_RE.test(trimmed)) {
      const endLine = findClosingBrace(lines, i);
      // Collect the text of the locals block body
      const bodyLines = lines.slice(i, endLine + 1).map((l) => l.text).join('\n');

      LOCAL_ITEM_RE.lastIndex = 0;
      let m;
      while ((m = LOCAL_ITEM_RE.exec(bodyLines)) !== null) {
        const localName = m[1]!;
        // Compute byte offset for this local item from the block start byte
        const offsetInBody = bodyLines.lastIndexOf('\n', m.index) + 1;
        const bodyStart = lines[i]!.startByte;
        const itemByte = bodyStart + Buffer.byteLength(bodyLines.slice(0, offsetInBody), 'utf8');

        const prefixedName = `local.${localName}`;
        symbols.push({
          id: makeId(filePath, prefixedName, 'const'),
          name: prefixedName,
          kind: 'const',
          filePath,
          startByte: itemByte,
          endByte: itemByte + Buffer.byteLength(m[0], 'utf8'),
          signature: trunc(`local.${localName}`),
          summary: `Terraform local: ${prefixedName}`,
          frameworkMeta: { blockType: 'local' },
        });
      }

      i = endLine + 1;
      continue;
    }

    i++;
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

export const hclHandler: LanguageHandler = {
  extensions: () => ['.tf', '.tfvars', '.hcl'],
  grammarPath: () => null,
  extractSymbols,
  extractImports,
  extractDocstring,
};
