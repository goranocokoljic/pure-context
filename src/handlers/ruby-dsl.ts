/**
 * Ruby DSL symbol extraction — Rails associations, callbacks, scopes, validations.
 *
 * This module is invoked from ruby.ts when walking `call` nodes inside class/module bodies.
 * It is data-driven: adding new Rails DSL patterns only requires extending DSL_TABLE.
 */

import { createHash } from 'crypto';
import type { SymbolRecord, SymbolKind, SyntaxNode } from '../core/types.js';

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── DSL table ────────────────────────────────────────────────────────────────

type DslArgKind = 'symbol' | 'string' | 'any';

interface DslEntry {
  macroName: string;
  emitKind: SymbolKind;
  metaKey: string;         // frameworkMeta key that describes this DSL call
  argKind: DslArgKind;
}

const DSL_TABLE: DslEntry[] = [
  // ── ActiveRecord associations ─────────────────────────────────────────────
  { macroName: 'has_many',                   emitKind: 'property',    metaKey: 'has_many',    argKind: 'symbol' },
  { macroName: 'has_one',                    emitKind: 'property',    metaKey: 'has_one',     argKind: 'symbol' },
  { macroName: 'belongs_to',                 emitKind: 'property',    metaKey: 'belongs_to',  argKind: 'symbol' },
  { macroName: 'has_and_belongs_to_many',    emitKind: 'property',    metaKey: 'habtm',       argKind: 'symbol' },

  // ── ActiveRecord scopes & validations ────────────────────────────────────
  { macroName: 'scope',                      emitKind: 'method',      metaKey: 'scope',       argKind: 'symbol' },
  { macroName: 'validates',                  emitKind: 'property',    metaKey: 'validation',  argKind: 'symbol' },
  { macroName: 'validate',                   emitKind: 'property',    metaKey: 'validation',  argKind: 'symbol' },
  { macroName: 'validates_presence_of',      emitKind: 'property',    metaKey: 'validation',  argKind: 'symbol' },
  { macroName: 'validates_uniqueness_of',    emitKind: 'property',    metaKey: 'validation',  argKind: 'symbol' },

  // ── ActionController callbacks ────────────────────────────────────────────
  { macroName: 'before_action',              emitKind: 'middleware',  metaKey: 'before_action',  argKind: 'symbol' },
  { macroName: 'after_action',               emitKind: 'middleware',  metaKey: 'after_action',   argKind: 'symbol' },
  { macroName: 'around_action',              emitKind: 'middleware',  metaKey: 'around_action',  argKind: 'symbol' },
  { macroName: 'before_filter',              emitKind: 'middleware',  metaKey: 'before_filter',  argKind: 'symbol' },
  { macroName: 'after_filter',               emitKind: 'middleware',  metaKey: 'after_filter',   argKind: 'symbol' },

  // ── ActiveRecord/ActiveModel lifecycle callbacks ──────────────────────────
  { macroName: 'before_create',              emitKind: 'middleware',  metaKey: 'before_create',  argKind: 'symbol' },
  { macroName: 'after_create',               emitKind: 'middleware',  metaKey: 'after_create',   argKind: 'symbol' },
  { macroName: 'before_save',                emitKind: 'middleware',  metaKey: 'before_save',    argKind: 'symbol' },
  { macroName: 'after_save',                 emitKind: 'middleware',  metaKey: 'after_save',     argKind: 'symbol' },
  { macroName: 'before_destroy',             emitKind: 'middleware',  metaKey: 'before_destroy', argKind: 'symbol' },
  { macroName: 'after_destroy',              emitKind: 'middleware',  metaKey: 'after_destroy',  argKind: 'symbol' },
  { macroName: 'before_validation',          emitKind: 'middleware',  metaKey: 'before_validation', argKind: 'symbol' },
  { macroName: 'after_validation',           emitKind: 'middleware',  metaKey: 'after_validation',  argKind: 'symbol' },
  { macroName: 'after_commit',               emitKind: 'middleware',  metaKey: 'after_commit',   argKind: 'symbol' },
  { macroName: 'after_rollback',             emitKind: 'middleware',  metaKey: 'after_rollback', argKind: 'symbol' },
];

