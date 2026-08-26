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
 * Strip Scaladoc markers from a block comment.
 * Handles `/** ... * /` preceding declarations.
 */
function stripScaladoc(text: string): string {
  // Remove /** and */ delimiters
  const inner = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  return inner
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/@\w+[^@]*/g, '') // strip @param, @return etc. tags
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Find the Scaladoc comment (`/** ... * /`) that immediately precedes `node`
 * in the source. We walk `previousNamedSibling` and look for a `comment` node
 * whose text starts with `/**`.
 */
export function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'block_comment') {
      const text = prev.text.trim();
      if (text.startsWith('/**')) {
        return stripScaladoc(text) || null;
      }
      // Regular block comment — stop looking
      return null;
    }
    if (prev.type === 'line_comment') {
      // Not a Scaladoc comment — stop looking
      return null;
    }
    // Skip annotations
    if (prev.type === 'annotation') {
      prev = prev.previousNamedSibling;
      continue;
    }
    break;
  }
  return null;
}

// ─── Modifier helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if the node has a `private` or `protected` access modifier
 * without a package qualifier (i.e. `private[pkg]` still qualifies as visible).
 */
function isPrivateOrProtected(node: SyntaxNode): boolean {
  const modifiers = node.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return false;
  for (const child of modifiers.children) {
    if (child.type === 'access_modifier') {
      const kw = child.children.find(
        (c) => c.type !== 'access_qualifier',
      );
      // If there's an access_qualifier like [pkg] — not fully private, skip
      const hasQualifier = child.children.some((c) => c.type === 'access_qualifier');
      if (!hasQualifier) return true;
    }
  }
  return false;
}

/**
 * Returns true if the node text contains "case" before the "class"/"object" keyword,
 * indicating a case class or case object.
 */
function isCaseNode(node: SyntaxNode): boolean {
  // The "case" keyword appears as a non-named child before "class"/"object"
  for (const child of node.children) {
    if (!child.isNamed && child.text === 'case') return true;
    // Stop once we hit the name (an identifier/type_identifier)
    if (child.type === 'identifier' || child.type === 'type_identifier') break;
  }
  return false;
}

// ─── Signature builders ───────────────────────────────────────────────────────

function classSignature(node: SyntaxNode, prefix: string): string {
  const name = node.childForFieldName?.('name')?.text ?? getName(node);
  const typeParams = node.childForFieldName?.('type_parameters')?.text ?? '';
  const classParams = node.children
    .filter((c) => c.type === 'class_parameters')
    .map((c) => c.text)
    .join('');
  const extend = node.childForFieldName?.('extend')?.text ?? '';
  let sig = `${prefix} ${name}${typeParams}${classParams}`;
  if (extend) sig += ` ${extend}`;
  return trunc(sig);
}

function functionSignature(node: SyntaxNode): string {
  const name = node.childForFieldName?.('name')?.text ?? getName(node);
  // Collect all parameter lists: type_parameters and parameters
  const params = node.children
    .filter((c) => c.type === 'parameters' || c.type === 'type_parameters')
    .map((c) => c.text)
    .join('');
  const returnType = node.childForFieldName?.('return_type')?.text;
  let sig = `def ${name}${params}`;
  if (returnType) sig += `: ${returnType}`;
  return trunc(sig);
}

// ─── Name extraction ──────────────────────────────────────────────────────────

/**
 * Walk children to find the first `identifier` or `type_identifier` named child.
 */
function getName(node: SyntaxNode): string {
  for (const child of node.children) {
    if (child.isNamed && (child.type === 'identifier' || child.type === 'type_identifier')) {
      return child.text;
    }
  }
  return '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

const TOP_LEVEL_DEF_TYPES = new Set([
  'class_definition',
  'trait_definition',
  'object_definition',
  'function_definition',
  'function_declaration',
  'val_definition',
  'type_definition',
  'enum_definition',
  'given_definition',
  'extension_definition',
]);

/**
 * Determine whether `node` is inside a class/trait/object body (i.e. a method)
 * versus at the top level or inside an object body only.
 * Returns the kind of the enclosing definition, or null if top-level.
 */
function getEnclosingKind(node: SyntaxNode): string | null {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'template_body') {
      const owner = parent.parent;
      if (owner) return owner.type;
      return null;
    }
    parent = parent.parent;
  }
  return null;
}

/**
 * Recursively extract symbols from a tree, visiting class/object/trait bodies.
 */
