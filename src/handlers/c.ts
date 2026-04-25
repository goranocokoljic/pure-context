import { createHash } from 'crypto';
import { dirname, resolve, relative, join } from 'path';
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

// ─── Static detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the function_definition has a `static` storage class specifier.
 * Walks direct children and one level into declaration_specifiers.
 */
function isStaticFunction(node: SyntaxNode, src: string): boolean {
  for (const child of node.children) {
    if (child.type === 'storage_class_specifier' && nodeText(child, src) === 'static') {
      return true;
    }
    if (child.type === 'declaration_specifiers') {
      for (const c of child.children) {
        if (c.type === 'storage_class_specifier' && nodeText(c, src) === 'static') {
          return true;
        }
      }
    }
  }
  return false;
}

// ─── Declarator name extraction ───────────────────────────────────────────────

/**
 * Recursively unwrap declarator nodes to find the innermost identifier.
 * Handles: function_declarator, pointer_declarator, parenthesized_declarator,
 * abstract_pointer_declarator, array_declarator.
 */
function extractDeclaratorName(declarator: SyntaxNode, src: string): string | null {
  switch (declarator.type) {
    case 'identifier':
      return nodeText(declarator, src);

    case 'function_declarator': {
      // First named child that isn't `parameter_list` or `attribute_specifier` is the inner declarator
      for (const child of declarator.children) {
        if (child.type === 'parameter_list') continue;
        if (child.type === 'attribute_specifier') continue;
        if (!child.isNamed) continue;
        const name = extractDeclaratorName(child, src);
        if (name) return name;
      }
      return null;
    }

    case 'pointer_declarator':
    case 'parenthesized_declarator':
    case 'array_declarator': {
      // Walk named children to find the inner declarator
      for (const child of declarator.children) {
        if (!child.isNamed) continue;
        const name = extractDeclaratorName(child, src);
        if (name) return name;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Find the function declarator within a declarator tree (for signature slicing).
 * Returns the function_declarator node itself.
 */
function findFunctionDeclarator(declarator: SyntaxNode): SyntaxNode | null {
  if (declarator.type === 'function_declarator') return declarator;
  for (const child of declarator.children) {
    if (!child.isNamed) continue;
    const found = findFunctionDeclarator(child);
    if (found) return found;
  }
  return null;
}

// ─── Signature builders ───────────────────────────────────────────────────────

/**
 * Build function signature: everything from start of node to end of function_declarator.
 */
function buildFunctionSignature(node: SyntaxNode, src: string): string {
  // Find the declarator child (direct child named field)
  const declaratorChild = node.children.find(
    (c) => c.isNamed && ['function_declarator', 'pointer_declarator', 'parenthesized_declarator'].includes(c.type),
  );
  if (declaratorChild) {
    const funcDecl = findFunctionDeclarator(declaratorChild);
    if (funcDecl) {
      const raw = src.slice(node.startIndex, funcDecl.endIndex);
      return trunc(raw);
    }
  }
  // Fallback: slice to body
  const body = node.children.find((c) => c.type === 'compound_statement');
  const end = body ? body.startIndex : node.endIndex;
  return trunc(src.slice(node.startIndex, end));
}

/**
 * Build struct signature: `struct Name { field1; field2; ... }` showing first 2 fields.
 */
function buildStructSignature(node: SyntaxNode, src: string, name: string): string {
  const body = node.children.find((c) => c.type === 'field_declaration_list');
  if (!body) return trunc(`struct ${name}`);

  const fields = body.children
    .filter((c) => c.isNamed && c.type === 'field_declaration')
    .map((c) => nodeText(c, src).replace(/\s+/g, ' ').trim());

  if (fields.length === 0) return trunc(`struct ${name} {}`);
  if (fields.length <= 2) return trunc(`struct ${name} { ${fields.join('; ')}; }`);
  return trunc(`struct ${name} { ${fields[0]!}; ${fields[1]!}; ... }`);
}

/**
 * Build enum signature: `enum Name { CONST1, CONST2, ... }` showing first 3 constants.
 */
function buildEnumSignature(node: SyntaxNode, src: string, name: string): string {
  const body = node.children.find((c) => c.type === 'enumerator_list');
  if (!body) return trunc(`enum ${name}`);

  const consts = body.children
    .filter((c) => c.isNamed && c.type === 'enumerator')
    .map((c) => {
      const id = c.children.find((cc) => cc.type === 'identifier');
      return id ? nodeText(id, src) : nodeText(c, src);
    });

  if (consts.length === 0) return trunc(`enum ${name} {}`);
  const shown = consts.slice(0, 3).join(', ');
  const suffix = consts.length > 3 ? ', ...' : '';
  return trunc(`enum ${name} { ${shown}${suffix} }`);
}

// ─── Typedef name extraction ──────────────────────────────────────────────────

/**
 * For `typedef ... Name`, the typedef alias is the last `type_identifier` child
 * of the `type_definition` node (not inside the type specifier).
 */
function getTypedefName(node: SyntaxNode, src: string): string | null {
  // The declarator of a type_definition is the type_identifier after the type
  // In tree-sitter-c, type_definition looks like:
  //   (type_definition type: (...) declarator: (type_identifier "Name"))
  // The last named child that is a type_identifier at the direct level is the alias.
  const reversed = [...node.children].reverse();
  for (const child of reversed) {
    if (child.type === 'type_identifier') return nodeText(child, src);
    if (child.type === 'pointer_declarator') {
      // typedef ... *Name — walk into it
      const inner = child.children.find((c) => c.type === 'type_identifier');
      if (inner) return nodeText(inner, src);
    }
  }
  return null;
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;

  // Collect consecutive line comments (// style)
  const lineComments: string[] = [];
  while (prev && prev.type === 'comment') {
    const text = prev.text;
    if (!text.startsWith('//')) break;
    lineComments.unshift(text.replace(/^\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }
  if (lineComments.length > 0) {
    const joined = lineComments.join(' ');
    const match = joined.match(/^([^.!?]*[.!?]?)/);
    return ((match ? match[1]!.trim() : joined) || null);
  }

  // Check for block comment immediately before (/* ... */ style)
  if (prev && prev.type === 'comment') {
    const text = prev.text;
    if (text.startsWith('/*')) {
      const inner = text
        .replace(/^\/\*+/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      if (!inner) return null;
      const match = inner.match(/^([^.!?]*[.!?]?)/);
      return ((match ? match[1]!.trim() : inner) || null);
    }
  }

  return null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

/**
 * Collect top-level declaration nodes, recursing into preprocessor conditionals
 * (preproc_ifdef, preproc_ifndef, preproc_if, preproc_else, preproc_elif) so that
 * declarations inside header guards are still extracted.
 */
function collectTopLevelNodes(nodes: SyntaxNode[]): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (const node of nodes) {
    if (
      node.type === 'preproc_ifdef' ||
      node.type === 'preproc_if' ||
      node.type === 'preproc_else' ||
      node.type === 'preproc_elif'
    ) {
      result.push(...collectTopLevelNodes(node.children));
    } else {
      result.push(node);
    }
  }
  return result;
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  const topLevel = collectTopLevelNodes(tree.rootNode.children);

  for (const node of topLevel) {
    switch (node.type) {

      // ── function_definition ──────────────────────────────────────────────────
      case 'function_definition': {
        if (isStaticFunction(node, src)) break;

        // Find the declarator (may be function_declarator directly or wrapped in pointer_declarator)
        const declaratorChild = node.children.find(
          (c) => c.isNamed && (
            c.type === 'function_declarator' ||
            c.type === 'pointer_declarator' ||
            c.type === 'parenthesized_declarator'
          ),
        );
        if (!declaratorChild) break;

        const name = extractDeclaratorName(declaratorChild, src);
        if (!name) break;

        const sig = buildFunctionSignature(node, src);
        const doc = extractDocstring(node);
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: doc ?? `C function: ${name}`,
        });
        break;
      }

      // ── declaration (forward declaration in .h) ──────────────────────────────
      case 'declaration': {
        if (isStaticFunction(node, src)) break;

        // A forward function declaration has a function_declarator somewhere
        const hasFuncDecl = node.children.some(
          (c) => c.isNamed && (
            c.type === 'function_declarator' ||
            findFunctionDeclarator(c) !== null
          ),
        );
        if (!hasFuncDecl) break;

        // Find the declarator child
        const declaratorChild = node.children.find(
          (c) => c.isNamed && (
            c.type === 'function_declarator' ||
            c.type === 'pointer_declarator' ||
            c.type === 'parenthesized_declarator' ||
            c.type === 'init_declarator'
          ),
        );
        if (!declaratorChild) break;

        const name = extractDeclaratorName(declaratorChild, src);
        if (!name) break;

        // Skip if already extracted as function_definition (headers may duplicate)
        if (symbols.some((s) => s.name === name && s.kind === 'function')) break;

        const body = node.children.find((c) => c.type === 'compound_statement');
        const end = body ? body.startIndex : node.endIndex;
        const sig = trunc(src.slice(node.startIndex, end));
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: `C function declaration: ${name}`,
        });
        break;
      }

      // ── type_definition ──────────────────────────────────────────────────────
      case 'type_definition': {
        // Find the inner type specifier
        const typeChild = node.children.find(
          (c) => c.isNamed && (
            c.type === 'struct_specifier' ||
            c.type === 'union_specifier' ||
            c.type === 'enum_specifier' ||
            c.type === 'type_identifier' ||
            c.type === 'primitive_type'
          ),
        );
        if (!typeChild) break;

        const typedefAlias = getTypedefName(node, src);
        if (!typedefAlias) break;

        if (typeChild.type === 'struct_specifier' || typeChild.type === 'union_specifier') {
          // Get the struct/union name: prefer the typedef alias; fall back to the struct tag
          const tagNode = typeChild.children.find((c) => c.type === 'type_identifier');
          const displayName = typedefAlias;
          const sig = buildStructSignature(typeChild, src, displayName);
          symbols.push({
            id: makeId(filePath, displayName, 'struct'),
            name: displayName,
            kind: 'struct',
            filePath,
            startByte: node.startIndex,
            endByte: node.endIndex,
            signature: `typedef ${typeChild.type === 'union_specifier' ? 'union' : 'struct'} ${tagNode ? nodeText(tagNode, src) + ' ' : ''}{ ... } ${displayName}`,
            summary: `C ${typeChild.type === 'union_specifier' ? 'union' : 'struct'}: ${displayName}`,
            frameworkMeta: typeChild.type === 'union_specifier' ? { c_union: true } : undefined,
          });
          break;
        }

        if (typeChild.type === 'enum_specifier') {
          const displayName = typedefAlias;
          const tagNode = typeChild.children.find((c) => c.type === 'type_identifier');
          const sig = buildEnumSignature(typeChild, src, displayName);
          symbols.push({
            id: makeId(filePath, displayName, 'enum'),
            name: displayName,
            kind: 'enum',
            filePath,
            startByte: node.startIndex,
            endByte: node.endIndex,
            signature: sig,
            summary: `C enum: ${displayName}`,
          });
          break;
        }

        // Bare typedef: typedef int MyInt / typedef struct Foo Foo
        const originalType = nodeText(typeChild, src);
        symbols.push({
          id: makeId(filePath, typedefAlias, 'type'),
          name: typedefAlias,
          kind: 'type',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`typedef ${originalType} ${typedefAlias}`),
          summary: `C typedef: ${typedefAlias}`,
        });
        break;
      }

      // ── preproc_def (object-like macro) ─────────────────────────────────────
      case 'preproc_def': {
        // Skip function-like macros (preproc_function_def is a separate node type)
        const nameNode = node.children.find((c) => c.type === 'identifier');
        if (!nameNode) break;
        const name = nodeText(nameNode, src);

        // Skip header guards (no value)
        const valueNode = node.children.find((c) => c.type === 'preproc_arg');
        if (!valueNode) break;
        const value = nodeText(valueNode, src).trim();
        if (!value) break;

        symbols.push({
          id: makeId(filePath, name, 'macro'),
          name,
          kind: 'macro',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`#define ${name} ${value}`),
          summary: `C macro: ${name}`,
        });
        break;
      }

      // ── struct_specifier at top-level without typedef ────────────────────────
      case 'struct_specifier': {
        const tagNode = node.children.find((c) => c.type === 'type_identifier');
        if (!tagNode) break; // anonymous struct without typedef — skip
        const name = nodeText(tagNode, src);
        const sig = buildStructSignature(node, src, name);
        symbols.push({
          id: makeId(filePath, name, 'struct'),
          name,
          kind: 'struct',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: `C struct: ${name}`,
        });
        break;
      }

      // ── enum_specifier at top-level ──────────────────────────────────────────
      case 'enum_specifier': {
        const tagNode = node.children.find((c) => c.type === 'type_identifier');
        if (!tagNode) break; // anonymous enum without typedef — skip
        const name = nodeText(tagNode, src);
        const sig = buildEnumSignature(node, src, name);
        symbols.push({
          id: makeId(filePath, name, 'enum'),
          name,
          kind: 'enum',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: `C enum: ${name}`,
        });
        break;
      }

      default:
        break;
    }
  }

  return symbols;
}

// ─── extractImports ───────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];
  const allNodes = collectTopLevelNodes(tree.rootNode.children);

  for (const node of allNodes) {
    if (node.type !== 'preproc_include') continue;

    // The path child is either `string_literal` ("local.h") or `system_lib_string` (<stdio.h>)
    const pathNode = node.children.find(
      (c) => c.type === 'string_literal' || c.type === 'system_lib_string',
    );
    if (!pathNode) continue;

    const raw = nodeText(pathNode, src);
    const isSystem = pathNode.type === 'system_lib_string';

    // Strip the surrounding delimiters
    const specifier = raw.slice(1, -1);

    let resolvedPath: string | null = null;
    if (!isSystem) {
      // Local include — keep as-is (relative resolution happens in graph-builder)
      resolvedPath = specifier;
    }

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath,
      importedNames: [],
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const cHandler: LanguageHandler = {
  extensions: () => ['.c', '.h'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-c.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
