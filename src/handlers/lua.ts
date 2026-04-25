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

function nodeText(node: SyntaxNode, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

function trunc(s: string, max = 120): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/**
 * Extract name and kind from a `function_identifier` node.
 * In tree-sitter-lua 2.0.0, `function_identifier` can be:
 *   - identifier(foo)           → kind='function', name='foo'
 *   - identifier(M).identifier(bar)  → kind='method', name='M.bar'
 *   - identifier(M):identifier(baz)  → kind='method', name='M:baz'
 *
 * The full text of the node gives us exactly what we need.
 */
function extractFnIdentifier(fnIdNode: SyntaxNode, src: string): { name: string; kind: SymbolKind } {
  const text = nodeText(fnIdNode, src).trim();

  if (text.includes(':')) return { name: text, kind: 'method' };
  if (text.includes('.')) return { name: text, kind: 'method' };
  return { name: text, kind: 'function' };
}

/**
 * Extract name and kind from a `variable` node used as an lvalue.
 * Full source text: 'M.login', 'greet', 'M:bar'.
 */
function extractVarName(varNode: SyntaxNode, src: string): { name: string; kind: SymbolKind } {
  const text = nodeText(varNode, src).trim();
  if (text.includes(':')) return { name: text, kind: 'method' };
  if (text.includes('.')) return { name: text, kind: 'method' };
  return { name: text, kind: 'function' };
}

/**
 * Build a parameters string including parentheses.
 * `parameter_list` node text is the inner content (e.g. 'a, b'); `(` and `)` are siblings.
 */
function buildParams(node: SyntaxNode, src: string): string {
  const paramsNode = node.children.find((c) => c.isNamed && c.type === 'parameter_list');
  return paramsNode ? `(${nodeText(paramsNode, src)})` : '()';
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;

  // Collect consecutive -- line comments immediately before the declaration
  const lineComments: string[] = [];
  while (prev && prev.type === 'comment') {
    const text = prev.text;

    // Block comment --[[ ... ]] — handle separately if no line comments collected yet
    if (text.startsWith('--[')) {
      if (lineComments.length === 0) {
        const inner = text
          .replace(/^--\[=*\[/, '') // strip --[[ or --[=[ prefix
          .replace(/\]=*\]$/, '')   // strip ]] or ]=] suffix
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' ');
        if (!inner) return null;
        const match = inner.match(/^([^.!?]*[.!?]?)/);
        return (match ? match[1]!.trim() : inner) || null;
      }
      break;
    }

    if (!text.startsWith('--')) break;

    // Line comment: strip the -- prefix
    lineComments.unshift(text.replace(/^--\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }

  if (lineComments.length > 0) {
    const joined = lineComments.join(' ');
    const match = joined.match(/^([^.!?]*[.!?]?)/);
    return (match ? match[1]!.trim() : joined) || null;
  }

  return null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed) continue;

    switch (node.type) {

      // ── function foo() end / function M.bar() end / function M:baz() end ────
      case 'function_definition_statement': {
        // The name is in a `function_identifier` child node
        const fnIdNode = node.children.find(
          (c) => c.isNamed && c.type === 'function_identifier',
        );
        if (!fnIdNode) break;

        const { name, kind } = extractFnIdentifier(fnIdNode, src);
        if (!name) break;

        const params = buildParams(node, src);
        const sig = trunc(`function ${name}${params}`);

        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? `Lua ${kind}: ${name}`,
        });
        break;
      }

      // ── local function foo() end ─────────────────────────────────────────────
      case 'local_function_definition_statement': {
        // Name is a direct `identifier` child
        const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
        if (!nameNode) break;
        const name = nodeText(nameNode, src);
        if (!name) break;

        const params = buildParams(node, src);
        const sig = trunc(`local function ${name}${params}`);

        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? `Lua function: ${name}`,
        });
        break;
      }

      // ── M.bar = function() end / greet = function() end ─────────────────────
      case 'variable_assignment': {
        const varList = node.children.find((c) => c.isNamed && c.type === 'variable_list');
        const exprList = node.children.find((c) => c.isNamed && c.type === 'expression_list');
        if (!varList || !exprList) break;

        // Check if first RHS expression is a `function_definition`
        const firstRhs = exprList.children.find((c) => c.isNamed);
        if (!firstRhs || firstRhs.type !== 'function_definition') break;

        // Get first LHS variable
        const firstVar = varList.children.find((c) => c.isNamed && c.type === 'variable');
        if (!firstVar) break;

        const { name, kind } = extractVarName(firstVar, src);
        if (!name) break;

        const params = buildParams(firstRhs, src);
        const sig = trunc(`function ${name}${params}`);

        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? `Lua ${kind}: ${name}`,
        });
        break;
      }

      // ── local foo = function() end / local M = {} ───────────────────────────
      case 'local_variable_declaration': {
        const varList = node.children.find((c) => c.isNamed && c.type === 'variable_list');
        const exprList = node.children.find((c) => c.isNamed && c.type === 'expression_list');
        if (!varList || !exprList) break;

        const firstRhs = exprList.children.find((c) => c.isNamed);
        if (!firstRhs) break;

        // Get first variable name
        const firstVar = varList.children.find((c) => c.isNamed && c.type === 'variable');
        if (!firstVar) break;
        const name = nodeText(firstVar, src).trim(); // just the identifier text
        if (!name) break;

        if (firstRhs.type === 'function_definition') {
          // local foo = function() end
          const params = buildParams(firstRhs, src);
          symbols.push({
            id: makeId(filePath, name, 'function'),
            name,
            kind: 'function',
            filePath,
            startByte: node.startIndex,
            endByte: node.endIndex,
            signature: trunc(`local function ${name}${params}`),
            summary: extractDocstring(node) ?? `Lua function: ${name}`,
          });
        } else if (firstRhs.type === 'table') {
          // local M = {} — only emit PascalCase or UPPER_SNAKE_CASE names
          if (!/^[A-Z]/.test(name)) break;

          symbols.push({
            id: makeId(filePath, name, 'const'),
            name,
            kind: 'const',
            filePath,
            startByte: node.startIndex,
            endByte: node.endIndex,
            signature: trunc(`local ${name} = { ... }`),
            summary: extractDocstring(node) ?? `Lua module table: ${name}`,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Convert a Lua require specifier to a relative file path.
 * "mymodule.utils" → "mymodule/utils.lua"
 * "socket"         → "socket.lua"
 */
function resolveRequirePath(specifier: string): string | null {
  return specifier.replace(/\./g, '/') + '.lua';
}

/**
 * Extract the require specifier string from a `function_call` node.
 * In tree-sitter-lua 2.0.0, require("socket") parses as:
 *   function_call → variable(require) + argument_list
 *   argument_list → "(" + expression_list + ")"
 *   expression_list → string("socket")
 */
function extractRequireFromCall(callNode: SyntaxNode, src: string): string | null {
  // Check that the function being called is named 'require'
  const funcVar = callNode.children.find((c) => c.isNamed && c.type === 'variable');
  if (!funcVar) return null;
  const funcName = nodeText(funcVar, src).trim();
  if (funcName !== 'require') return null;

  // Get argument list
  const argList = callNode.children.find((c) => c.isNamed && c.type === 'argument_list');
  if (!argList) return null;

  // argument_list contains: "(" expression_list ")" or "(" ")"
  const innerExprList = argList.children.find((c) => c.isNamed && c.type === 'expression_list');
  if (!innerExprList) return null;

  const strNode = innerExprList.children.find((c) => c.isNamed && c.type === 'string');
  if (!strNode) return null;

  const raw = nodeText(strNode, src);
  // Strip surrounding quotes (" or ')
  return raw.slice(1, -1);
}

/**
 * Get LHS variable names from a variable_list.
 */
function extractLhsNames(varList: SyntaxNode, src: string): string[] {
  return varList.children
    .filter((c) => c.isNamed && c.type === 'variable')
    .map((v) => {
      const text = nodeText(v, src).trim();
      // For simple identifiers, return as-is; for M.foo, return just the last part?
      // Actually for importedNames we want the binding name, which for 'M.foo = require()'
      // would be 'M.foo'. Just return the variable text.
      return text;
    });
}

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed) continue;

    // Both local declarations and plain assignments can be require() calls
    if (node.type !== 'variable_assignment' && node.type !== 'local_variable_declaration') {
      continue;
    }

    const varList = node.children.find((c) => c.isNamed && c.type === 'variable_list');
    const exprList = node.children.find((c) => c.isNamed && c.type === 'expression_list');
    if (!varList || !exprList) continue;

    // First RHS expression must be a `function_call` node
    const firstRhs = exprList.children.find((c) => c.isNamed);
    if (!firstRhs || firstRhs.type !== 'function_call') continue;

    const specifier = extractRequireFromCall(firstRhs, src);
    if (!specifier) continue;

    const importedNames = extractLhsNames(varList, src);
    const resolvedPath = resolveRequirePath(specifier);

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath,
      importedNames,
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const luaHandler: LanguageHandler = {
  extensions: () => ['.lua'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-lua.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
