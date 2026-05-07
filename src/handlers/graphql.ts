/**
 * GraphQL language handler — regex-based extraction.
 *
 * Rationale: no pre-built WASM for tree-sitter-graphql with npm-bundled WASM exists.
 * GraphQL SDL syntax is regular enough for reliable line-by-line scanning.
 *
 * Symbols extracted:
 *   type Name { }                    → kind: 'class'
 *   interface Name { }               → kind: 'interface'
 *   enum Name { }                    → kind: 'enum'
 *   input Name { }                   → kind: 'class'
 *   scalar Name                      → kind: 'type'
 *   directive @name                  → kind: 'decorator'
 *   query/mutation/subscription Name → kind: 'function'
 *   fragment Name on Type            → kind: 'const'
 *
 * Docstrings: `"""..."""` block or inline preceding the definition, or `# comment`.
 * Imports: GraphQL has no native import syntax — returns empty array.
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

/**
 * Find the line where the block (opened at or after `startLine`) closes.
 * Strips `#` line comments before counting braces.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    // Strip # comments; also strip """...""" string literals
    const noComment = lines[i]!.text.replace(/#.*$/, '');
    let inTriple = false;
    for (let j = 0; j < noComment.length; j++) {
      if (!inTriple && noComment.slice(j, j + 3) === '"""') {
        inTriple = true;
        j += 2;
        continue;
      }
      if (inTriple && noComment.slice(j, j + 3) === '"""') {
        inTriple = false;
        j += 2;
        continue;
      }
      if (!inTriple) {
        if (noComment[j] === '{') depth++;
        else if (noComment[j] === '}') {
          depth--;
          if (depth === 0) return i;
        }
      }
    }
  }
  return lines.length - 1;
}

/**
 * Extract the docstring or comment immediately preceding the definition at `lineIdx`.
 *
 * Handles two forms:
 *  1. `"""..."""` triple-quoted string (single-line or multi-line)
 *  2. Consecutive `# comment` lines
 */
function precedingDocstring(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;

  // Skip a single blank line
  if (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const above = lines[i]!.text.trim();

  // ── Triple-quoted docstring ───────────────────────────────────────────────
  if (above === '"""') {
    // Multi-line: the line above is the closing `"""`, scan back for opening `"""`
    i--;
    const docLines: string[] = [];
    while (i >= 0) {
      const t = lines[i]!.text.trim();
      if (t === '"""' || t.startsWith('"""')) {
        // Found opening """ — strip leading """ if inline
        const opening = t.startsWith('"""') ? t.slice(3).trim() : '';
        if (opening) docLines.unshift(opening);
        break;
      }
      docLines.unshift(t);
      i--;
    }
    if (docLines.length > 0) {
      const content = docLines.join(' ').trim();
      const m = content.match(/^([^.!?]*[.!?]?)/);
      return ((m ? m[1]!.trim() : content).slice(0, 200)) || null;
    }
  } else if (above.startsWith('"""') && above.endsWith('"""') && above.length > 6) {
    // Inline single-line: """content"""
    const content = above.slice(3, -3).trim();
    const m = content.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : content).slice(0, 200)) || null;
  }

  // ── Hash (#) comment lines ────────────────────────────────────────────────
  const collected: string[] = [];
  let j = lineIdx - 1;
  while (j >= 0) {
    const trimmed = lines[j]!.text.trim();
    const m = /^#\s?(.*)/.exec(trimmed);
    if (m) {
      collected.unshift(m[1]!.trim());
      j--;
    } else {
      break;
    }
  }
  if (collected.length > 0) {
    const joined = collected.join(' ');
    const m = joined.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
  }

  return null;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// type Name (optional implements clause)
const TYPE_RE       = /^type\s+(\w+)/;
// interface Name
const INTERFACE_RE  = /^interface\s+(\w+)/;
// enum Name
const ENUM_RE       = /^enum\s+(\w+)/;
// input Name
const INPUT_RE      = /^input\s+(\w+)/;
// scalar Name
const SCALAR_RE     = /^scalar\s+(\w+)/;
// directive @name
const DIRECTIVE_RE  = /^directive\s+@(\w+)/;
// query/mutation/subscription Name
const OPERATION_RE  = /^(query|mutation|subscription)\s+(\w+)/;
// fragment Name on TypeName
const FRAGMENT_RE   = /^fragment\s+(\w+)\s+on\s+(\w+)/;
// extend type/interface/enum Name
const EXTEND_RE     = /^extend\s+(?:type|interface|enum|input)\s+(\w+)/;

