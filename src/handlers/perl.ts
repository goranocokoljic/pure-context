/**
 * Perl language handler — regex-based extraction (no tree-sitter WASM required).
 *
 * Rationale: the tree-sitter-perl grammar compiles to WASM ABI 15, which is
 * incompatible with the web-tree-sitter@0.22.x runtime used by PureContext.
 * A regex approach is practical for Perl because the language has well-defined,
 * syntactically distinct declaration forms.
 */
import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ─── Comment / POD extraction ─────────────────────────────────────────────────

/**
 * Look backwards from `lineIdx` for consecutive # comment lines.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  while (i >= 0 && /^\s*#/.test(lines[i]!.text)) {
    collected.unshift(lines[i]!.text.replace(/^\s*#\s?/, '').trim());
    i--;
  }
  if (collected.length === 0) return null;
  const joined = collected.join(' ');
  const m = joined.match(/^([^.!?]*[.!?]?)/);
  return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
}

/**
 * Look backwards from `lineIdx` for a POD block (=head1/=head2 ... =cut)
 * that mentions the given name.
 */
function precedingPod(lines: LineInfo[], lineIdx: number, subName: string): string | null {
  // Look for =cut on a line just before or above our sub, then find the opening =head
  let cutLine = -1;
  for (let i = lineIdx - 1; i >= 0; i--) {
    if (/^=cut\s*$/.test(lines[i]!.text)) {
      cutLine = i;
      break;
    }
    // Skip blank lines and # comments
    if (!/^\s*$/.test(lines[i]!.text) && !/^\s*#/.test(lines[i]!.text)) break;
  }
  if (cutLine < 0) return null;

  // Find the corresponding opening =head
  for (let i = cutLine - 1; i >= 0; i--) {
    const m = /^=head[12]\s+(.+)/.exec(lines[i]!.text);
    if (m) {
      // Collect the text between this line and =cut
      const bodyLines: string[] = [];
      for (let j = i + 1; j < cutLine; j++) {
        bodyLines.push(lines[j]!.text);
      }
      const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
      return body.slice(0, 200) || null;
    }
    if (/^=\w+/.test(lines[i]!.text)) break; // different POD command
  }
  return null;
}

// ─── Find block end ───────────────────────────────────────────────────────────

/**
 * Given the line index of a `sub name {` declaration, find the line where
 * the closing `}` matching the opening `{` lives.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i]!.text;
    for (const ch of l) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

// Matches: sub name { ... }
// Also: my sub name { }  (lexical sub Perl 5.18+)
const SUB_RE = /^(?:my\s+)?sub\s+(\w+)/;

// Matches: package Name;  or  package Name::Sub;
const PKG_RE = /^package\s+([\w:]+)\s*[;{]/;

// Matches: my $UPPER_VAR = ...  (file-scope uppercase)
const MY_VAR_RE = /^my\s+(\$[A-Z][A-Z0-9_]*)\s*=/;

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text.trim();

    // ── package declaration → kind: 'class' ────────────────────────────────
    const pkgMatch = PKG_RE.exec(line);
    if (pkgMatch) {
      const name = pkgMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(`package ${name}`),
        summary: precedingComment(lines, i) ?? `Perl package: ${name}`,
      });
      continue;
    }

    // ── sub declaration → kind: 'function' ─────────────────────────────────
    const subMatch = SUB_RE.exec(line);
    if (subMatch) {
      const name = subMatch[1]!;
      const endLine = findBlockEnd(lines, i);
      const sig = trunc(line.replace(/\s*\{.*$/, '').trim());

      const summary =
        precedingPod(lines, i, name) ??
        precedingComment(lines, i) ??
        `Perl sub: ${name}`;

      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[endLine]!.endByte,
        signature: sig || trunc(`sub ${name}`),
        summary,
      });
      continue;
    }

    // ── file-scope my $UPPER_VAR → kind: 'const' ───────────────────────────
    const varMatch = MY_VAR_RE.exec(line);
    if (varMatch) {
      const name = varMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(line),
        summary: precedingComment(lines, i) ?? `Perl variable: ${name}`,
      });
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

// use Module::Name [list];
const USE_RE = /^use\s+([\w:]+)/;
// require 'file.pl'  or  require "./file.pl"
const REQUIRE_RE = /^require\s+['"](.*?)['"]/;

function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];

  for (const { text } of lines) {
    const line = text.trim();

    const useMatch = USE_RE.exec(line);
    if (useMatch) {
      const specifier = useMatch[1]!;
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null,
        importedNames: [],
        isTypeOnly: false,
      });
      continue;
    }

    const reqMatch = REQUIRE_RE.exec(line);
    if (reqMatch) {
      const specifier = reqMatch[1]!;
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: specifier.startsWith('.') ? specifier : null,
        importedNames: [],
        isTypeOnly: false,
      });
      continue;
    }
  }

  return imports;
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // not used (no tree-sitter)
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const perlHandler: LanguageHandler = {
  extensions: () => ['.pl', '.pm', '.t'],
  // No tree-sitter grammar — uses regex extraction
  grammarPath: () => null,
  extractSymbols,
  extractImports,
  extractDocstring,
};
