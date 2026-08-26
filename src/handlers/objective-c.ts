/**
 * Objective-C language handler — regex-based extraction.
 *
 * Handles Objective-C and Objective-C++ source files (.m, .mm) and headers (.h).
 * Pure-C headers (no @interface / @protocol markers) are returned with 0 symbols
 * so the dispatcher can fall back to the C handler.
 *
 * Symbols extracted:
 *   @interface Name : SuperClass           → kind: 'class'
 *   @interface Name (Category)             → kind: 'class', name: 'Name+Category'
 *   @interface Name ()  (extension)        → kind: 'class', frameworkMeta.classExtension=true
 *   @protocol Name                         → kind: 'interface'
 *   - (ReturnType)methodName:(T)a kw:(T)b  → kind: 'method', name: 'methodName:kw:'
 *   + (ReturnType)classMethod              → kind: 'method', frameworkMeta.isClassMethod=true
 *   @property (...) Type name             → kind: 'property'
 *
 * Docstrings: preceding `/** ... *\/` or `///` comment block.
 * Imports: `#import "File.h"` and `#import <Framework/Header.h>` → ImportRecord.
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
 * Find the line containing the matching `@end` for an `@interface`/`@implementation`/`@protocol`
 * that started at startLine.
 */
function findAtEnd(lines: LineInfo[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^\s*@end\b/.test(lines[i]!.text)) return i;
  }
  return lines.length - 1;
}

/**
 * Extract a preceding doc comment (block /** ... *\/ or single-line ///  or //) summary.
 */
function precedingComment(lines: LineInfo[], lineIdx: number): string | null {
  // Try to find a block comment /** ... *\/ ending just before this line
  let i = lineIdx - 1;
  // Skip blank lines
  while (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const endLine = lines[i]!.text.trim();

  // Single-line /// comments
  if (endLine.startsWith('///')) {
    const collected: string[] = [];
    let j = i;
    while (j >= 0 && lines[j]!.text.trim().startsWith('///')) {
      const txt = lines[j]!.text.trim().replace(/^\/\/\/\s?/, '');
      collected.unshift(txt);
      j--;
    }
    const joined = collected.join(' ');
    const m = joined.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
  }

  // Block comment ending with */
  if (endLine.endsWith('*/')) {
    const collected: string[] = [];
    let j = i;
    while (j >= 0) {
      const t = lines[j]!.text.trim();
      if (t.startsWith('/**') || t.startsWith('/*!') || t === '/*') {
        // strip leading /** and trailing */
        const inner = t.replace(/^\/\*+!?\s*/, '').replace(/\*+\/$/, '').replace(/^\s*\*\s?/, '').trim();
        if (inner) collected.unshift(inner);
        break;
      }
      // middle line: strip leading *
      const inner = t.replace(/^\*\s?/, '').trim();
      if (inner && inner !== '*') collected.unshift(inner);
      j--;
    }
    const joined = collected.join(' ');
    const m = joined.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : joined).slice(0, 200)) || null;
  }

  // Single-line // comment
  if (endLine.startsWith('//')) {
    const txt = endLine.replace(/^\/\/\s?/, '').trim();
    const m = txt.match(/^([^.!?]*[.!?]?)/);
    return ((m ? m[1]!.trim() : txt).slice(0, 200)) || null;
  }

  return null;
}

// ─── ObjC detection guard ────────────────────────────────────────────────────

