import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { decodeCached } from '../core/offsets.js';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';
import { extractDslSymbol, extractDefineMethod, extractClassEval } from './ruby-dsl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Build a one-line signature: source from the node start up to (but not
 * including) the body_statement. Collapses whitespace, caps at 120 chars.
 */
function buildSignature(node: SyntaxNode, source: Buffer): string {
  const body =
    node.childForFieldName?.('body') ??
    node.children.find((c) => c.type === 'body_statement' || c.type === 'then');
  const endIdx = body ? body.startIndex : node.endIndex;
  // node indices are CHAR indices — slice the decoded string, never the buffer
  return decodeCached(source)
    .slice(node.startIndex, endIdx)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Walk the `previousNamedSibling` chain collecting consecutive `# comment`
 * lines. Strips the `# ` prefix, concatenates, and returns the first sentence.
 */
export function extractDocstring(node: SyntaxNode): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev?.type === 'comment') {
    lines.unshift(prev.text.replace(/^#\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }
  if (!lines.length) return null;

  const text = lines.filter(Boolean).join(' ');
  if (!text) return null;

  const match = text.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1].trim() : text).slice(0, 200)) || null;
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/** Get the method/class name from the `name` field or first identifier child. */
function getNameText(node: SyntaxNode): string {
  return (
    node.childForFieldName?.('name')?.text ??
    node.children.find(
      (c) => c.type === 'identifier' || c.type === 'constant',
    )?.text ??
    ''
  );
}

