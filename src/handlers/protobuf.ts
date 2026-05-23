/**
 * Protocol Buffers language handler — regex-based extraction.
 *
 * Rationale: no pre-built WASM for tree-sitter-proto is available on npm.
 * Proto syntax is block-structured and well-suited for line-by-line regex parsing.
 *
 * Symbols extracted:
 *   message Name { }                        → kind: 'class'
 *   service Name { }                        → kind: 'interface'
 *   rpc Method(Input) returns (Output)      → kind: 'method' (nested inside service)
 *   enum Name { }                           → kind: 'enum'
 *   extend Message { }                      → kind: 'class', name: extend.Message
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
 * Find the line index where the block opened at `startLine` closes.
 * Strips `//` line comments before counting braces to avoid false positives.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    // Strip line comments and string literals before counting braces
    const noComment = lines[i]!.text.replace(/\/\/.*$/, '');
    let inStr = false;
    for (let j = 0; j < noComment.length; j++) {
      const ch = noComment[j]!;
      if (inStr) {
        if (ch === '"' && noComment[j - 1] !== '\\') inStr = false;
      } else if (ch === '"') {
        inStr = true;
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
 * Walk backwards from `lineIdx` collecting consecutive `//` comment lines.
 * Stops at any blank line or non-comment line.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  const collected: string[] = [];
  let i = lineIdx - 1;
  while (i >= 0) {
    const trimmed = lines[i]!.text.trim();
    const m = /^\/\/\s?(.*)/.exec(trimmed);
    if (m) {
      collected.unshift(m[1]!.trim());
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

// ─── Patterns ─────────────────────────────────────────────────────────────────

const MESSAGE_RE = /^message\s+(\w+)/;
const SERVICE_RE = /^service\s+(\w+)/;
const ENUM_RE    = /^enum\s+(\w+)/;
const EXTEND_RE  = /^extend\s+(\w+)/;
// RPC: rpc MethodName(InputType) returns (OutputType)  — optional streaming keywords
const RPC_RE     = /^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?([^)]+)\)\s+returns\s*\(\s*(stream\s+)?([^)]+)\)/;
const IMPORT_RE  = /^import\s+"([^"]+)"\s*;/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i]!.text.trim();

    // Skip blank lines and comment lines
    if (!lineText || lineText.startsWith('//') || lineText.startsWith('/*') || lineText.startsWith('*')) {
      i++;
      continue;
    }

    // ── message Name → kind: 'class' ────────────────────────────────────────
    const msgMatch = MESSAGE_RE.exec(lineText);
    if (msgMatch) {
      const name = msgMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`message ${name}`),
        summary: precedingComment(lines, i) ?? `Protocol Buffers message: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── service Name → kind: 'interface', scan inside for RPCs ──────────────
    const svcMatch = SERVICE_RE.exec(lineText);
    if (svcMatch) {
      const svcName = svcMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, svcName, 'interface'),
        name: svcName,
        kind: 'interface',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`service ${svcName}`),
        summary: precedingComment(lines, i) ?? `Protocol Buffers service: ${svcName}`,
      });

      // Scan the service block for rpc methods
      for (let j = i + 1; j < end; j++) {
        const rpcMatch = RPC_RE.exec(lines[j]!.text);
        if (rpcMatch) {
          const rpcName = rpcMatch[1]!;
          const streamIn = rpcMatch[2] ? 'stream ' : '';
          const inputType = rpcMatch[3]!.trim();
          const streamOut = rpcMatch[4] ? 'stream ' : '';
          const outputType = rpcMatch[5]!.trim();
          const methodName = `${svcName}.${rpcName}`;
          symbols.push({
            id: makeId(filePath, methodName, 'method'),
            name: methodName,
            kind: 'method',
            filePath,
            startByte: lines[j]!.startByte,
            endByte: lines[j]!.endByte,
            signature: trunc(`rpc ${rpcName}(${streamIn}${inputType}) returns (${streamOut}${outputType})`),
            summary: precedingComment(lines, j) ?? `RPC method: ${rpcName}`,
            frameworkMeta: { serviceName: svcName },
          });
        }
      }

      i = end + 1;
      continue;
    }

    // ── enum Name → kind: 'enum' ─────────────────────────────────────────────
    const enumMatch = ENUM_RE.exec(lineText);
    if (enumMatch) {
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
        summary: precedingComment(lines, i) ?? `Protocol Buffers enum: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── extend Message → kind: 'class', name: extend.Message ────────────────
    const extMatch = EXTEND_RE.exec(lineText);
    if (extMatch) {
      const baseName = extMatch[1]!;
      const name = `extend.${baseName}`;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`extend ${baseName}`),
        summary: precedingComment(lines, i) ?? `Protocol Buffers extension of: ${baseName}`,
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract `import "path.proto";` statements as ImportRecords.
 * Local imports (starting with "./") get a resolved path; well-known and
 * package-relative imports (e.g. "google/protobuf/timestamp.proto") are external.
 */
function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];

  for (const { text } of lines) {
    const m = IMPORT_RE.exec(text.trim());
    if (m) {
      const specifier = m[1]!;
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: specifier.startsWith('.') ? specifier : null,
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

export const protobufHandler: LanguageHandler = {
  extensions: () => ['.proto'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