/** Returns true if the buffer looks like an Objective-C header (has @interface or @protocol). */
function isObjCHeader(source: Buffer): boolean {
  const peek = source.slice(0, 16 * 1024).toString('utf8');
  return /@interface\b/.test(peek) || /@protocol\b/.test(peek);
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// @interface ClassName : SuperClass <P1, P2>  or  @interface ClassName (Category)
// Groups: (1) className, (2) superclass, (3) protocols, (4) category name (undef if none, '' if anonymous)
const INTERFACE_RE =
  /^\s*@interface\s+(\w+)(?:\s*:\s*(\w+))?(?:\s*<([^>]+)>)?(?:\s*\((\w*)\))?/;

// @protocol Name
const PROTOCOL_RE = /^\s*@protocol\s+(\w+)\b/;
// @implementation Name or @implementation Name (Category)
const IMPL_RE = /^\s*@implementation\s+(\w+)(?:\s*\((\w+)\))?/;
// Instance method: - (ReturnType)methodName...
const INST_METHOD_RE = /^\s*-\s*\(([^)]+)\)\s*(\w+)/;
// Class method: + (ReturnType)methodName...
const CLASS_METHOD_RE = /^\s*\+\s*\(([^)]+)\)\s*(\w+)/;
// @property (...) Type *?name
const PROPERTY_RE = /^\s*@property\s*(?:\([^)]*\)\s*)?([\w\s*<>]+?)\s+\*?(\w+)\s*;/;
// #import "File.h" or #import <Framework/Header.h>
const IMPORT_RE = /^\s*#\s*import\s+["<]([^">]+)[">]/;
// #include "File.h" or #include <File.h>
const INCLUDE_RE = /^\s*#\s*include\s+["<]([^">]+)[">]/;

// ─── Selector builder ─────────────────────────────────────────────────────────

/**
 * Build the full Objective-C method selector from the declaration text.
 * - `- (void)setObject:(id)obj forKey:(id)key;` → `setObject:forKey:`
 * - `- (NSString *)name;` → `name`
 */
