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
 * Extract Roxygen2 documentation (`#'` lines) immediately preceding `node`.
 * Walks `previousNamedSibling` looking for `comment` nodes whose text
 * starts with `#'`. Returns null when no Roxygen2 comment is found.
 */
export function extractDocstring(node: SyntaxNode): string | null {
  // Collect contiguous #' comment lines before this node
  const roxygenLines: string[] = [];
  let prev = node.previousNamedSibling;

  // Walk backwards, collecting comment nodes
  const commentNodes: SyntaxNode[] = [];
  while (prev && prev.type === 'comment') {
    commentNodes.unshift(prev);
    prev = prev.previousNamedSibling;
  }

  for (const c of commentNodes) {
    const text = c.text;
    if (text.startsWith("#'")) {
      // Strip `#' ` or `#'` prefix
      roxygenLines.push(text.replace(/^#'\s?/, ''));
    }
  }

  if (roxygenLines.length === 0) return null;

  // Strip @title, @description tags — keep first descriptive paragraph
  const lines = roxygenLines.filter((l) => !l.startsWith('@'));
  const summary = lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return summary || null;
}

// ─── Depth helpers ────────────────────────────────────────────────────────────

/**
 * Returns true when `node` is nested inside a `function_definition` body.
 * Used to skip local assignments.
 */
function isNested(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'function_definition') return true;
    if (parent.type === 'program') return false;
    parent = parent.parent;
  }
  return false;
}

// ─── S3 method detection ──────────────────────────────────────────────────────

// Common S3 generics — used to detect S3 method patterns
const KNOWN_GENERICS = new Set([
  'print', 'summary', 'plot', 'format', 'as', 'is', 'length', 'dim',
  'names', 'str', 'head', 'tail', 'subset', 'merge', 'sort', 'order',
  'unique', 'duplicated', 'rev', 'c', 'rbind', 'cbind', 'apply',
  'predict', 'fitted', 'residuals', 'coef', 'vcov', 'logLik', 'AIC',
  'update', 'model.frame', 'model.matrix', 'terms', 'formula',
  'toJSON', 'fromJSON', 'write', 'read', 'load', 'save',
  'initialize', 'show', 'Math', 'Ops', 'Complex', 'Summary',
]);

/**
 * Returns true if `name` looks like an S3 method (`generic.class`).
 * Requires that the part before the first dot is a known generic OR
 * the name contains at least one dot (conservative detection).
 */
function isS3Method(name: string): boolean {
  const dotIdx = name.indexOf('.');
  if (dotIdx <= 0) return false;
  const generic = name.slice(0, dotIdx);
  // Skip names like ".hidden" or single-char dotted names
  if (!generic || generic.length < 2) return false;
  // Match if known generic, or if name has dot (all dotted function names)
  return KNOWN_GENERICS.has(generic) || dotIdx > 0;
}

// ─── Signature builders ───────────────────────────────────────────────────────

/**
 * Build an R function signature: `name <- function(arg1, arg2 = default)`.
 * Preserves default argument expressions, truncating the whole thing to 120 chars.
 */
function functionSignature(
  name: string,
  paramsNode: SyntaxNode | null,
  operator: string,
): string {
  const params = paramsNode ? paramsNode.text : '()';
  const arrow = operator === '=' ? '=' : '<-';
  return trunc(`${name} ${arrow} function${params}`);
}

// ─── Call helpers ─────────────────────────────────────────────────────────────

/**
 * Return the identifier text for a `call` node's function field.
 * Handles plain identifiers and `pkg::fn` namespace operators.
 */