function walkNodes(
  nodes: SyntaxNode[],
  filePath: string,
  symbols: SymbolRecord[],
  depth: number = 0,
): void {
  for (const node of nodes) {
    if (!node.isNamed) continue;

    switch (node.type) {
      case 'class_definition': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        const caseClass = isCaseNode(node);
        const sig = classSignature(node, caseClass ? 'case class' : 'class');
        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? '',
          ...(caseClass ? { frameworkMeta: { scala_case_class: true } } : {}),
        });
        // Recurse into body
        const body = node.children.find((c) => c.type === 'template_body');
        if (body) walkNodes(body.children, filePath, symbols, depth + 1);
        break;
      }

      case 'trait_definition': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        symbols.push({
          id: makeId(filePath, name, 'interface'),
          name,
          kind: 'interface',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: classSignature(node, 'trait'),
          summary: extractDocstring(node) ?? '',
        });
        const body = node.children.find((c) => c.type === 'template_body');
        if (body) walkNodes(body.children, filePath, symbols, depth + 1);
        break;
      }

      case 'object_definition': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        const caseObj = isCaseNode(node);
        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`${caseObj ? 'case ' : ''}object ${name}`),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { scala_object: true, ...(caseObj ? { scala_case_object: true } : {}) },
        });
        const body = node.children.find((c) => c.type === 'template_body');
        if (body) walkNodes(body.children, filePath, symbols, depth + 1);
        break;
      }

      case 'function_definition':
      case 'function_declaration': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        const enclosing = getEnclosingKind(node);
        // method if inside class/trait body, function otherwise
        const kind: SymbolKind =
          enclosing === 'class_definition' || enclosing === 'trait_definition'
            ? 'method'
            : 'function';
        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: functionSignature(node),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      case 'val_definition': {
        if (isPrivateOrProtected(node)) continue;
        // Only top-level or object-level vals
        const enclosing = getEnclosingKind(node);
        if (enclosing === 'class_definition' || enclosing === 'trait_definition') continue;
        const patternNode = node.childForFieldName?.('pattern') ??
          node.children.find((c) => c.isNamed && c.type !== 'modifiers');
        const name = patternNode?.text ?? '';
        if (!name) continue;
        const typeNode = node.childForFieldName?.('type');
        const sig = typeNode ? `val ${name}: ${typeNode.text}` : `val ${name}`;
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(sig),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      case 'type_definition': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        symbols.push({
          id: makeId(filePath, name, 'type'),
          name,
          kind: 'type',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(node.text.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      case 'enum_definition': {
        if (isPrivateOrProtected(node)) continue;
        const name = getName(node);
        if (!name) continue;
        symbols.push({
          id: makeId(filePath, name, 'enum'),
          name,
          kind: 'enum',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`enum ${name}`),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      case 'given_definition': {
        const name = getName(node) || 'anonymous_given';
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(node.text.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { scala_given: true },
        });
        break;
      }

      case 'extension_definition': {
        // Extension has no name in grammar — use text up to first brace/newline
        const extName = `extension_${node.startIndex}`;
        symbols.push({
          id: makeId(filePath, extName, 'class'),
          name: extName,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(node.text.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { scala_extension: true },
        });
        // Recurse into extension body
        for (const child of node.children) {
          if (child.isNamed && TOP_LEVEL_DEF_TYPES.has(child.type)) {
            walkNodes([child], filePath, symbols, depth + 1);
          }
        }
        break;
      }

      case 'package_clause':
      case 'package_object': {
        // Recurse into package body
        for (const child of node.children) {
          if (child.type === 'template_body') {
            walkNodes(child.children, filePath, symbols, depth + 1);
          } else if (child.isNamed) {
            walkNodes([child], filePath, symbols, depth + 1);
          }
        }
        break;
      }

      default:
        // For container nodes at depth 0 (e.g. top-level braces/blocks), recurse
        if (depth === 0 && node.children.length > 0) {
          walkNodes(node.children, filePath, symbols, depth);
        }
        break;
    }
  }
}

function extractSymbols(tree: Tree, _source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  walkNodes(tree.rootNode.children, filePath, symbols, 0);
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Collect import declarations from the tree.
 * Handles: `import scala.collection.mutable._`
 * and Scala renaming syntax: `import scala.collection.{ Map, Set => MutableSet }`
 */
function collectImports(nodes: SyntaxNode[], imports: ImportRecord[]): void {
  for (const node of nodes) {
    if (!node.isNamed) continue;

    if (node.type === 'import_declaration') {
      const specifier = node.text
        .replace(/^import\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null,
        importedNames: extractImportedNames(node),
        isTypeOnly: false,
      });
      continue;
    }

    // Recurse into class/object/trait/package bodies
    if (
      node.type === 'class_definition' ||
      node.type === 'object_definition' ||
      node.type === 'trait_definition' ||
      node.type === 'package_clause' ||
      node.type === 'package_object'
    ) {
      const body = node.children.find((c) => c.type === 'template_body');
      if (body) collectImports(body.children, imports);
      // Also recurse into package content nodes
      for (const child of node.children) {
        if (child.type === 'package_clause' || child.type === 'package_object') {
          collectImports([child], imports);
        }
      }
    }
  }
}

/**
 * Extract imported names from an import_declaration node, handling Scala's
 * renaming syntax: `{ A, B => C }`.
 */
function extractImportedNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  // Look for import_selectors node (may be named differently in grammar)
  const selectorsNode = node.children.find(
    (c) =>
      c.type === 'import_selectors' ||
      c.type === 'namespace_selectors' ||
      c.text.startsWith('{'),
  );
  if (!selectorsNode) return names;

  for (const child of selectorsNode.children) {
    if (!child.isNamed) continue;
    // identifier is the original name
    if (child.type === 'identifier' || child.type === 'operator_identifier') {
      names.push(child.text);
    }
    // import_selector: `A => B` or `A => _` (wildcard = hiding)
    if (child.type === 'renamed_identifier' || child.type === 'import_selector') {
      const orig = child.children.find(
        (c) => c.type === 'identifier' || c.type === 'operator_identifier',
      );
      if (orig) names.push(orig.text);
    }
  }
  return names;
}

function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  collectImports(tree.rootNode.children, imports);
  return imports;
}

// ─── Package extraction ───────────────────────────────────────────────────────

/**
 * Declared package of the file. Scala 2 chained clauses
 * (`package a.b` + `package c` on separate lines) concatenate to "a.b.c".
 * The braces form (`package a { ... }`) contributes only its own segment.
 */
function extractPackage(tree: Tree | null, _source: Buffer): string | null {
  if (!tree) return null;
  const parts: string[] = [];
  for (const node of tree.rootNode.children) {
    if (node.type !== 'package_clause') continue;
    const ident = node.children.find(
      (c) => c.type === 'package_identifier' || c.type === 'stable_identifier' || c.type === 'identifier',
    );
    if (ident) {
      const text = ident.text.trim();
      if (text.length > 0) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('.') : null;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const scalaHandler: LanguageHandler = {
  extensions: () => ['.scala', '.sc'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-scala.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
  extractPackage,
};
