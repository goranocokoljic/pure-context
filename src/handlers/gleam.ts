/**
 * Gleam language handler — regex-based extraction.
 *
 * Handles Gleam source files (.gleam).
 *
 * Symbols extracted:
 *   pub fn name(args) -> ReturnType { }  → kind: 'function'
 *   fn name(...)                         → kind: 'function' (private)
 *   pub type Name { ... }               → kind: 'class' (ADT / custom type)
 *   pub type Name = ...                 → kind: 'type' (type alias)
 *   pub const NAME = ...                → kind: 'const'
 *   const NAME = ...                    → kind: 'const' (private)
 *
 * Docstrings: preceding `///` doc comment lines.
 * Imports: `import package/module` or `import package/module.{Symbol}` → ImportRecord.
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
 * Find the closing `}` that matches the first `{` at or after startLine.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startLine; i < lines.length; i++) {
    // Strip string literals and comments for brace counting
    const stripped = lines[i]!.text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '');
    for (const ch of stripped) {
      if (ch === '{') { depth++; foundOpen = true; }
      else if (ch === '}') {
        depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/**
 * Extract preceding `///` doc comment lines as a summary.
 */
function precedingDocComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  // Skip a single blank line
  if (i >= 0 && lines[i]!.text.trim() === '') i--;
  while (i >= 0) {
    const t = lines[i]!.text.trim();
    const m = /^\/\/\/\s?(.*)/.exec(t);
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

// fn / pub fn — captures pub? and name
const FN_RE = /^(pub\s+)?fn\s+(\w+)\s*[\(<]/;
// pub type Name { — ADT / custom type
const TYPE_ADT_RE = /^(pub\s+)?type\s+(\w+)(?:\([^)]*\))?\s*\{/;
// pub type Name = — type alias (no brace)
const TYPE_ALIAS_RE = /^(pub\s+)?type\s+(\w+)(?:\([^)]*\))?\s*=/;
// pub const / const
const CONST_RE = /^(pub\s+)?const\s+(\w+)/;
// import package/module or import package/module.{symbols} or import pkg as alias
const IMPORT_RE = /^import\s+([\w/]+)(?:\.?\{([^}]*)\})?(?:\s+as\s+\w+)?/;

// ─── Signature extraction ─────────────────────────────────────────────────────

/**
 * Extract the full function signature (everything before the opening `{`).
 */
function fnSignature(lines: LineInfo[], startLine: number): string {
  // Collect until we find `{` — may span multiple lines for long signatures
  let sig = '';
  for (let i = startLine; i < Math.min(startLine + 8, lines.length); i++) {
    const part = lines[i]!.text;
    const braceIdx = part.indexOf('{');
    if (braceIdx !== -1) {
      sig += part.slice(0, braceIdx);
      break;
    }
    sig += part + ' ';
  }
  return trunc(sig.replace(/\s+/g, ' ').trim());
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i]!.text.trim();

    // Skip blank lines and doc comments
    if (!lineText || lineText.startsWith('///') || lineText.startsWith('//')) {
      i++;
      continue;
    }

    // Skip import lines
    if (IMPORT_RE.test(lineText)) {
      i++;
      continue;
    }

    // ── pub type Name { } → kind: 'class' (ADT) ──────────────────────────────
    const typeAdtMatch = TYPE_ADT_RE.exec(lineText);
    if (typeAdtMatch) {
      const name = typeAdtMatch[2]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc((typeAdtMatch[1] ?? '') + `type ${name}`),
        summary: precedingDocComment(lines, i) ?? `Gleam type: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── pub type Name = ... → kind: 'type' (alias) ────────────────────────────
    const typeAliasMatch = TYPE_ALIAS_RE.exec(lineText);
    if (typeAliasMatch) {
      const name = typeAliasMatch[2]!;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(lineText),
        summary: precedingDocComment(lines, i) ?? `Gleam type alias: ${name}`,
      });
      i++;
      continue;
    }

    // ── fn / pub fn → kind: 'function' ───────────────────────────────────────
    const fnMatch = FN_RE.exec(lineText);
    if (fnMatch) {
      const name = fnMatch[2]!;
      const sig = fnSignature(lines, i);
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: sig || trunc(lineText),
        summary: precedingDocComment(lines, i) ?? `Gleam function: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── pub const / const → kind: 'const' ────────────────────────────────────
    const constMatch = CONST_RE.exec(lineText);
    if (constMatch) {
      const name = constMatch[2]!;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(lineText),
        summary: precedingDocComment(lines, i) ?? `Gleam constant: ${name}`,
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
    const m = IMPORT_RE.exec(text.trim());
    if (!m) continue;

    const specifier = m[1]!; // e.g. "gleam/io" or "myapp/user"
    const importedNamesRaw = m[2]; // e.g. "concat, length"

    // Resolve local modules (starting with project-relative path): null for external
    const isLocal = !specifier.includes('/') || specifier.startsWith('.');
    const resolvedPath = isLocal ? specifier : null;

    const importedNames = importedNamesRaw
      ? importedNamesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [specifier.split('/').pop() ?? specifier];

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath,
      importedNames,
      isTypeOnly: false,
    });
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

export const gleamHandler: LanguageHandler = {
  extensions: () => ['.gleam'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
