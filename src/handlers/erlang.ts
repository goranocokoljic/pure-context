/**
 * Erlang language handler — regex-based extraction.
 *
 * Rationale: `tree-sitter-erlang` on npm is a security placeholder (0.0.1-security).
 * Erlang's top-level form syntax is regular enough for reliable line-by-line scanning.
 *
 * Symbols extracted:
 *   -module(name)                → kind: 'class'
 *   -record(name, {...})         → kind: 'class'
 *   -type name() :: ...          → kind: 'type'
 *   -opaque name() :: ...        → kind: 'type'
 *   name(Args) -> ...            → kind: 'function', name: 'name/arity'
 *
 * -spec attributes are collected in a first pass and used as signatures.
 * Multiple clauses for the same name/arity are collapsed into one symbol.
 * EDoc %% @doc comments (and plain %% comments) are used as summaries.
 *
 * Imports: -import(module, [fun/arity, ...]) → ImportRecord
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
 * Find the end of an Erlang top-level form.
 * Erlang forms end with a `.` at delimiter depth 0 (tracking `()[]{}` pairs).
 * Multiple function clauses are separated by `;` and share the same form end.
 */
function findErlangFormEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    // Strip % comments before scanning
    const noComment = lines[i]!.text.replace(/%.*$/, '');
    for (const ch of noComment) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth > 0) depth--; }
    }
    // A period at depth 0 terminates the form
    if (depth === 0 && /\.\s*$/.test(noComment)) return i;
  }
  return lines.length - 1;
}

/**
 * Extract the content between the first matching `( ... )` pair on a line.
 * Returns null if no complete pair is found on this line.
 */
function extractParams(line: string): string | null {
  const start = line.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')') {
      depth--;
      if (depth === 0) return line.slice(start + 1, i);
    }
  }
  return null; // unmatched — multi-line params
}

/**
 * Estimate arity by counting top-level commas in a parameter string.
 * Handles nested `()[]{}` correctly (does not count commas inside them).
 */
function estimateArity(params: string): number {
  const p = params.trim();
  if (!p) return 0;
  let depth = 0;
  let commas = 0;
  for (const ch of p) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth > 0) depth--; }
    else if (ch === ',' && depth === 0) commas++;
  }
  return commas + 1;
}

/**
 * Extract preceding EDoc `%% @doc` or plain `%%` comment as a summary.
 * Skips `-spec`, `-dialyzer`, and `-callback` attribute lines that may appear
 * between the comment and the function head.
 */
