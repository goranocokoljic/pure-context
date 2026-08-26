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


function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];

  function walkForRequires(nodes: SyntaxNode[]): void {
    for (const node of nodes) {
      if (node.type !== 'call') continue;

      const methodNode =
        node.childForFieldName?.('method') ??
        node.children.find((c) => c.type === 'identifier');
      const methodText = methodNode?.text ?? '';

      if (methodText !== 'require' && methodText !== 'require_relative') continue;

      // Arguments: argument_list containing a string, or a bare string
      const argsNode =
        node.childForFieldName?.('arguments') ??
        node.children.find(
          (c) => c.type === 'argument_list' || c.type === 'string',
        );
      if (!argsNode) continue;

      const strNode =
        argsNode.type === 'string'
          ? argsNode
          : argsNode.children.find((c) => c.type === 'string');
      if (!strNode) continue;

      // Extract string content: prefer string_content child, else strip quotes
      const contentNode = strNode.children.find((c) => c.type === 'string_content');
      const specifier = contentNode
        ? contentNode.text
        : stripRubyStringQuotes(strNode.text);

      if (!specifier) continue;

      imports.push({
        sourceFile: '',    // patched to relPath by index-manager
        specifier,
        resolvedPath: null, // require_relative resolution deferred; no filePath in interface
        importedNames: [],
        isTypeOnly: false,
      });
    }
  }

  walkForRequires(tree.rootNode.children);
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
