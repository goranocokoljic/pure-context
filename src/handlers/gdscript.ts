/**
 * GDScript language handler — regex-based extraction.
 *
 * Handles Godot GDScript source files (.gd).
 *
 * Symbols extracted:
 *   func name(args) -> ReturnType:      → kind: 'function'
 *   class Name:                         → kind: 'class' (inner class)
 *   var name: Type = value              → kind: 'const' (top-level / class scope)
 *   signal name(args)                   → kind: 'function'
 *   @export var name                    → kind: 'const' (with export: true in frameworkMeta)
 *
 * Docstrings: preceding `##` comment block (GDScript convention).
 * Imports: `extends ClassName` → ImportRecord.
 *
 * Note: GDScript uses indentation for scoping. Top-level symbols are those
 * whose lines start at column 0 (no leading whitespace).
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
 * Find the last line of an indented block that starts at `startLine`.
 * The block ends when we encounter a non-empty line with indentation <= the
 * indentation of the block opener's first child line.
 * Returns startLine if the block has no body.
 */
function findIndentedBlockEnd(lines: LineInfo[], startLine: number): number {
  // Find the indent level of the header line
  const headerIndent = lines[startLine]!.text.match(/^(\s*)/)?.[1]?.length ?? 0;
  let end = startLine;
  let foundBody = false;

  for (let i = startLine + 1; i < lines.length; i++) {
    const lineText = lines[i]!.text;
    // Skip blank lines and comment-only lines
    if (/^\s*$/.test(lineText) || /^\s*#/.test(lineText)) {
      end = i;
      continue;
    }
    const indent = lineText.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent > headerIndent) {
      foundBody = true;
      end = i;
    } else {
      // Back at or before the header indent — block is done
      break;
    }
  }
  return foundBody ? end : startLine;
}

/**
 * Extract preceding `##` doc comment lines as a summary.
 */
function precedingDocComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  // Skip a single blank line
  if (i >= 0 && lines[i]!.text.trim() === '') i--;
  while (i >= 0) {
    const t = lines[i]!.text.trim();
    const m = /^##\s?(.*)/.exec(t);
    if (m) {
      collected.unshift(m[1]!.trim());
      i--;
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

// func declaration (may have return type annotation)
const FUNC_RE = /^func\s+(\w+)\s*\(/;
// inner class
const CLASS_RE = /^class\s+(\w+)\s*(?:extends\s+\w+\s*)?:/;
// var declaration (top-level: no leading whitespace)
const VAR_RE = /^var\s+(\w+)/;
// @export var
const EXPORT_VAR_RE = /^@export(?:\([^)]*\))?\s+var\s+(\w+)/;
// signal
const SIGNAL_RE = /^signal\s+(\w+)/;
// extends
const EXTENDS_RE = /^extends\s+(.+?)\s*$/;
// class_name
const CLASSNAME_RE = /^class_name\s+(\w+)/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let i = 0;

  // Track whether we're inside a func body (for top-level var filtering)
  // We do this by checking indentation: top-level lines have indent == 0.
  // Inner-class bodies have indent > 0 but class declarations are at 0.

  while (i < lines.length) {
    const lineText = lines[i]!.text;
    const trimmed = lineText.trim();

    // Skip blank lines and comments (# and ##)
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Only process top-level declarations (no leading whitespace)
    const indent = lineText.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent > 0) {
      i++;
      continue;
    }

    // ── class_name MyNode → skip (it's metadata, not a symbol) ───────────────
    if (CLASSNAME_RE.test(trimmed)) {
      i++;
      continue;
    }

    // ── extends ClassName → skip (handled in extractImports) ─────────────────
    if (EXTENDS_RE.test(trimmed)) {
      i++;
      continue;
    }

    // ── func name(...): → kind: 'function' ───────────────────────────────────
    const funcMatch = FUNC_RE.exec(trimmed);
    if (funcMatch) {
      const name = funcMatch[1]!;
      // Extract signature — everything up to the colon on this line
      const sig = trimmed.replace(/:$/, '').trim();
      const end = findIndentedBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(sig),
        summary: precedingDocComment(lines, i) ?? `GDScript function: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── class Name: → kind: 'class' ──────────────────────────────────────────
    const classMatch = CLASS_RE.exec(trimmed);
    if (classMatch) {
      const name = classMatch[1]!;
      const end = findIndentedBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(trimmed.replace(/:$/, '').trim()),
        summary: precedingDocComment(lines, i) ?? `GDScript inner class: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── @export var name → kind: 'const' with frameworkMeta ──────────────────
    const exportVarMatch = EXPORT_VAR_RE.exec(trimmed);
    if (exportVarMatch) {
      const name = exportVarMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(trimmed),
        summary: precedingDocComment(lines, i) ?? `GDScript exported variable: ${name}`,
        frameworkMeta: { export: true },
      });
      i++;
      continue;
    }

    // ── var name → kind: 'const' (top-level) ─────────────────────────────────
    const varMatch = VAR_RE.exec(trimmed);
    if (varMatch) {
      const name = varMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(trimmed),
        summary: precedingDocComment(lines, i) ?? `GDScript variable: ${name}`,
      });
      i++;
      continue;
    }

    // ── signal name(...) → kind: 'function' ──────────────────────────────────
    const signalMatch = SIGNAL_RE.exec(trimmed);
    if (signalMatch) {
      const name = signalMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(trimmed),
        summary: precedingDocComment(lines, i) ?? `GDScript signal: ${name}`,
      });
      i++;
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

  for (const { text } of lines) {
    const m = EXTENDS_RE.exec(text.trim());
    if (m) {
      const className = m[1]!.trim();
      imports.push({
        sourceFile: '',
        specifier: className,
        resolvedPath: null, // class inheritance, not a file path
        importedNames: [className],
        isTypeOnly: false,
      });
      break; // Only one `extends` per file
    }
  }

  return imports;
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based, no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const gdscriptHandler: LanguageHandler = {
  extensions: () => ['.gd'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
