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
const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

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

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Extract the text content from an Elixir @doc or @moduledoc attribute node.
 * The attribute is a `unary_operator` whose inner `call` has identifier "doc"/"moduledoc"
 * and an `arguments` node containing a `string`.
 */
function extractAttrText(attrNode: SyntaxNode): string | null {
  const call = attrNode.children.find((c) => c.type === 'call');
  if (!call) return null;
  const args = call.children.find((c) => c.type === 'arguments');
  const strNode = args?.children.find((c) => c.type === 'string');
  if (!strNode) return null;
  const content = strNode.children.find((c) => c.type === 'quoted_content');
  if (!content) return null;
  const text = content.text
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 200);
  return text || null;
}

/**
 * Walk `previousNamedSibling` to find a `@doc` attribute preceding a
 * function/macro definition.  Skips over `@spec` and `@since` siblings.
 */
export function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;
  while (prev?.type === 'unary_operator') {
    const call = prev.children.find((c) => c.type === 'call');
    const attrName = call?.children.find((c) => c.type === 'identifier')?.text;
    if (attrName === 'doc' || attrName === 'moduledoc') {
      return extractAttrText(prev);
    }
    // Keep scanning past @spec, @deprecated, @since, etc.
    prev = prev.previousNamedSibling;
  }
  return null;
}

/**
 * Look for @moduledoc inside the first children of a defmodule's do_block.
 */
function extractModuledoc(doBlock: SyntaxNode): string | null {
  for (const child of doBlock.children) {
    if (child.type !== 'unary_operator') continue;
    const call = child.children.find((c) => c.type === 'call');
    const attrName = call?.children.find((c) => c.type === 'identifier')?.text;
    if (attrName === 'moduledoc') return extractAttrText(child);
  }
  return null;
}

// ─── @spec lookup ─────────────────────────────────────────────────────────────

/**
 * Walk `previousNamedSibling` to find a `@spec` attribute preceding a
 * function/macro definition.  Returns the full @spec text or null.
 */
function findSpec(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;
  while (prev?.type === 'unary_operator') {
    const call = prev.children.find((c) => c.type === 'call');
    const attrName = call?.children.find((c) => c.type === 'identifier')?.text;
    if (attrName === 'spec') {
      return trunc(prev.text.replace(/^@/, ''));
    }
    prev = prev.previousNamedSibling;
  }
  return null;
}

// ─── Name extraction helpers ──────────────────────────────────────────────────

/**
 * Extract the function name from a `def`/`defmacro` call's `arguments` node.
 * Handles:
 *   - Simple:  arguments → call("greet(name)")      → identifier "greet"
 *   - Guards:  arguments → binary_operator("greet(name) when ...") → call → identifier
 *   - Inline:  arguments → [call("greet(x)"), keywords("do: x")]  → identifier "greet"
 */
function getFunctionName(argsNode: SyntaxNode): string {
  const first = argsNode.children.find((c) => c.isNamed);
  if (!first) return '';
  if (first.type === 'call') {
    return first.children.find((c) => c.type === 'identifier')?.text ?? '';
  }
  if (first.type === 'binary_operator') {
    const callChild = first.children.find((c) => c.type === 'call');
    return callChild?.children.find((c) => c.type === 'identifier')?.text ?? '';
  }
  // Zero-arity function with no parentheses: `def version, do: ...`
  if (first.type === 'identifier') {
    return first.text;
  }
  return '';
}

/**
 * Build the function head text (without the `do` block) from the arguments node.
 * Returns "greet(name) when guard" or "greet(name)" etc.
 */
function getFunctionHead(argsNode: SyntaxNode): string {
  const first = argsNode.children.find((c) => c.isNamed);
  if (!first) return argsNode.text.replace(/\s+/g, ' ').trim();
  if (first.type === 'call' || first.type === 'binary_operator') {
    return first.text.replace(/\s+/g, ' ').trim();
  }
  // Zero-arity function with no parentheses: `def version, do: ...`
  if (first.type === 'identifier') {
    return first.text;
  }
  return argsNode.text.replace(/\s+/g, ' ').trim();
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

/**
 * Recursively walk the body of a defmodule/defprotocol/defimpl do_block,
 * emitting symbols for def, defmacro, defstruct, @callback, @type, and nested
 * defmodule/defprotocol/defimpl declarations.
 *
 * @param nodes       - Named children of the current do_block (or root)
 * @param modulePath  - Dotted module name of the enclosing context, or ''
 * @param filePath    - Relative file path used for symbol IDs
 * @param symbols     - Accumulator
 */
function walkBody(
  nodes: SyntaxNode[],
  modulePath: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const node of nodes) {
    if (node.type === 'call') {
      const kw = node.children.find((c) => c.type === 'identifier')?.text ?? '';
      processCall(node, kw, modulePath, filePath, symbols);
    } else if (node.type === 'unary_operator') {
      processAttr(node, modulePath, filePath, symbols);
    }
  }
}