function callFunctionName(node: SyntaxNode): string {
  const fn = node.childForFieldName?.('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  // namespace_operator: `pkg::fn` → return right-hand identifier
  if (fn.type === 'namespace_operator') {
    const right = fn.children[fn.children.length - 1];
    return right?.text ?? '';
  }
  return '';
}

/**
 * Get the first positional argument of a call as a string node value.
 * Used to extract class names from `setClass("Name", ...)` etc.
 */
function firstCallArgText(node: SyntaxNode): string {
  const argsNode = node.childForFieldName?.('arguments');
  if (!argsNode) return '';
  for (const child of argsNode.children) {
    if (child.type === 'argument') {
      const value = child.childForFieldName?.('value') ?? child.children.find((c) => c.isNamed);
      if (!value) continue;
      // Unwrap string literal
      if (value.type === 'string') {
        const content = value.children.find((c) => c.type === 'string_content');
        return content?.text ?? value.text.replace(/^["']|["']$/g, '');
      }
      return value.text;
    }
    // Some grammars put arguments directly as children
    if (child.isNamed && child.type === 'string') {
      const content = child.children.find((c) => c.type === 'string_content');
      return content?.text ?? child.text.replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, _source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  walkTopLevel(tree.rootNode.children, filePath, symbols);
  return symbols;
}

const ASSIGN_OPS = new Set(['<-', '<<-', '=']);
const RIGHT_ASSIGN_OPS = new Set(['->', '->>']);

function walkTopLevel(
  nodes: SyntaxNode[],
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const node of nodes) {
    if (!node.isNamed) continue;

    if (node.type === 'binary_operator') {
      processBinaryOp(node, filePath, symbols);
    } else if (node.type === 'call') {
      processCall(node, filePath, symbols);
    } else if (node.type === 'braced_expression' || node.type === 'program') {
      // Recurse into top-level braces (rare but valid)
      walkTopLevel(node.children, filePath, symbols);
    }
    // Skip: comments, literals, if/for/while at top level
  }
}

function processBinaryOp(
  node: SyntaxNode,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // Skip nested (inside function body)
  if (isNested(node)) return;

  const lhs = node.childForFieldName?.('lhs');
  const rhs = node.childForFieldName?.('rhs');
  const opNode = node.childForFieldName?.('operator') ??
    node.children.find((c) => !c.isNamed && isAssignToken(c.text));
  const op = opNode?.text ?? '';

  if (!lhs || !rhs || !op) return;

  if (ASSIGN_OPS.has(op)) {
    // name <- value  OR  name = value
    if (lhs.type !== 'identifier' && lhs.type !== 'string') return;
    const name = lhs.type === 'string'
      ? (lhs.children.find((c) => c.type === 'string_content')?.text ?? lhs.text)
      : lhs.text;
    if (!name) return;

    if (rhs.type === 'function_definition') {
      emitFunction(node, name, rhs, op, filePath, symbols);
    } else if (rhs.type === 'call') {
      // Check for S4/R6 class definitions assigned to a name
      const fnName = callFunctionName(rhs);
      if (fnName === 'setRefClass') {
        // setRefClass: class name from first arg or variable name
        const className = firstCallArgText(rhs) || name;
        symbols.push({
          id: makeId(filePath, className, 'class'),
          name: className,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`setRefClass("${className}", ...)`),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { r_ref_class: true },
        });
      } else if (fnName === 'R6Class') {
        const className = firstCallArgText(rhs) || name;
        symbols.push({
          id: makeId(filePath, className, 'class'),
          name: className,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`R6Class("${className}", ...)`),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { r_r6_class: true },
        });
      } else {
        // Non-function RHS: const
        emitConst(node, name, filePath, symbols);
      }
    } else {
      emitConst(node, name, filePath, symbols);
    }
  } else if (RIGHT_ASSIGN_OPS.has(op)) {
    // (function(...)) -> name  OR  value -> name
    if (rhs.type !== 'identifier' && rhs.type !== 'string') return;
    const name = rhs.type === 'string'
      ? (rhs.children.find((c) => c.type === 'string_content')?.text ?? rhs.text)
      : rhs.text;
    if (!name) return;

    // Unwrap parenthesized_expression: (function(...) body) -> name
    const innerLhs =
      lhs.type === 'parenthesized_expression'
        ? lhs.children.find((c) => c.isNamed)
        : lhs;

    if (innerLhs?.type === 'function_definition') {
      emitFunction(node, name, innerLhs, '->', filePath, symbols);
    } else {
      emitConst(node, name, filePath, symbols);
    }
  }
}

function isAssignToken(text: string): boolean {
  return ASSIGN_OPS.has(text) || RIGHT_ASSIGN_OPS.has(text);
}

function emitFunction(
  node: SyntaxNode,
  name: string,
  fnDefNode: SyntaxNode,
  op: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const paramsNode = fnDefNode.childForFieldName?.('parameters') ?? null;
  const kind: SymbolKind = isS3Method(name) ? 'method' : 'function';
  symbols.push({
    id: makeId(filePath, name, kind),
    name,
    kind,
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: functionSignature(name, paramsNode, op),
    summary: extractDocstring(node) ?? '',
    ...(isS3Method(name) ? { frameworkMeta: { r_s3_method: true } } : {}),
  });
}

function emitConst(
  node: SyntaxNode,
  name: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const firstLine = node.text.split('\n')[0] ?? node.text;
  symbols.push({
    id: makeId(filePath, name, 'const'),
    name,
    kind: 'const',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: trunc(firstLine),
    summary: extractDocstring(node) ?? '',
  });
}

function processCall(
  node: SyntaxNode,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  if (isNested(node)) return;

  const fnName = callFunctionName(node);
  if (!fnName) return;

  if (fnName === 'setClass') {
    const className = firstCallArgText(node);
    if (!className) return;
    symbols.push({
      id: makeId(filePath, className, 'class'),
      name: className,
      kind: 'class',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: trunc(`setClass("${className}", ...)`),
      summary: extractDocstring(node) ?? '',
      frameworkMeta: { r_s4_class: true },
    });
  } else if (fnName === 'setMethod') {
    const methodName = firstCallArgText(node);
    if (!methodName) return;
    symbols.push({
      id: makeId(filePath, methodName, 'method'),
      name: methodName,
      kind: 'method',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: trunc(`setMethod("${methodName}", ...)`),
      summary: extractDocstring(node) ?? '',
      frameworkMeta: { r_s4_method: true },
    });
  } else if (fnName === 'setGeneric') {
    const genericName = firstCallArgText(node);
    if (!genericName) return;
    symbols.push({
      id: makeId(filePath, genericName, 'function'),
      name: genericName,
      kind: 'function',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: trunc(`setGeneric("${genericName}", ...)`),
      summary: extractDocstring(node) ?? '',
      frameworkMeta: { r_s4_generic: true },
    });
  }
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  collectImports(tree.rootNode.children, imports);
  return imports;
}

const IMPORT_FNS = new Set(['library', 'require', 'requireNamespace', 'loadNamespace']);

function collectImports(nodes: SyntaxNode[], imports: ImportRecord[]): void {
  for (const node of nodes) {
    if (!node.isNamed) continue;

    if (node.type === 'call') {
      const fnName = callFunctionName(node);

      if (IMPORT_FNS.has(fnName)) {
        const pkg = firstCallArgText(node);
        if (pkg) {
          imports.push({
            sourceFile: '',
            specifier: pkg,
            resolvedPath: null,
            importedNames: [],
            isTypeOnly: false,
          });
        }
      } else if (fnName === 'source') {
        const filePath = firstCallArgText(node);
        if (filePath) {
          imports.push({
            sourceFile: '',
            specifier: filePath,
            resolvedPath: filePath.startsWith('.') || filePath.endsWith('.R') || filePath.endsWith('.r')
              ? filePath
              : null,
            importedNames: [],
            isTypeOnly: false,
          });
        }
      } else if (fnName === 'from' || fnName === 'import') {
        // import::from(pkg, func1, func2) — handled via namespace_operator
        // The call would be `import::from(pkg, func1, func2)` where function is namespace_operator
        const callFn = node.childForFieldName?.('function');
        if (callFn?.type === 'namespace_operator') {
          const pkg = firstCallArgText(node);
          if (pkg) {
            const names = extractImportFromNames(node);
            imports.push({
              sourceFile: '',
              specifier: pkg,
              resolvedPath: null,
              importedNames: names,
              isTypeOnly: false,
            });
          }
        }
      }
      // Recurse into call arguments for nested library() calls
      const argsNode = node.childForFieldName?.('arguments');
      if (argsNode) collectImports(argsNode.children, imports);
    } else if (node.type === 'binary_operator') {
      // Recurse into assignments at top level
      const rhs = node.childForFieldName?.('rhs');
      if (rhs) collectImports([rhs], imports);
    } else if (node.type === 'braced_expression') {
      collectImports(node.children, imports);
    }
  }
}

/**
 * Extract imported function names from `import::from(pkg, func1, func2)`.
 * Skips the first argument (package name).
 */
function extractImportFromNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const argsNode = node.childForFieldName?.('arguments');
  if (!argsNode) return names;

  let first = true;
  for (const child of argsNode.children) {
    if (child.type !== 'argument') continue;
    if (first) { first = false; continue; } // skip pkg name
    const value = child.childForFieldName?.('value') ?? child.children.find((c) => c.isNamed);
    if (value?.type === 'identifier') names.push(value.text);
    else if (value?.type === 'string') {
      const content = value.children.find((c) => c.type === 'string_content');
      if (content) names.push(content.text);
    }
  }
  return names;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const rHandler: LanguageHandler = {
  extensions: () => ['.r', '.R', '.Rmd'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-r.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