function precedingErlangComment(lines: LineInfo[], lineIdx: number): string | null {
  // Skip -spec / -dialyzer / -callback lines between comment and function
  let i = lineIdx - 1;
  while (i >= 0 && /^\s*-(?:spec|dialyzer|callback)\s+/.test(lines[i]!.text)) i--;

  if (i < 0) return null;

  // Collect consecutive %% comment lines going backwards
  const collected: string[] = [];
  while (i >= 0) {
    const t = lines[i]!.text.trim();
    const m = /^%%+\s?(.*)/.exec(t);
    if (m) {
      collected.unshift(m[1]!.trim());
      i--;
    } else {
      break;
    }
  }

  if (collected.length === 0) return null;

  // Prefer the @doc line if present
  const docLine = collected.find((l) => l.startsWith('@doc'));
  if (docLine) {
    const content = docLine.replace(/^@doc\s*/, '').trim();
    return content.slice(0, 200) || null;
  }

  const joined = collected.join(' ');
  const m = joined.match(/^([^.!?]*[.!?]?)/);
  return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

const MODULE_RE  = /^-module\s*\(\s*([a-z_][a-zA-Z0-9_@]*)\s*\)/;
const RECORD_RE  = /^-record\s*\(\s*([a-z_][a-zA-Z0-9_@]*)\s*,/;
const TYPE_RE    = /^-(?:type|opaque)\s+([a-z_][a-zA-Z0-9_@?]*)\s*\(/;
const SPEC_RE    = /^-spec\s+([a-z_][a-zA-Z0-9_@?]*)\s*[\/(]/;
const IMPORT_RE  = /^-import\s*\(\s*([a-z_][a-zA-Z0-9_@]*)\s*,\s*\[([^\]]+)\]\s*\)/;
const INCLUDE_RE = /^-include(_lib)?\s*\(\s*"([^"]+)"\s*\)/;
// Any remaining attribute (catches -export, -behaviour, -define, etc.)
const ATTR_RE    = /^-\w+/;
// Function head: starts with a lowercase identifier followed by `(`
const FN_HEAD_RE = /^([a-z_][a-zA-Z0-9_@?]*)\s*\(/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  // Map `name/arity` → spec signature (collected in first pass)
  const specs = new Map<string, string>();
  // Track emitted function keys to collapse multiple clauses into one symbol
  const emitted = new Set<string>();
  // Current module name (set when -module(name) is encountered)
  let currentModule: string | undefined;

  // ── First pass: collect -spec attributes ────────────────────────────────────
  for (let j = 0; j < lines.length; j++) {
    const text = lines[j]!.text.trim();
    const specMatch = SPEC_RE.exec(text);
    if (specMatch) {
      const fnName = specMatch[1]!;
      const params = extractParams(text);
      const arity = params !== null ? estimateArity(params) : 0;
      const key = `${fnName}/${arity}`;
      // Store the full spec line as signature (strip -spec prefix and trailing .)
      const sigRaw = text.replace(/^-spec\s+/, '').replace(/\.\s*$/, '');
      specs.set(key, trunc(sigRaw));
      // Skip to end of spec form to avoid re-matching continuation lines
      j = findErlangFormEnd(lines, j);
    }
  }

  // ── Second pass: extract module, record, type, function symbols ──────────────
  let i = 0;
  while (i < lines.length) {
    const text = lines[i]!.text.trim();

    // Skip blank lines and % comments
    if (!text || text.startsWith('%')) {
      i++;
      continue;
    }

    // ── -module(name) → kind: 'class' ────────────────────────────────────────
    const modMatch = MODULE_RE.exec(text);
    if (modMatch) {
      const name = modMatch[1]!;
      currentModule = name;
      const end = findErlangFormEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`-module(${name})`),
        summary: `Erlang module: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── -record(name, {...}) → kind: 'class' ──────────────────────────────────
    const recMatch = RECORD_RE.exec(text);
    if (recMatch) {
      const name = recMatch[1]!;
      const end = findErlangFormEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`-record(${name}, {...})`),
        summary: precedingErlangComment(lines, i) ?? `Erlang record: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── -type / -opaque name() :: ... → kind: 'type' ─────────────────────────
    const typeMatch = TYPE_RE.exec(text);
    if (typeMatch) {
      const name = typeMatch[1]!;
      const end = findErlangFormEnd(lines, i);
      const typeSig = text.replace(/^-(?:type|opaque)\s+/, '').replace(/\.\s*$/, '');
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(typeSig),
        summary: precedingErlangComment(lines, i) ?? `Erlang type: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── Any other attribute (-export, -spec, -import, etc.) → skip ───────────
    if (ATTR_RE.test(text)) {
      i = findErlangFormEnd(lines, i) + 1;
      continue;
    }

    // ── Function head: name(Args) -> ... → kind: 'function' ──────────────────
    const fnMatch = FN_HEAD_RE.exec(text);
    if (fnMatch) {
      const fnName = fnMatch[1]!;
      const params = extractParams(text);
      const arity = params !== null ? estimateArity(params) : 0;
      const key = `${fnName}/${arity}`;
      const end = findErlangFormEnd(lines, i);

      if (!emitted.has(key)) {
        emitted.add(key);
        const sig = specs.get(key) ?? trunc(`${fnName}/${arity}`);
        const meta: Record<string, unknown> = { arity };
        if (currentModule) meta['module'] = currentModule;
        symbols.push({
          id: makeId(filePath, key, 'function'),
          name: fnName,
          kind: 'function',
          filePath,
          startByte: lines[i]!.startByte,
          endByte: lines[end]!.endByte,
          signature: sig,
          summary: precedingErlangComment(lines, i) ?? `Erlang function: ${fnName}/${arity}`,
          frameworkMeta: meta,
        });
      }

      i = end + 1;
      continue;
    }

    i++;
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract `-import(module, [fun/arity, ...])` as ImportRecords (specifier
 * `module:fun/arity`), and `-include` / `-include_lib` header includes
 * (specifier = the quoted path literal). Both are resolved to in-repo files
 * by the Erlang family resolver at graph-build time (Phase 86).
 */
function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];

  for (const { text } of lines) {
    const trimmed = text.trim();
    const m = IMPORT_RE.exec(trimmed);
    if (m) {
      const module = m[1]!;
      const funs = m[2]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const fun of funs) {
        imports.push({
          sourceFile: '',
          specifier: `${module}:${fun}`,
          resolvedPath: null, // resolved by the Erlang family resolver at graph build
          importedNames: [fun.split('/')[0] ?? fun],
          isTypeOnly: false,
        });
      }
      continue;
    }

    const inc = INCLUDE_RE.exec(trimmed);
    if (inc) {
      imports.push({
        sourceFile: '',
        specifier: inc[2]!,
        resolvedPath: null, // header basename resolved by the Erlang family resolver
        importedNames: [],
        isTypeOnly: false,
      });
    }
  }

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

export const erlangHandler: LanguageHandler = {
  extensions: () => ['.erl', '.hrl'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
