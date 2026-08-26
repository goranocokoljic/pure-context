/**
 * Groovy language handler — regex-based extraction.
 *
 * Handles both Groovy source files (.groovy) and Gradle build files (.gradle).
 * Gradle DSL keywords (task, tasks.register) are treated as function symbols.
 *
 * Symbols extracted:
 *   class Name { }               → kind: 'class'
 *   def name(args) { }          → kind: 'function' (top-level) or 'method' (inside class)
 *   def name = value             → kind: 'const' (top-level) or field inside class
 *   task name { }               → kind: 'function' (Gradle DSL)
 *   tasks.register('name') { }  → kind: 'function' (Gradle DSL)
 *
 * Docstrings: preceding /** * / Groovydoc block or // comment.
 * Imports: `import [static] com.example.Class` → ImportRecord.
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
 * Strips // line comments before counting braces.
 */
function findBlockEnd(lines: LineInfo[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const noComment = lines[i]!.text.replace(/\/\/.*$/, '');
    let inStr = false;
    let strChar = '';
    for (let j = 0; j < noComment.length; j++) {
      const ch = noComment[j]!;
      if (inStr) {
        if (ch === strChar && noComment[j - 1] !== '\\') inStr = false;
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
 * Extract preceding Groovydoc `/** ... * /` block or `//` comment as a summary.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;
  // Skip a single blank line
  if (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const above = lines[i]!.text.trim();

  // ── Groovydoc /** ... */ block ────────────────────────────────────────────
  if (above.endsWith('*/')) {
    const docLines: string[] = [];
    while (i >= 0) {
      const t = lines[i]!.text.trim();
      const cleaned = t
        .replace(/^\/\*\*/, '')
        .replace(/^\s*\*+\/?/, '')
        .trim();
      if (cleaned) docLines.unshift(cleaned);
      if (t.startsWith('/**') || t === '/*') break;
      i--;
    }
    if (docLines.length > 0) {
      const content = docLines.join(' ').trim();
      const m = content.match(/^([^.!?]*[.!?]?)/);
      return ((m ? m[1]!.trim() : content).slice(0, 200)) || null;
    }
  }

  // ── // line comments ──────────────────────────────────────────────────────
  const collected: string[] = [];
  let j = lineIdx - 1;
  while (j >= 0) {
    const t = lines[j]!.text.trim();
    const m = /^\/\/\s?(.*)/.exec(t);
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

// class declaration — anchored to avoid matching string literals
const CLASS_RE = /^(?:(?:public|private|protected|abstract|final|static|@[\w.]+)\s+)*class\s+(\w+)/;
// def name( → function or method
const DEF_FN_RE = /^(?:(?:public|private|protected|static|final)\s+|@[\w.]+\s+)*def\s+(\w+)\s*\(/;
// def name = → variable/constant
const DEF_VAR_RE = /^(?:(?:public|private|protected|static|final)\s+|@[\w.]+\s+)*def\s+(\w+)\s*=/;
// task name or task name(type: ...) — Gradle DSL
const TASK_RE = /^task\s+(\w+)/;
// tasks.register('name') or tasks.register("name") — Gradle DSL
const TASKS_REGISTER_RE = /^tasks\.register\s*\(\s*['"](\w+)['"]/;
// import [static] com.example.Class
const IMPORT_RE = /^import\s+(?:static\s+)?([\w.*]+)\s*;?\s*$/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i]!.text.trim();

    // Skip blank lines and line comments
    if (!lineText || lineText.startsWith('//')) {
      i++;
      continue;
    }

    // Skip block comment blocks
    if (lineText.startsWith('/*')) {
      while (i < lines.length && !lines[i]!.text.includes('*/')) i++;
      i++;
      continue;
    }

    // Skip import lines (handled in extractImports)
    if (IMPORT_RE.test(lineText)) {
      i++;
      continue;
    }

    // ── class Name → kind: 'class' ────────────────────────────────────────────
    const classMatch = CLASS_RE.exec(lineText);
    if (classMatch) {
      const name = classMatch[1]!;
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(`class ${name}`),
        summary: precedingComment(lines, i) ?? `Groovy class: ${name}`,
      });

      // Scan inside the class block for methods and fields
      for (let j = i + 1; j < end; j++) {
        const inner = lines[j]!.text.trim();
        if (!inner || inner.startsWith('//')) continue;

        // Skip nested block comments
        if (inner.startsWith('/*')) {
          while (j < end && !lines[j]!.text.includes('*/')) j++;
          continue;
        }

        // Skip nested class definitions
        if (CLASS_RE.test(inner)) {
          j = findBlockEnd(lines, j);
          continue;
        }

        // def name(args) → method
        const methodMatch = DEF_FN_RE.exec(inner);
        if (methodMatch) {
          const mname = methodMatch[1]!;
          const mend = findBlockEnd(lines, j);
          const sigLine = inner.replace(/\{[^}]*$/, '').trim();
          symbols.push({
            id: makeId(filePath, `${name}.${mname}`, 'method'),
            name: `${name}.${mname}`,
            kind: 'method',
            filePath,
            startByte: lines[j]!.startByte,
            endByte: lines[mend]!.endByte,
            signature: trunc(sigLine || `def ${mname}()`),
            summary: precedingComment(lines, j) ?? `Groovy method: ${mname}`,
          });
          j = mend;
          continue;
        }

        // def name = value → field/const
        const fieldMatch = DEF_VAR_RE.exec(inner);
        if (fieldMatch) {
          const fname = fieldMatch[1]!;
          symbols.push({
            id: makeId(filePath, `${name}.${fname}`, 'const'),
            name: `${name}.${fname}`,
            kind: 'const',
            filePath,
            startByte: lines[j]!.startByte,
            endByte: lines[j]!.endByte,
            signature: trunc(inner),
            summary: precedingComment(lines, j) ?? `Groovy field: ${fname}`,
          });
          continue;
        }
      }

      i = end + 1;
      continue;
    }

    // ── def name(args) → top-level function ──────────────────────────────────
    const fnMatch = DEF_FN_RE.exec(lineText);
    if (fnMatch) {
      const name = fnMatch[1]!;
      const sigLine = lineText.replace(/\{[^}]*$/, '').trim();
      const end = findBlockEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(sigLine || `def ${name}()`),
        summary: precedingComment(lines, i) ?? `Groovy function: ${name}`,
      });
      i = end + 1;
      continue;
    }

    // ── def name = value → top-level const ───────────────────────────────────
    const varMatch = DEF_VAR_RE.exec(lineText);
    if (varMatch) {
      const name = varMatch[1]!;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(lineText),
        summary: precedingComment(lines, i) ?? `Groovy variable: ${name}`,
      });
      i++;
      continue;
    }

    // ── task name { } → Gradle task → kind: 'function' ───────────────────────
    const taskMatch = TASK_RE.exec(lineText);
    if (taskMatch) {
      const name = taskMatch[1]!;
      if (lineText.includes('{')) {
        const end = findBlockEnd(lines, i);
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: lines[i]!.startByte,
          endByte: lines[end]!.endByte,
          signature: trunc(`task ${name}`),
          summary: precedingComment(lines, i) ?? `Gradle task: ${name}`,
        });
        i = end + 1;
      } else {
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: lines[i]!.startByte,
          endByte: lines[i]!.endByte,
          signature: trunc(`task ${name}`),
          summary: precedingComment(lines, i) ?? `Gradle task: ${name}`,
        });
        i++;
      }
      continue;
    }

    // ── tasks.register('name') → Gradle task ─────────────────────────────────
    const regMatch = TASKS_REGISTER_RE.exec(lineText);
    if (regMatch) {
      const name = regMatch[1]!;
      if (lineText.includes('{')) {
        const end = findBlockEnd(lines, i);
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: lines[i]!.startByte,
          endByte: lines[end]!.endByte,
          signature: trunc(`task ${name}`),
          summary: precedingComment(lines, i) ?? `Gradle task: ${name}`,
        });
        i = end + 1;
      } else {
        i++;
      }
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
    if (m) {
      const specifier = m[1]!;
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null, // Groovy imports are package-based, not file-relative
        importedNames: [specifier.split('.').pop() ?? specifier],
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

// ─── Package extraction ───────────────────────────────────────────────────────

const PACKAGE_RE = /^package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?\s*$/;

/**
 * Declared package: `package com.example.foo` → "com.example.foo".
 * The package statement must precede all code, so the scan stops at the first
 * non-comment code line — a `package` inside a string or Gradle block never matches.
 */
function extractPackage(_tree: Tree | null, source: Buffer): string | null {
  for (const { text } of buildLineIndex(source)) {
    const trimmed = text.trim();
    const m = PACKAGE_RE.exec(trimmed);
    if (m) return m[1];
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('#!')) continue; // shebang
    break; // first real code line without a package declaration
  }
  return null;
}

export const groovyHandler: LanguageHandler = {
  extensions: () => ['.groovy', '.gradle'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
  extractPackage,
};