/** Get the class/module name — may be a scope_resolution (A::B) or constant. */
function getConstName(node: SyntaxNode): string {
  const nameNode =
    node.childForFieldName?.('name') ??
    node.children.find(
      (c) => c.type === 'constant' || c.type === 'scope_resolution',
    );
  return nameNode?.text ?? '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

/** Names of call methods that produce attribute accessors — skip them as definitions. */
const ATTR_CALLS = new Set(['attr_accessor', 'attr_reader', 'attr_writer']);

/**
 * Recursively walk a syntax node, emitting symbols into `symbols`.
 *
 * @param node     - Current AST node to inspect
 * @param className - The enclosing class/module name, or null at top level
 * @param source   - Source buffer for signature extraction
 * @param filePath - Relative file path for symbol records
 * @param symbols  - Accumulator for emitted symbols
 */
function walkNode(
  node: SyntaxNode,
  className: string | null,
  source: Buffer,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  switch (node.type) {
    // ── Instance method ───────────────────────────────────────────────────────
    case 'method': {
      const name = getNameText(node);
      if (!name) break;
      const qualified = className ? `${className}#${name}` : name;
      const kind: SymbolKind = className ? 'method' : 'function';
      const sym: SymbolRecord = {
        id: makeId(filePath, qualified, kind),
        name: qualified,
        kind,
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      };
      // Tag method_missing for dynamic dispatch discovery
      if (name === 'method_missing' || name === 'respond_to_missing?') {
        sym.frameworkMeta = { dynamicDispatch: true };
      }
      symbols.push(sym);
      break;
    }

    // ── Singleton method (def self.foo / def ClassName.foo) ──────────────────
    case 'singleton_method': {
      const name = getNameText(node);
      if (!name) break;
      const receiver = node.childForFieldName?.('object')?.text ?? 'self';
      // Use the enclosing className if receiver is 'self', otherwise the receiver text
      const owner = receiver === 'self' ? (className ?? 'self') : receiver;
      const qualified = `${owner}.${name}`;
      symbols.push({
        id: makeId(filePath, qualified, 'method'),
        name: qualified,
        kind: 'method',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      break;
    }

    // ── Class ─────────────────────────────────────────────────────────────────
    case 'class': {
      const name = getConstName(node);
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      // Recurse into body with this class name
      const body =
        node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'body_statement');
      if (body) {
        for (const child of body.children) {
          walkNode(child, name, source, filePath, symbols);
        }
      }
      break;
    }

    // ── Module ────────────────────────────────────────────────────────────────
    case 'module': {
      const name = getConstName(node);
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      // Recurse into body with the module name as the class context
      const body =
        node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'body_statement');
      if (body) {
        for (const child of body.children) {
          walkNode(child, name, source, filePath, symbols);
        }
      }
      break;
    }

    // ── Constant assignment (class/module scope only) ────────────────────────
    case 'assignment': {
      if (!className) break; // top-level constants skipped per spec
      const lhs =
        node.childForFieldName?.('left') ??
        node.children[0];
      if (lhs?.type !== 'constant') break;
      const constName = lhs.text;
      const qualified = `${className}::${constName}`;
      const sig = decodeCached(source)
        .slice(node.startIndex, node.endIndex)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      symbols.push({
        id: makeId(filePath, qualified, 'const'),
        name: qualified,
        kind: 'const',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: '',
      });
      break;
    }

    // ── call nodes: DSL extraction + metaprogramming detection ────────────
    case 'call': {
      const methodName =
        node.childForFieldName?.('method')?.text ??
        node.children.find((c) => c.type === 'identifier')?.text ?? '';

      if (ATTR_CALLS.has(methodName)) break;

      // define_method :foo do ... end (works at any scope)
      const defineMethodSym = extractDefineMethod(node, className, filePath);
      if (defineMethodSym) { symbols.push(defineMethodSym); break; }

      // class_eval / instance_eval / module_eval blocks (any scope)
      const classEvalSym = extractClassEval(node, className, filePath);
      if (classEvalSym) { symbols.push(classEvalSym); break; }

      // Rails DSL patterns (only meaningful inside a class/module)
      if (className) {
        const dslSym = extractDslSymbol(node, className, filePath);
        if (dslSym) { symbols.push(dslSym); break; }
      }

      break;
    }

    // ── alias — skip entirely ─────────────────────────────────────────────────
    case 'alias':
      break;

    default:
      break;
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  for (const child of tree.rootNode.children) {
    walkNode(child, null, source, filePath, symbols);
  }
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Strip surrounding quote characters from a Ruby string node text.
 * Handles `'foo'`, `"foo"`, and interpolated strings.
 */
function stripRubyStringQuotes(text: string): string {
  return text.replace(/^['"]|['"]$/g, '');
}

/** The literal string argument of a call, or null when it is dynamic. */
function firstStringArg(call: SyntaxNode): string | null {
  const argsNode =
    call.childForFieldName?.('arguments') ??
    call.children.find((c) => c.type === 'argument_list' || c.type === 'string');
  if (!argsNode) return null;
  const strNode =
    argsNode.type === 'string' ? argsNode : argsNode.children.find((c) => c.type === 'string');
  if (!strNode) return null;
  // An interpolated string (`"#{dir}/x"`) is dynamic — no record.
  const parts = strNode.children.filter(
    (c) => c.type === 'string_content' || c.type === 'interpolation',
  );
  if (parts.some((c) => c.type === 'interpolation')) return null;
  const contentNode = parts[0];
  return contentNode ? contentNode.text : stripRubyStringQuotes(strNode.text);
}

function callMethodName(call: SyntaxNode): string {
  return (
    call.childForFieldName?.('method')?.text ??
    call.children.find((c) => c.type === 'identifier')?.text ??
    ''
  );
}

function argumentList(call: SyntaxNode): SyntaxNode | undefined {
  return (
    call.childForFieldName?.('arguments') ??
    call.children.find((c) => c.type === 'argument_list')
  );
}

/** Mixin macros whose constant arguments are dependencies of the class. */
const MIXIN_CALLS = new Set(['include', 'extend', 'prepend']);
/** ActiveRecord association macros → the associated model constant. */
const SINGULAR_ASSOC = new Set(['belongs_to', 'has_one']);
const PLURAL_ASSOC = new Set(['has_many', 'has_and_belongs_to_many']);

const UNCOUNTABLE = new Set([
  'equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep',
  'jeans', 'police', 'data', 'metadata', 'media',
]);
const IRREGULAR: Record<string, string> = {
  people: 'person', men: 'man', children: 'child', sexes: 'sex', moves: 'move',
  zombies: 'zombie', women: 'woman', teeth: 'tooth', feet: 'foot', geese: 'goose',
};
const SINGULAR_RULES: ReadonlyArray<[RegExp, string]> = [
  [/(database)s$/i, '$1'],
  [/(quiz)zes$/i, '$1'],
  [/(matr)ices$/i, '$1ix'],
  [/(vert|ind)ices$/i, '$1ex'],
  [/^(ox)en$/i, '$1'],
  [/(alias|status)(es)?$/i, '$1'],
  [/(octop|vir)i$/i, '$1us'],
  [/(cris|ax|test)es$/i, '$1is'],
  [/(shoe)s$/i, '$1'],
  [/(o)es$/i, '$1'],
  [/(bus)(es)?$/i, '$1'],
  [/([ml])ice$/i, '$1ouse'],
  [/(x|ch|ss|sh)es$/i, '$1'],
  [/(m)ovies$/i, '$1ovie'],
  [/([^aeiouy]|qu)ies$/i, '$1y'],
  [/([lr])ves$/i, '$1f'],
  [/(tive)s$/i, '$1'],
  [/(hive)s$/i, '$1'],
  [/([^f])ves$/i, '$1fe'],
  [/(^analy)ses$/i, '$1sis'],
  [/([ti])a$/i, '$1um'],
  [/(n)ews$/i, '$1ews'],
  [/(ss)$/i, '$1'],
  [/s$/i, ''],
];

/**
 * Minimal ActiveSupport singularization — the rules that decide association
 * names in practice. A wrong guess costs nothing: the resolver validates every
 * constant against the indexed files and drops what it cannot find.
 */
export function singularizeRuby(word: string): string {
  const w = word.toLowerCase();
  if (UNCOUNTABLE.has(w)) return word;
  const irregular = IRREGULAR[w];
  if (irregular) return irregular;
  for (const [re, rep] of SINGULAR_RULES) {
    if (re.test(word)) return word.replace(re, rep);
  }
  return word;
}

/** `line_item` → `LineItem` (ActiveSupport camelize, no acronym table). */
export function camelizeRuby(word: string): string {
  return word
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

const CONSTANT_PATH = /^(::)?[A-Z][A-Za-z0-9_]*(::[A-Z][A-Za-z0-9_]*)*$/;

/** `:account` → `account`; quoted / dynamic symbols → null. */
function simpleSymbolName(node: SyntaxNode | undefined): string | null {
  if (!node || node.type !== 'simple_symbol') return null;
  const name = node.text.replace(/^:/, '');
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : null;
}

/** The constant an association macro names: `class_name:` wins, else inflect the symbol. */
function associationConstant(call: SyntaxNode, plural: boolean): string | null {
  const args = argumentList(call);
  if (!args) return null;
  let target: string | null = null;
  for (const arg of args.children) {
    if (arg.type !== 'pair') continue;
    const key = arg.children.find((c) => c.type === 'hash_key_symbol')?.text ?? '';
    if (key === 'polymorphic') return null; // no concrete class
    if (key === 'class_name') {
      const str = arg.children.find((c) => c.type === 'string');
      const content = str?.children.find((c) => c.type === 'string_content');
      if (content && CONSTANT_PATH.test(content.text)) target = content.text;
    }
  }
  if (target) return target;
  const sym = simpleSymbolName(args.children.find((c) => c.type === 'simple_symbol'));
  if (!sym) return null;
  return camelizeRuby(plural ? singularizeRuby(sym) : sym);
}

function constantText(node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (node.type !== 'constant' && node.type !== 'scope_resolution') return null;
  const text = node.text.replace(/\s+/g, '');
  return CONSTANT_PATH.test(text) ? text : null;
}

function bodyOf(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName?.('body') ??
    node.children.find((c) => c.type === 'body_statement')
  );
}

/**
 * Import records for a Ruby file (Phase 103, Task 641 — `ruby-resolver.ts`
 * turns them into edges; nothing is pre-resolved here because the handler
 * does not know its own path):
 *
 *  1. `require 'x/y'` anywhere in the file (a lazy require inside a method
 *     body is still a dependency) — specifier as written;
 *  2. `require_relative 'x'` — specifier normalised to `./x` so the resolver
 *     (and the cross-index rule, which never follows `.`-relative names
 *     into another index) can tell it from a load-path require;
 *  3. Zeitwerk constant references at CLASS-BODY level only (never inside a
 *     method — risk R1, fan-out): the superclass, `include` / `extend` /
 *     `prepend` arguments, and ActiveRecord association macros
 *     (`belongs_to :account` → `Account`, `has_many :line_items` →
 *     `LineItem`, `class_name:` wins, `polymorphic: true` skipped).
 *     Specifier = the constant path (`Admin::User`), leading `::` stripped.
 *
 * Each specifier is emitted once per file.
 */
function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const seen = new Set<string>();
  const push = (specifier: string, nesting: string[] = []): void => {
    const key = `${nesting.join('::')}\u0000${specifier}`;
    if (!specifier || seen.has(key)) return;
    seen.add(key);
    imports.push({
      sourceFile: '', // patched to relPath by index-manager
      specifier,
      resolvedPath: null, // resolved by src/graph/ruby-resolver.ts
      // Constant references only: the lexical nesting at the reference site
      // (`['Cask', 'DSL']` for a constant written inside `module Cask; class
      // DSL`) — Ruby looks a constant up from the innermost scope outward,
      // and the resolver replays that walk. Empty for require records.
      importedNames: nesting,
      isTypeOnly: false,
    });
  };
  const pushConstant = (text: string | null, nesting: string[]): void => {
    if (!text) return;
    // `::Foo` is an explicit top-level reference — no lexical walk.
    if (text.startsWith('::')) push(text.slice(2), []);
    else push(text, nesting);
  };

  function walkForRequires(node: SyntaxNode): void {
    if (node.type === 'call') {
      const methodText = callMethodName(node);
      if (methodText === 'require' || methodText === 'require_relative') {
        const specifier = firstStringArg(node);
        if (specifier) {
          if (methodText === 'require_relative') {
            push(specifier.startsWith('.') ? specifier : `./${specifier}`);
          } else {
            push(specifier);
          }
        }
      }
    }
    for (const child of node.children) walkForRequires(child);
  }

  function walkForConstants(nodes: SyntaxNode[], nesting: string[]): void {
    for (const node of nodes) {
      switch (node.type) {
        case 'class': {
          // the superclass is looked up in the scope OUTSIDE the class
          const sup = node.children.find((c) => c.type === 'superclass');
          pushConstant(
            constantText(
              sup?.children.find((c) => c.type === 'constant' || c.type === 'scope_resolution'),
            ),
            nesting,
          );
          const body = bodyOf(node);
          const name = getConstName(node).replace(/^::/, '');
          if (body) walkForConstants(body.children, name ? [...nesting, name] : nesting);
          break;
        }
        case 'module': {
          const body = bodyOf(node);
          const name = getConstName(node).replace(/^::/, '');
          if (body) walkForConstants(body.children, name ? [...nesting, name] : nesting);
          break;
        }
        case 'call': {
          const method = callMethodName(node);
          if (MIXIN_CALLS.has(method)) {
            for (const arg of argumentList(node)?.children ?? []) {
              pushConstant(constantText(arg), nesting);
            }
          } else if (SINGULAR_ASSOC.has(method) || PLURAL_ASSOC.has(method)) {
            pushConstant(associationConstant(node, PLURAL_ASSOC.has(method)), nesting);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  walkForRequires(tree.rootNode);
  walkForConstants(tree.rootNode.children, []);
  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const rubyHandler: LanguageHandler = {
  extensions: () => ['.rb'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-ruby.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