function buildSelector(lines: LineInfo[], startLine: number): { selector: string; endLine: number } {
  // Collect declaration text until ; or { (up to 10 lines for long signatures)
  let text = '';
  let endLine = startLine;
  for (let k = startLine; k < Math.min(startLine + 10, lines.length); k++) {
    const lineText = lines[k]!.text;
    text += ' ' + lineText;
    if (/[;{]/.test(lineText)) { endLine = k; break; }
    endLine = k;
  }

  // Strip leading - or + and the return type parenthetical
  const afterReturn = text.replace(/^\s*[+-]\s*\([^)]*\)\s*/, '');

  // Find all `word:` keyword segments (each becomes part of the selector)
  const keywordRe = /(\w+)\s*:/g;
  const parts: string[] = [];
  let m;
  while ((m = keywordRe.exec(afterReturn)) !== null) {
    // Stop at method body start or comment
    if (afterReturn.slice(0, m.index).includes('//') ||
        afterReturn.slice(0, m.index).includes('/*')) break;
    parts.push(m[1]! + ':');
  }

  if (parts.length === 0) {
    // No colons → method has no arguments
    const noArgMatch = /^(\w+)/.exec(afterReturn);
    return { selector: noArgMatch ? noArgMatch[1]! : '', endLine };
  }

  return { selector: parts.join(''), endLine };
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  // Detection guard: skip pure-C headers (no ObjC markers)
  if (filePath.endsWith('.h') && !isObjCHeader(source)) {
    return [];
  }

  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];

  // Track current interface/implementation context for method containment
  let currentClass: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!.text;
    const lineText = raw.trim();

    // ── @interface → 'class' ─────────────────────────────────────────────────
    if (lineText.startsWith('@interface')) {
      // GNUstep declares generic Foundation classes through a macro:
      //   @interface GS_GENERIC_CLASS(NSArray, __covariant ElementT) : NSObject
      // Without normalization the macro name is captured as the class name and
      // NSArray/NSString/NSDictionary/… vanish from the index entirely
      // (libs-base, Phase 88). Rewrite the macro call to its first argument.
      const normalized = lineText.replace(/GS_GENERIC_CLASS\s*\(\s*(\w+)[^)]*\)/g, '$1');
      const ifaceMatch = INTERFACE_RE.exec(normalized);
      if (ifaceMatch) {
        const className = ifaceMatch[1]!;
        const superclass = ifaceMatch[2] ?? null;
        const protocolsStr = ifaceMatch[3] ?? null;
        const categoryName = ifaceMatch[4]; // undefined = no parens; '' = anonymous; 'Name' = category

        let name: string;
        const meta: Record<string, unknown> = {};

        if (categoryName !== undefined) {
          if (categoryName === '') {
            // Anonymous class extension @interface Foo ()
            name = className;
            meta['classExtension'] = true;
          } else {
            // Named category @interface Foo (Bar)
            name = `${className}+${categoryName}`;
            meta['category'] = categoryName;
          }
        } else {
          name = className;
          if (superclass) meta['superclass'] = superclass;
          if (protocolsStr) meta['protocols'] = protocolsStr.split(',').map((p) => p.trim());
        }

        const end = findAtEnd(lines, i);
        const summary = precedingComment(lines, i) ?? `Objective-C interface: ${className}`;
        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: lines[i]!.startByte,
          endByte: lines[end]!.endByte,
          signature: trunc(lineText),
          summary,
          frameworkMeta: Object.keys(meta).length > 0 ? meta : undefined,
        });
        currentClass = className;
        i++;
        continue;
      }
    }

    // ── @protocol → 'interface' ───────────────────────────────────────────────
    const protoMatch = PROTOCOL_RE.exec(lineText);
    if (protoMatch) {
      const name = protoMatch[1]!;
      const end = findAtEnd(lines, i);
      symbols.push({
        id: makeId(filePath, name, 'interface'),
        name,
        kind: 'interface',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[end]!.endByte,
        signature: trunc(lineText),
        summary: precedingComment(lines, i) ?? `Objective-C protocol: ${name}`,
      });
      currentClass = name;
      i++;
      continue;
    }

    // ── @implementation → continue tracking context ───────────────────────────
    const implMatch = IMPL_RE.exec(lineText);
    if (implMatch) {
      currentClass = implMatch[1]!;
      i++;
      continue;
    }

    // ── @end → clear context ──────────────────────────────────────────────────
    if (/^\s*@end\b/.test(lineText)) {
      currentClass = null;
      i++;
      continue;
    }

    // ── Instance method - (ReturnType)name → 'method' ─────────────────────────
    const instMatch = INST_METHOD_RE.exec(lineText);
    if (instMatch) {
      const returnType = instMatch[1]!.trim();
      const { selector, endLine } = buildSelector(lines, i);
      const qualifiedName = currentClass ? `${currentClass}:${selector}` : selector;

      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[endLine]!.endByte,
        signature: trunc(`- (${returnType})${selector}`),
        summary: precedingComment(lines, i) ?? `Instance method: ${selector}`,
        frameworkMeta: { isClassMethod: false },
      });
      i = endLine + 1;
      continue;
    }

    // ── Class method + (ReturnType)name → 'method' ────────────────────────────
    const classMatch = CLASS_METHOD_RE.exec(lineText);
    if (classMatch) {
      const returnType = classMatch[1]!.trim();
      const { selector, endLine } = buildSelector(lines, i);
      const qualifiedName = currentClass ? `${currentClass}::${selector}` : selector;

      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[endLine]!.endByte,
        signature: trunc(`+ (${returnType})${selector}`),
        summary: precedingComment(lines, i) ?? `Class method: ${selector}`,
        frameworkMeta: { isClassMethod: true },
      });
      i = endLine + 1;
      continue;
    }

    // ── @property → 'property' ────────────────────────────────────────────────
    const propMatch = PROPERTY_RE.exec(lineText);
    if (propMatch) {
      const propName = propMatch[2]!;
      const qualifiedName = currentClass ? `${currentClass}.${propName}` : propName;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'property'),
        name: qualifiedName,
        kind: 'property',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[i]!.endByte,
        signature: trunc(lineText),
        summary: precedingComment(lines, i) ?? `Property: ${propName}`,
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
  const seen = new Set<string>();

  for (const { text } of lines) {
    const t = text.trim();

    let specifier: string | null = null;
    let isLocal = false;

    const importMatch = IMPORT_RE.exec(t);
    if (importMatch) {
      specifier = importMatch[1]!;
      isLocal = t.includes('"');
    } else {
      const includeMatch = INCLUDE_RE.exec(t);
      if (includeMatch) {
        specifier = includeMatch[1]!;
        isLocal = t.includes('"');
      }
    }

    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: isLocal ? specifier : null,
      importedNames: [specifier.split('/').pop()?.replace(/\.h$/, '') ?? specifier],
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

export const objectiveCHandler: LanguageHandler = {
  extensions: () => ['.m', '.mm', '.h'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
