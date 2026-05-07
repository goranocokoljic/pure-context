/**
 * Terraform/HCL language handler — regex-based extraction.
 *
 * Rationale: no pre-built WASM for tree-sitter-hcl is available on npm.
 * HCL block syntax is regular enough for reliable line-by-line regex parsing.
 *
 * Symbols extracted:
 *   resource "type" "name" { }  → kind: 'class',    name: type.name
 *   data     "type" "name" { }  → kind: 'const',    name: data.type.name
 *   variable "name"       { }   → kind: 'const',    name: var.name
 *   output   "name"       { }   → kind: 'const',    name: output.name
 *   module   "name"       { }   → kind: 'function', name: module.name
 *   locals   { key = ... }      → kind: 'const' per key
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
    lines.push({
      text: line,
      startByte: byteOffset,
      endByte: byteOffset + lineBytes,
    });
    byteOffset += lineBytes + 1; // +1 for \n
  }
  return lines;
}

// ─── Block utilities ──────────────────────────────────────────────────────────

/**
 * Find the line index where the block (opened at `startLine`) closes.
 * Tracks `{` / `}` depth. Returns `startLine` if no block is found.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]!.text;
    let inStr = false;
    let strChar = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (inStr) {
        if (ch === strChar && line[j - 1] !== '\\') inStr = false;
      } else if (ch === '"' || ch === "'") {
        inStr = true;
        strChar = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/**
 * Look backwards from `lineIdx` for a consecutive block of `#` or `//` comment lines.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  while (i >= 0) {
    const trimmed = lines[i]!.text.trim();
    const hashMatch = /^#\s?(.*)/.exec(trimmed);
    const slashMatch = /^\/\/\s?(.*)/.exec(trimmed);
    if (hashMatch) {
      collected.unshift(hashMatch[1]!.trim());
      i--;
    } else if (slashMatch) {
      collected.unshift(slashMatch[1]!.trim());
      i--;
    } else {
      break;
    }
  }
  if (collected.length === 0) return null;
  const joined = collected.join(' ');
  const m = joined.match(/^([^.!?]*[.!?]?)/);
  return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
}

/**
 * Scan block lines (startLine+1 … endLine) for a `description = "..."` attribute.
 */
function blockDescription(lines: LineInfo[], startLine: number, endLine: number): string | null {
  const descRe = /^\s+description\s*=\s*"([^"]+)"/;
  for (let i = startLine + 1; i <= endLine; i++) {
    const m = descRe.exec(lines[i]!.text);
    if (m) return m[1]!.trim().slice(0, 200);
  }
  return null;
}

// ─── Top-level block patterns ─────────────────────────────────────────────────

const RESOURCE_RE = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
const DATA_RE     = /^data\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
const VARIABLE_RE = /^variable\s+"([^"]+)"\s*\{/;
const OUTPUT_RE   = /^output\s+"([^"]+)"\s*\{/;
const MODULE_RE   = /^module\s+"([^"]+)"\s*\{/;
const LOCALS_RE   = /^locals\s*\{/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text.trim();

    // ── resource "type" "name" → kind: 'class' ────────────────────────────
    const resMatch = RESOURCE_RE.exec(line);
    if (resMatch) {
      const name = `${resMatch[1]}.${resMatch[2]}`;
      const end = findBlockEnd(lines, i);
      const summary =
        blockDescription(lines, i, end) ??
        precedingComment(lines, i) ??
        `Terraform resource: ${name}`;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`resource "${resMatch[1]}" "${resMatch[2]}"`),
        summary,
      });
      continue;
    }

    // ── data "type" "name" → kind: 'const' ───────────────────────────────
    const dataMatch = DATA_RE.exec(line);
    if (dataMatch) {
      const name = `data.${dataMatch[1]}.${dataMatch[2]}`;
      const end = findBlockEnd(lines, i);
      const summary =
        blockDescription(lines, i, end) ??
        precedingComment(lines, i) ??
        `Terraform data source: ${name}`;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`data "${dataMatch[1]}" "${dataMatch[2]}"`),
        summary,
      });
      continue;
    }

    // ── variable "name" → kind: 'const' ──────────────────────────────────
    const varMatch = VARIABLE_RE.exec(line);
    if (varMatch) {
      const name = `var.${varMatch[1]}`;
      const end = findBlockEnd(lines, i);
      const summary =
        blockDescription(lines, i, end) ??
        precedingComment(lines, i) ??
        `Terraform variable: ${name}`;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`variable "${varMatch[1]}"`),
        summary,
      });
      continue;
    }

    // ── output "name" → kind: 'const' ────────────────────────────────────
    const outMatch = OUTPUT_RE.exec(line);
    if (outMatch) {
      const name = `output.${outMatch[1]}`;
      const end = findBlockEnd(lines, i);
      const summary =
        blockDescription(lines, i, end) ??
        precedingComment(lines, i) ??
        `Terraform output: ${name}`;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`output "${outMatch[1]}"`),
        summary,
      });
      continue;
    }

    // ── module "name" → kind: 'function' ─────────────────────────────────
    const modMatch = MODULE_RE.exec(line);
    if (modMatch) {
      const name = `module.${modMatch[1]}`;
      const end = findBlockEnd(lines, i);
      const summary =
        blockDescription(lines, i, end) ??
        precedingComment(lines, i) ??
        `Terraform module: ${name}`;
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`module "${modMatch[1]}"`),
        summary,
      });
      continue;
    }

    // ── locals { key = value } → kind: 'const' per key ───────────────────
    const localsMatch = LOCALS_RE.exec(line);
    if (localsMatch) {
      const end = findBlockEnd(lines, i);
      // Each `key = ...` inside the locals block
      const keyRe = /^\s+([\w-]+)\s*=/;
      for (let j = i + 1; j < end; j++) {
        const keyMatch = keyRe.exec(lines[j]!.text);
        if (!keyMatch) continue;
        const name = `local.${keyMatch[1]}`;
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: lines[j]!.startByte,
          endByte: lines[j]!.endByte,
          signature: trunc(`local.${keyMatch[1]}`),
          summary: `Terraform local: ${name}`,
        });
      }
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract `source = "..."` attributes inside module blocks as ImportRecords.
 * Local module sources (starting with "./" or "../") are resolved; registry
 * sources (like "hashicorp/vpc/aws") are stored as external (resolvedPath: null).
 */
function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];
  const sourceAttrRe = /^\s+source\s*=\s*"([^"]+)"/;
  let insideModule = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text.trim();

    // Detect module block start
    if (MODULE_RE.exec(line)) {
      insideModule = true;
      continue;
    }

    if (insideModule) {
      const srcMatch = sourceAttrRe.exec(lines[i]!.text);
      if (srcMatch) {
        const specifier = srcMatch[1]!;
        imports.push({
          sourceFile: '',
          specifier,
          resolvedPath: specifier.startsWith('.') ? specifier : null,
          importedNames: [],
          isTypeOnly: false,
        });
        insideModule = false;
      }
      // Reset on block close
      if (line === '}') insideModule = false;
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return imports.filter((imp) => {
    if (seen.has(imp.specifier)) return false;
    seen.add(imp.specifier);
    return true;
  });
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based, no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const terraformHandler: LanguageHandler = {
  extensions: () => ['.tf', '.hcl'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