/**
 * Process a `call` node that may be a defmodule / def / defmacro / defstruct /
 * defprotocol / defimpl / alias / import / use / require.
 */
function processCall(
  node: SyntaxNode,
  kw: string,
  modulePath: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const argsNode = node.children.find((c) => c.type === 'arguments');
  const doBlock = node.children.find((c) => c.type === 'do_block');

  switch (kw) {
    // ── defmodule ─────────────────────────────────────────────────────────────
    case 'defmodule': {
      const moduleName = argsNode?.children.find((c) => c.type === 'alias')?.text ?? '';
      if (!moduleName) break;
      // Qualify if nested
      const qualName = modulePath ? `${modulePath}.${moduleName}` : moduleName;
      const summary = doBlock ? (extractModuledoc(doBlock) ?? '') : '';
      symbols.push({
        id: makeId(filePath, qualName, 'class'),
        name: qualName,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`defmodule ${qualName}`),
        summary,
      });
      if (doBlock) {
        walkBody(
          doBlock.children.filter((c) => c.isNamed),
          qualName,
          filePath,
          symbols,
        );
      }
      break;
    }

    // ── def (public function) ──────────────────────────────────────────────────
    case 'def': {
      if (!argsNode) break;
      const fnName = getFunctionName(argsNode);
      if (!fnName) break;
      const qualName = modulePath ? `${modulePath}.${fnName}` : fnName;
      const spec = findSpec(node);
      const head = getFunctionHead(argsNode);
      const signature = spec ? trunc(spec) : trunc(`def ${head}`);
      symbols.push({
        id: makeId(filePath, qualName, 'function'),
        name: qualName,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature,
        summary: extractDocstring(node) ?? '',
      });
      break;
    }

    // ── defp (private function) — skip ────────────────────────────────────────
    case 'defp':
      break;

    // ── defmacro ───────────────────────────────────────────────────────────────
    case 'defmacro': {
      if (!argsNode) break;
      const fnName = getFunctionName(argsNode);
      if (!fnName) break;
      const qualName = modulePath ? `${modulePath}.${fnName}` : fnName;
      const head = getFunctionHead(argsNode);
      symbols.push({
        id: makeId(filePath, qualName, 'function'),
        name: qualName,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`defmacro ${head}`),
        summary: extractDocstring(node) ?? '',
        frameworkMeta: { elixir_macro: true },
      });
      break;
    }

    // ── defmacrop (private macro) — skip ──────────────────────────────────────
    case 'defmacrop':
      break;

    // ── defstruct ─────────────────────────────────────────────────────────────
    case 'defstruct': {
      // The struct's name IS the enclosing module name
      const structName = modulePath || 'UnknownModule';
      const fieldsText = argsNode?.text.replace(/\s+/g, ' ').trim() ?? '';
      symbols.push({
        id: makeId(filePath, structName, 'type'),
        name: structName,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`defstruct ${fieldsText}`),
        summary: extractDocstring(node) ?? '',
      });
      break;
    }

    // ── defprotocol ───────────────────────────────────────────────────────────
    case 'defprotocol': {
      const protoName = argsNode?.children.find((c) => c.type === 'alias')?.text ?? '';
      if (!protoName) break;
      const qualName = modulePath ? `${modulePath}.${protoName}` : protoName;
      symbols.push({
        id: makeId(filePath, qualName, 'interface'),
        name: qualName,
        kind: 'interface',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`defprotocol ${qualName}`),
        summary: extractDocstring(node) ?? '',
      });
      if (doBlock) {
        walkBody(
          doBlock.children.filter((c) => c.isNamed),
          qualName,
          filePath,
          symbols,
        );
      }
      break;
    }

    // ── defimpl ───────────────────────────────────────────────────────────────
    case 'defimpl': {
      if (!argsNode) break;
      const protoAlias = argsNode.children.find((c) => c.type === 'alias')?.text ?? '';
      // Extract the `for:` type from keywords
      const kwNode = argsNode.children.find((c) => c.type === 'keywords');
      const forPair = kwNode?.children.find((c) => c.type === 'pair');
      const forType = forPair?.children.find((c) => c.type === 'alias' || c.type === 'atom')?.text ?? '';
      const implName = forType ? `${protoAlias}.${forType}` : protoAlias;
      const qualName = modulePath ? `${modulePath}.${implName}` : implName;
      symbols.push({
        id: makeId(filePath, qualName, 'class'),
        name: qualName,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`defimpl ${protoAlias}${forType ? `, for: ${forType}` : ''}`),
        summary: extractDocstring(node) ?? '',
        frameworkMeta: { elixir_impl: true },
      });
      if (doBlock) {
        walkBody(
          doBlock.children.filter((c) => c.isNamed),
          qualName,
          filePath,
          symbols,
        );
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Process a `unary_operator` node that may be a `@callback` or `@type` attribute.
 */
function processAttr(
  node: SyntaxNode,
  modulePath: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const call = node.children.find((c) => c.type === 'call');
  if (!call) return;
  const attrName = call.children.find((c) => c.type === 'identifier')?.text;
  if (!attrName) return;

  const argsNode = call.children.find((c) => c.type === 'arguments');

  if (attrName === 'callback') {
    // @callback notify(t()) :: :ok
    // arguments → binary_operator → call (LHS, has the callback name)
    const binOp = argsNode?.children.find((c) => c.type === 'binary_operator');
    const callNode = binOp?.children.find((c) => c.type === 'call');
    const cbName = callNode?.children.find((c) => c.type === 'identifier')?.text ?? '';
    if (!cbName) return;
    const qualName = modulePath ? `${modulePath}.${cbName}` : cbName;
    symbols.push({
      id: makeId(filePath, qualName, 'method'),
      name: qualName,
      kind: 'method',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: trunc(node.text.replace(/^@/, '')),
      summary: '',
    });
    return;
  }

  if (attrName === 'type') {
    // @type t :: %__MODULE__{}  or  @type name :: existing_type
    const binOp = argsNode?.children.find((c) => c.type === 'binary_operator');
    const typeNameNode = binOp
      ? binOp.children.find((c) => c.type === 'identifier' || c.type === 'call')
      : argsNode?.children.find((c) => c.type === 'identifier');
    const typeName =
      typeNameNode?.type === 'call'
        ? typeNameNode.children.find((c) => c.type === 'identifier')?.text
        : typeNameNode?.text;
    if (!typeName) return;
    const qualName = modulePath ? `${modulePath}.${typeName}` : typeName;
    symbols.push({
      id: makeId(filePath, qualName, 'type'),
      name: qualName,
      kind: 'type',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: trunc(node.text.replace(/^@/, '')),
      summary: '',
    });
  }
}

function extractSymbols(tree: Tree, _source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  walkBody(
    tree.rootNode.children.filter((c) => c.isNamed),
    '',
    filePath,
    symbols,
  );
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

const IMPORT_KEYWORDS = new Set(['alias', 'import', 'use', 'require']);

/**
 * Walk the full tree collecting alias/import/use/require directives at any depth.
 * Elixir module resolution is external, so resolvedPath is always null.
 */
function collectImports(nodes: SyntaxNode[], imports: ImportRecord[]): void {
  for (const node of nodes) {
    if (node.type === 'call') {
      const kw = node.children.find((c) => c.type === 'identifier')?.text ?? '';
      if (IMPORT_KEYWORDS.has(kw)) {
        const argsNode = node.children.find((c) => c.type === 'arguments');
        const specifierAlias = argsNode?.children.find((c) => c.type === 'alias');
        if (specifierAlias) {
          imports.push({
            sourceFile: '',
            specifier: specifierAlias.text,
            resolvedPath: null,
            importedNames: [],
            isTypeOnly: false,
          });
        }
      }
      // Recurse into do_block
      const doBlock = node.children.find((c) => c.type === 'do_block');
      if (doBlock) {
        collectImports(doBlock.children.filter((c) => c.isNamed), imports);
      }
    }
  }
}

function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  collectImports(tree.rootNode.children.filter((c) => c.isNamed), imports);
  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const elixirHandler: LanguageHandler = {
  extensions: () => ['.ex', '.exs'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-elixir.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