const DSL_MAP = new Map<string, DslEntry>(DSL_TABLE.map((e) => [e.macroName, e]));

// ─── Argument helpers ─────────────────────────────────────────────────────────

/** Extract the first symbol (:name) or string ("name") argument from an argument_list. */
function extractFirstArg(argList: SyntaxNode, argKind: DslArgKind): string | null {
  for (const child of argList.children) {
    if (argKind !== 'string' && child.type === 'simple_symbol') {
      // :foo → strip leading colon
      return child.text.slice(1);
    }
    if (argKind !== 'string' && child.type === 'hash_key_symbol') {
      return child.text;
    }
    if (argKind !== 'symbol' && (child.type === 'string' || child.type === 'string_literal')) {
      const content = child.children.find((c) => c.type === 'string_content');
      return content ? content.text : child.text.replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

/** Extract `through:` option value from an association's argument_list, if present. */
function extractThroughOption(argList: SyntaxNode): string | null {
  for (const child of argList.children) {
    // hash node or pair node
    if (child.type === 'hash' || child.type === 'pair') {
      const pairs = child.type === 'pair' ? [child] : child.children.filter((c) => c.type === 'pair');
      for (const pair of pairs) {
        const key = pair.children[0];
        const val = pair.children[pair.children.length - 1];
        if (!key || !val) continue;
        const keyText = key.text.replace(/^:/, '');
        if (keyText === 'through') {
          return val.text.replace(/^:/, '').replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }
  return null;
}

/** Extract `polymorphic: true` option. */
function extractPolymorphicOption(argList: SyntaxNode): boolean {
  for (const child of argList.children) {
    if (child.type === 'hash' || child.type === 'pair') {
      const pairs = child.type === 'pair' ? [child] : child.children.filter((c) => c.type === 'pair');
      for (const pair of pairs) {
        const key = pair.children[0];
        const val = pair.children[pair.children.length - 1];
        if (!key || !val) continue;
        const keyText = key.text.replace(/^:/, '');
        if (keyText === 'polymorphic' && val.type === 'true') return true;
      }
    }
  }
  return false;
}

/** Extract `only:` option for before_action (returns array of action names). */
function extractOnlyOption(argList: SyntaxNode): string[] | null {
  for (const child of argList.children) {
    if (child.type === 'hash' || child.type === 'pair') {
      const pairs = child.type === 'pair' ? [child] : child.children.filter((c) => c.type === 'pair');
      for (const pair of pairs) {
        const key = pair.children[0];
        const val = pair.children[pair.children.length - 1];
        if (!key || !val) continue;
        const keyText = key.text.replace(/^:/, '');
        if (keyText === 'only') {
          // Value may be :symbol, array_literal, etc.
          if (val.type === 'simple_symbol') return [val.text.slice(1)];
          if (val.type === 'array') {
            return val.children
              .filter((c) => c.type === 'simple_symbol')
              .map((c) => c.text.slice(1));
          }
        }
      }
    }
  }
  return null;
}

// ─── Main extraction function ─────────────────────────────────────────────────

/**
 * Attempt to extract a DSL symbol from a `call` node inside a class/module body.
 * Returns a SymbolRecord when the call matches a known DSL pattern, null otherwise.
 */
export function extractDslSymbol(
  node: SyntaxNode,
  className: string,
  filePath: string,
): SymbolRecord | null {
  // Method name: either `method` field child or first identifier child
  const methodNode =
    node.childForFieldName?.('method') ??
    node.children.find((c) => c.type === 'identifier');
  if (!methodNode) return null;

  const macroName = methodNode.text;
  const entry = DSL_MAP.get(macroName);
  if (!entry) return null;

  // Argument list
  const argList =
    node.childForFieldName?.('arguments') ??
    node.children.find((c) => c.type === 'argument_list');
  if (!argList) return null;

  const symName = extractFirstArg(argList, entry.argKind);
  if (!symName) return null;

  const qualified = `${className}#${symName}`;

  // Build frameworkMeta
  const meta: Record<string, unknown> = { [entry.metaKey]: true };

  if (macroName === 'before_action' || macroName === 'before_filter' ||
      macroName === 'after_action' || macroName === 'after_filter' ||
      macroName === 'around_action' ||
      macroName === 'before_create' || macroName === 'after_create' ||
      macroName === 'before_save' || macroName === 'after_save' ||
      macroName === 'before_destroy' || macroName === 'after_destroy' ||
      macroName === 'before_validation' || macroName === 'after_validation' ||
      macroName === 'after_commit' || macroName === 'after_rollback') {
    meta['target'] = symName;
    const only = extractOnlyOption(argList);
    if (only) meta['onlyActions'] = only;
  }

  if (macroName === 'has_many' || macroName === 'has_one' ||
      macroName === 'belongs_to' || macroName === 'has_and_belongs_to_many') {
    meta['assoc'] = entry.metaKey === 'habtm' ? 'habtm' : macroName;
    const through = extractThroughOption(argList);
    if (through) meta['through'] = through;
    const polymorphic = extractPolymorphicOption(argList);
    if (polymorphic) meta['polymorphic'] = true;
  }

  // Signature: first ~80 chars of the call node source
  const callText = node.text.replace(/\s+/g, ' ').trim().slice(0, 80);

  return {
    id: makeId(filePath, qualified, entry.emitKind),
    name: qualified,
    kind: entry.emitKind,
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: callText,
    summary: `${macroName} :${symName} (Rails DSL)`,
    frameworkMeta: meta,
  };
}

// ─── Metaprogramming detection ────────────────────────────────────────────────

/**
 * Extract a symbol from `define_method :foo do ... end` patterns.
 * Returns a SymbolRecord with kind=method and frameworkMeta.definedDynamically=true.
 */
export function extractDefineMethod(
  node: SyntaxNode,
  className: string | null,
  filePath: string,
): SymbolRecord | null {
  const methodNode =
    node.childForFieldName?.('method') ??
    node.children.find((c) => c.type === 'identifier');
  if (!methodNode || methodNode.text !== 'define_method') return null;

  const argList =
    node.childForFieldName?.('arguments') ??
    node.children.find((c) => c.type === 'argument_list');
  if (!argList) return null;

  const symName = extractFirstArg(argList, 'any');
  if (!symName) return null;

  const qualified = className ? `${className}#${symName}` : symName;

  return {
    id: makeId(filePath, qualified, 'method'),
    name: qualified,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: node.text.replace(/\s+/g, ' ').trim().slice(0, 80),
    summary: `define_method :${symName} (dynamic)`,
    frameworkMeta: { definedDynamically: true },
  };
}

/**
 * Detect `class_eval` / `instance_eval` block calls and emit a synthetic symbol
 * so agents can locate where dynamic class modifications happen.
 */
export function extractClassEval(
  node: SyntaxNode,
  className: string | null,
  filePath: string,
): SymbolRecord | null {
  const methodNode =
    node.childForFieldName?.('method') ??
    node.children.find((c) => c.type === 'identifier');
  if (!methodNode) return null;
  const macroName = methodNode.text;
  if (macroName !== 'class_eval' && macroName !== 'instance_eval' &&
      macroName !== 'module_eval') return null;

  const owner = className ?? 'toplevel';
  const line = node.startPosition?.row != null ? node.startPosition.row + 1 : 0;
  const syntheticName = `${owner}#__${macroName}_${line}__`;

  // Signature: first line of the block
  const firstLine = node.text.split('\n')[0]?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? macroName;

  return {
    id: makeId(filePath, syntheticName, 'method'),
    name: syntheticName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: firstLine,
    summary: `${macroName} block at line ${line}`,
    frameworkMeta: { metaprogramming: macroName },
  };
}