// Lines that start docstring/comment blocks (to skip)
const TRIPLE_QUOTE_RE = /^"""/;
const HASH_RE         = /^#/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i]!.text.trim();

    // ── Skip blank lines ─────────────────────────────────────────────────────
    if (!lineText) { i++; continue; }

    // ── Skip # comment lines ─────────────────────────────────────────────────
    if (HASH_RE.test(lineText)) { i++; continue; }

    // ── Skip (and advance past) triple-quoted docstring blocks ───────────────
    if (TRIPLE_QUOTE_RE.test(lineText)) {
      // Inline single-line: """content"""
      if (lineText.startsWith('"""') && lineText.endsWith('"""') && lineText.length > 6) {
        i++;
        continue;
      }
      // Multi-line docstring: scan forward for closing """
      i++;
      while (i < lines.length) {
        if (lines[i]!.text.trim().endsWith('"""')) { i++; break; }
        i++;
      }
      continue;
    }

    // ── type Name → kind: 'class' ────────────────────────────────────────────
    const typeMatch = TYPE_RE.exec(lineText);
    if (typeMatch && !lineText.startsWith('extend')) {
      const name = typeMatch[1]!;
      // Build signature: everything up to `{` on this line, or just `type Name`
      const sigLine = lineText.replace(/\{.*$/, '').trim();
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(sigLine || `type ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL type: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── interface Name → kind: 'interface' ──────────────────────────────────
    const ifaceMatch = INTERFACE_RE.exec(lineText);
    if (ifaceMatch && !lineText.startsWith('extend')) {
      const name = ifaceMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'interface'),
        name,
        kind: 'interface',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`interface ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL interface: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── enum Name → kind: 'enum' ─────────────────────────────────────────────
    const enumMatch = ENUM_RE.exec(lineText);
    if (enumMatch && !lineText.startsWith('extend')) {
      const name = enumMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'enum'),
        name,
        kind: 'enum',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`enum ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL enum: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── input Name → kind: 'class' ───────────────────────────────────────────
    const inputMatch = INPUT_RE.exec(lineText);
    if (inputMatch && !lineText.startsWith('extend')) {
      const name = inputMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`input ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL input type: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── scalar Name → kind: 'type' ───────────────────────────────────────────
    const scalarMatch = SCALAR_RE.exec(lineText);
    if (scalarMatch) {
      const name = scalarMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(`scalar ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL scalar: ${name}`,
      });
      i++;
      continue;
    }

    // ── directive @name → kind: 'decorator' ──────────────────────────────────
    const directiveMatch = DIRECTIVE_RE.exec(lineText);
    if (directiveMatch) {
      const name = directiveMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'decorator'),
        name,
        kind: 'decorator',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(`directive @${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL directive: @${name}`,
      });
      i++;
      continue;
    }

    // ── query/mutation/subscription Name → kind: 'function' ─────────────────
    const opMatch = OPERATION_RE.exec(lineText);
    if (opMatch) {
      const opType = opMatch[1]!;
      const name = opMatch[2]!;
      // Signature: operation keyword + name + any variable declarations
      const sigLine = lineText.replace(/\{.*$/, '').trim();
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(sigLine || `${opType} ${name}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL ${opType}: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── fragment Name on Type → kind: 'const' ────────────────────────────────
    const fragMatch = FRAGMENT_RE.exec(lineText);
    if (fragMatch) {
      const name = fragMatch[1]!;
      const onType = fragMatch[2]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`fragment ${name} on ${onType}`),
        summary: precedingDocstring(lines, i) ?? `GraphQL fragment: ${name} on ${onType}`,
      });
      i = end + 1;
      continue;
    }

    // ── extend type/interface/enum/input Name → skip (modifies existing type) ─
    const extendMatch = EXTEND_RE.exec(lineText);
    if (extendMatch) {
      // Skip extend blocks without emitting a new symbol
      const end = findBlockEnd(lines, i);
      i = end + 1;
      continue;
    }

    i++;
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * GraphQL SDL has no native import/include syntax — schema stitching is
 * handled at the application level. Return an empty array.
 */
function extractImports(_tree: Tree, _source: Buffer): ImportRecord[] {
  return [];
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based, no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const graphqlHandler: LanguageHandler = {
  extensions: () => ['.graphql', '.gql'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
