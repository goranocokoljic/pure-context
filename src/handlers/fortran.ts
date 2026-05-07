/**
 * Fortran language handler — regex-based extraction.
 *
 * Handles Fortran source files (.f90, .f95, .f03, .f08, .for, .f).
 *
 * Symbols extracted:
 *   SUBROUTINE name(args)          → kind: 'function'
 *   FUNCTION name(args) RESULT(r)  → kind: 'function'
 *   MODULE name                    → kind: 'class'
 *   TYPE :: name / TYPE name       → kind: 'type'
 *   INTERFACE name                 → kind: 'interface'
 *
 * Fortran is case-insensitive — all symbol names are normalised to lowercase.
 * CONTAINS subroutines inside a MODULE are emitted as methods of that module.
 *
 * Docstrings: preceding `!>` or `!!` Ford-style doc comment lines.
 * Imports: `USE module_name` → ImportRecord.
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

/**
 * Find the line containing the matching END keyword for a block starting at startLine.
 * Matches END SUBROUTINE, END FUNCTION, END MODULE, END TYPE, END INTERFACE.
 */
function findEnd(lines: LineInfo[], startLine: number, keyword: string): number {
  const endRe = new RegExp(`^\\s*END\\s+${keyword}\\b`, 'i');
  const genericEnd = /^\s*END\s*$/i;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (endRe.test(lines[i]!.text) || genericEnd.test(lines[i]!.text.trim())) {
      return i;
    }
  }
  return lines.length - 1;
}

/**
 * Extract preceding Ford-style `!>` or `!!` doc comment, or plain `!` comment.
 */
function precedingDocComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  // Skip a single blank line
  if (i >= 0 && lines[i]!.text.trim() === '') i--;
  while (i >= 0) {
    const t = lines[i]!.text.trim();
    // Ford-style doc comments: !> or !!
    const fordMatch = /^!(?:>|!)\s?(.*)/.exec(t);
    if (fordMatch) {
      collected.unshift(fordMatch[1]!.trim());
      i--;
      continue;
    }
    // Plain Fortran comment (only collect if no ford comment found yet and adjacent)
    if (collected.length === 0) {
      const plainMatch = /^!\s?(.*)/.exec(t);
      if (plainMatch) {
        collected.unshift(plainMatch[1]!.trim());
        i--;
        continue;
      }
    }
    break;
  }
  if (collected.length > 0) {
    const joined = collected.join(' ');
    const m = joined.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
  }
  return null;
}

// ─── Patterns (all case-insensitive) ─────────────────────────────────────────

const SUBROUTINE_RE = /^\s*(?:RECURSIVE\s+|PURE\s+|ELEMENTAL\s+)*SUBROUTINE\s+(\w+)\s*(?:\(|$)/i;
const FUNCTION_RE = /^\s*(?:[\w\s*()]+\s+)?FUNCTION\s+(\w+)\s*(?:\(|$)/i;
const MODULE_RE = /^\s*MODULE\s+(\w+)\s*$/i;
const TYPE_RE = /^\s*TYPE\s*(?:::\s*)?(\w+)\s*$/i;
const INTERFACE_RE = /^\s*INTERFACE\s+(\w+)\s*$/i;
const USE_RE = /^\s*USE\s+(?:::?\s*)?(\w+)/i;
const CONTAINS_RE = /^\s*CONTAINS\s*$/i;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  // Track current module for method containment via CONTAINS
  let currentModule: string | null = null;
  let inContains = false;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!.text;
    const lineText = raw.trim();

    // Skip blank lines and comment lines
    if (!lineText || lineText.startsWith('!')) {
      i++;
      continue;
    }

    // ── MODULE name → 'class' ────────────────────────────────────────────────
    const moduleMatch = MODULE_RE.exec(lineText);
    if (moduleMatch) {
      const name = moduleMatch[1]!.toLowerCase();
      // Skip MODULE PROCEDURE lines
      if (name.toUpperCase() === 'PROCEDURE') { i++; continue; }
      const end = findEnd(lines, i, 'MODULE');
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`MODULE ${name}`),
        summary: precedingDocComment(lines, i) ?? `Fortran module: ${name}`,
      });
      currentModule = name;
      inContains = false;
      i++;
      continue;
    }

    // ── CONTAINS — mark entry into module's procedure section ────────────────
    if (CONTAINS_RE.test(lineText)) {
      inContains = true;
      i++;
      continue;
    }

    // ── END MODULE — clear context ────────────────────────────────────────────
    if (/^\s*END\s+MODULE\b/i.test(lineText) || (/^\s*END\s*$/.test(lineText) && currentModule && inContains)) {
      currentModule = null;
      inContains = false;
      i++;
      continue;
    }

    // ── TYPE :: name → 'type' ────────────────────────────────────────────────
    const typeMatch = TYPE_RE.exec(lineText);
    if (typeMatch) {
      const name = typeMatch[1]!.toLowerCase();
      const end = findEnd(lines, i, 'TYPE');
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`TYPE :: ${name}`),
        summary: precedingDocComment(lines, i) ?? `Fortran derived type: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── INTERFACE name → 'interface' ─────────────────────────────────────────
    const ifaceMatch = INTERFACE_RE.exec(lineText);
    if (ifaceMatch) {
      const name = ifaceMatch[1]!.toLowerCase();
      const end = findEnd(lines, i, 'INTERFACE');
      symbols.push({
        id: makeId(filePath, name, 'interface'),
        name,
        kind: 'interface',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`INTERFACE ${name}`),
        summary: precedingDocComment(lines, i) ?? `Fortran interface block: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── SUBROUTINE name → 'function' ─────────────────────────────────────────
    const subMatch = SUBROUTINE_RE.exec(lineText);
    if (subMatch) {
      const name = subMatch[1]!.toLowerCase();
      const qualifiedName = (currentModule && inContains) ? `${currentModule}.${name}` : name;
      const end = findEnd(lines, i, 'SUBROUTINE');
      symbols.push({
        id: makeId(filePath, qualifiedName, 'function'),
        name: qualifiedName,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`SUBROUTINE ${name}${lineText.includes('(') ? '(' + lineText.split('(').slice(1).join('(') : ''}`),
        summary: precedingDocComment(lines, i) ?? `Fortran subroutine: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── FUNCTION name → 'function' ────────────────────────────────────────────
    const fnMatch = FUNCTION_RE.exec(lineText);
    if (fnMatch) {
      const name = fnMatch[1]!.toLowerCase();
      const qualifiedName = (currentModule && inContains) ? `${currentModule}.${name}` : name;
      const end = findEnd(lines, i, 'FUNCTION');
      symbols.push({
        id: makeId(filePath, qualifiedName, 'function'),
        name: qualifiedName,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`FUNCTION ${name}${lineText.includes('(') ? '(' + lineText.split('(').slice(1).join('(') : ''}`),
        summary: precedingDocComment(lines, i) ?? `Fortran function: ${name}`,
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];
  const seen = new Set<string>();

  for (const { text } of lines) {
    const m = USE_RE.exec(text);
    if (!m) continue;

    const specifier = m[1]!.toLowerCase();
    if (seen.has(specifier)) continue;
    seen.add(specifier);

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: null, // Fortran module resolution is compiler-dependent
      importedNames: [specifier],
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based, no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const fortranHandler: LanguageHandler = {
  extensions: () => ['.f90', '.f95', '.f03', '.f08', '.for', '.f'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
