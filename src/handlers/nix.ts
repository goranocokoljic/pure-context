/**
 * Nix language handler — regex-based extraction.
 *
 * Rationale: no pre-built WASM for tree-sitter-nix is available on npm.
 * Nix files are functional expressions; this handler extracts the most
 * practically valuable symbols using depth-aware line scanning.
 *
 * Symbols extracted:
 *   Top-level attribute bindings (depth 0–1):
 *     name = expr;         → kind: 'const'
 *     name = { args }: expr → kind: 'function'  (function value)
 *     name = arg: expr      → kind: 'function'  (lambda value)
 *   Derivations:
 *     stdenv.mkDerivation { name = "..."; } → kind: 'class'
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
 * Count the net brace depth change on a single line, ignoring braces inside strings.
 * Returns { open: number, close: number } delta.
 */
function braceDelta(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === strChar && line[i - 1] !== '\\') inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === '#') {
      break; // rest of line is a comment
    } else if (ch === '{') {
      open++;
    } else if (ch === '}') {
      close++;
    }
  }
  return { open, close };
}

/**
 * Look backwards from `lineIdx` for consecutive `#` comment lines.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  while (i >= 0) {
    const trimmed = lines[i]!.text.trim();
    const m = /^#\s?(.*)/.exec(trimmed);
    if (m) {
      collected.unshift(m[1]!.trim());
      i--;
    } else {
      break;
    }
  }
  if (collected.length === 0) return null;
  const joined = collected.join(' ');
  const m2 = joined.match(/^([^.!?]*[.!?]?)/);
  return ((m2 ? m2[1]!.trim() : joined).slice(0, 200)) || null;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Top-level binding: `name =` at the beginning of a line (allowing minimal indent).
 * Nix identifiers may contain letters, digits, hyphens, underscores, apostrophes.
 */
const BINDING_RE = /^(\s{0,4})([\w][\w'-]*)\s*=/;

/**
 * Function value indicator: the right-hand side of `name = ...` starts with
 * a lambda (`arg:`) or attrset-pattern (`{ ... }:` or `{ ... } @name:`).
 */
const FUNC_VALUE_RE = /=\s*(?:\{[^{]*?\}(?:\s*@\s*\w+)?\s*:|[\w][\w'-]*\s*:)/;

/**
 * Common derivation builders.
 */
const DERIVATION_RE =
  /\b(stdenv\.mkDerivation|buildRustPackage|buildGoModule|buildGoPackage|buildPythonPackage|buildPythonApplication|mkShell)\s*(?:rec\s*)?\{/;

/**
 * Derivation name attribute: `name = "..."` or `pname = "..."`.
 */
const DERIV_NAME_RE = /\b(?:pname|name)\s*=\s*"([^"]+)"/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const { open, close } = braceDelta(line.text);

    // Compute depth *before* this line's braces for binding detection.
    // Bindings we care about live at depth 0 or at depth 1 (inside the root `{}`).
    const depthBefore = depth;
    depth = depth + open - close;

    // ── Derivation detection (any depth) ────────────────────────────────────
    const derivMatch = DERIVATION_RE.exec(line.text);
    if (derivMatch) {
      // Search the next ~10 lines for name/pname
      let derivName: string | null = null;
      for (let j = i; j <= Math.min(i + 10, lines.length - 1); j++) {
        const nm = DERIV_NAME_RE.exec(lines[j]!.text);
        if (nm) {
          derivName = nm[1]!;
          break;
        }
      }
      if (derivName) {
        const sig = trunc(`${derivMatch[1]} { name = "${derivName}"; }`);
        symbols.push({
          id: makeId(filePath, derivName, 'class'),
          name: derivName,
          kind: 'class',
          filePath,
          startByte: line.startByte,
          endByte: line.endByte,
          signature: sig,
          summary: precedingComment(lines, i) ?? `Nix derivation: ${derivName}`,
        });
      }
      continue;
    }

    // ── Top-level attribute binding (depth 0 or 1) ───────────────────────
    if (depthBefore > 1) continue;

    const bindMatch = BINDING_RE.exec(line.text);
    if (!bindMatch) continue;

    const name = bindMatch[2]!;
    // Skip common structural keywords that look like bindings but aren't symbols
    if (['inherit', 'let', 'in', 'with', 'assert', 'rec'].includes(name)) continue;
    // Skip single-char names (too generic)
    if (name.length < 2) continue;

    const isFunction = FUNC_VALUE_RE.test(line.text);
    const kind: SymbolKind = isFunction ? 'function' : 'const';

    // Build signature: the line up to and including the `=`, trimmed
    const rawSig = line.text.replace(/\s+/g, ' ').trim();
    // Truncate long RHS — show just `name = ...`
    const eqIdx = rawSig.indexOf('=');
    const sigPrefix = eqIdx >= 0 ? rawSig.slice(0, eqIdx + 1).trimEnd() + ' ...' : rawSig;

    symbols.push({
      id: makeId(filePath, name, kind),
      name,
      kind,
      filePath,
      startByte: line.startByte,
      endByte: line.endByte,
      signature: trunc(sigPrefix),
      summary: precedingComment(lines, i) ?? `Nix ${kind}: ${name}`,
    });
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract `import ./path` and `import <pkg>` expressions as ImportRecords.
 * Nix's `import` is an expression (not a statement), so we scan all lines.
 */
function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];
  // Matches: import ./path  or  import ../path  or  import <name>
  const importRe = /\bimport\s+(<[^>]+>|\.[./][\w./+-]*|\.\.\/[\w./+-]*)/g;

  for (const { text } of lines) {
    // Strip line comments before matching
    const uncommented = text.replace(/#.*$/, '');
    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(uncommented)) !== null) {
      const specifier = m[1]!.trim();
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: specifier.startsWith('.') ? specifier : null,
        importedNames: [],
        isTypeOnly: false,
      });
    }
  }

  // Deduplicate by specifier
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

export const nixHandler: LanguageHandler = {
  extensions: () => ['.nix'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
