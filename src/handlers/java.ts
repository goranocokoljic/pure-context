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

// ─── Text extraction ──────────────────────────────────────────────────────────

/** Extract text from a node using JS character indices (not byte offsets). */
function nodeText(node: SyntaxNode, sourceStr: string): string {
  return sourceStr.slice(node.startIndex, node.endIndex);
}

/** Find the first child with one of the given types and return its text. */
function childText(node: SyntaxNode, sourceStr: string, ...types: string[]): string {
  const child = node.children.find((c) => types.includes(c.type));
  return child ? nodeText(child, sourceStr) : '';
}

// ─── Visibility ───────────────────────────────────────────────────────────────

/**
 * Returns true if the node has `public` or `protected` in its modifiers child.
 */
function isPublicOrProtected(node: SyntaxNode): boolean {
  const modifiers = node.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return false;
  return modifiers.children.some(
    (c) => c.type === 'public' || c.type === 'protected',
  );
}

/**
 * Returns true if the method is visible (public, protected, or package-private).
 * Package-private methods have no modifiers at all. Private methods are excluded.
 * Used for method_declaration only — class/field extraction stays stricter.
 */
function isVisibleMethod(node: SyntaxNode): boolean {
  const modifiers = node.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return true; // no modifiers = package-private = accept
  return modifiers.children.some(
    (c) => c.type === 'public' || c.type === 'protected',
  );
}

/**
 * Returns true if the modifiers include both `static` and `final`.
 */
function isStaticFinal(node: SyntaxNode): boolean {
  const modifiers = node.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return false;
  const mods = modifiers.children.map((c) => c.type);
  return mods.includes('static') && mods.includes('final');
}

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Build a one-line signature, stopping before the opening brace of the body.
 */
function buildSignature(node: SyntaxNode, sourceStr: string): string {
  const body = node.children.find(
    (c) =>
      c.type === 'class_body' ||
      c.type === 'interface_body' ||
      c.type === 'enum_body' ||
      c.type === 'annotation_type_body' ||
      c.type === 'block',
  );
  const endIdx = body ? body.startIndex : node.endIndex;
  return sourceStr
    .slice(node.startIndex, endIdx)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Extract a Javadoc comment (starting with slash-star-star) immediately preceding the declaration.
 * Returns the first sentence (up to `.` or 200 chars).
 */
function extractDocstringWithSource(node: SyntaxNode, sourceStr: string): string | null {
  const prev = node.previousNamedSibling;
  if (!prev || prev.type !== 'block_comment') return null;

  const raw = nodeText(prev, sourceStr);
  if (!raw.startsWith('/**')) return null;

  // Strip the Javadoc markers and leading " * " from each line
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!inner) return null;

  const match = inner.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1].trim() : inner).slice(0, 200)) || null;
}

/** Interface-compatible wrapper — multi-byte chars require extractDocstringWithSource. */
function extractDocstring(_node: SyntaxNode): string | null {
  return null;
}

// ─── Class member extraction ──────────────────────────────────────────────────

function extractClassMembers(
  classNode: SyntaxNode,
  className: string,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const body = classNode.children.find(
    (c) =>
      c.type === 'class_body' ||
      c.type === 'interface_body' ||
      c.type === 'enum_body',
  );
  if (!body) return;

  for (const member of body.children) {
    // ── method_declaration ────────────────────────────────────────────────
    if (member.type === 'method_declaration') {
      if (!isVisibleMethod(member)) continue;
      const methodName = childText(member, sourceStr, 'identifier');
      if (!methodName) continue;
      // Use qualified name for ID hashing to guarantee uniqueness within a file
      // (two different classes in the same file can have a method with the same bare name).
      // The name field stores only the bare method name for search matching.
      const qualifiedName = `${className}.${methodName}`;
      const rawSig = buildSignature(member, sourceStr);
      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: methodName,      // bare name — search matches on this
        kind: 'method',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: `${qualifiedName}: ${rawSig}`.slice(0, 120),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── constructor_declaration ───────────────────────────────────────────
    if (member.type === 'constructor_declaration') {
      if (!isPublicOrProtected(member)) continue;
      const ctorName = childText(member, sourceStr, 'identifier');
      if (!ctorName) continue;
      // Constructors are named after the class — use bare class name for search
      // and the qualified "ClassName.ClassName" for ID uniqueness.
      const qualifiedName = `${className}.${ctorName}`;
      const rawSig = buildSignature(member, sourceStr);
      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: ctorName,        // bare class name — e.g. "User" not "User.User"
        kind: 'method',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: `${qualifiedName}: ${rawSig}`.slice(0, 120),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── field_declaration with static final → const ───────────────────────
    if (member.type === 'field_declaration') {
      if (!isPublicOrProtected(member)) continue;
      if (!isStaticFinal(member)) continue;
      const declarator = member.children.find((c) => c.type === 'variable_declarator');
      const name = declarator
        ? childText(declarator, sourceStr, 'identifier')
        : '';
      if (!name) continue;
      const qualifiedName = `${className}.${name}`;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'const'),
        name: qualifiedName,
        kind: 'const',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: sourceStr
          .slice(member.startIndex, member.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── public inner class (static or non-static) ────────────────────────
    if (member.type === 'class_declaration') {
      if (!isPublicOrProtected(member)) continue;
      // Non-static inner classes are valid navigable symbols (ViewHolder, Builder, etc.)
      const name = childText(member, sourceStr, 'identifier');
      if (!name) continue;
      const innerClassName = `${className}.${name}`;
      symbols.push({
        id: makeId(filePath, innerClassName, 'class'),
        name: innerClassName,
        kind: 'class',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: buildSignature(member, sourceStr),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      // Recurse to extract methods of the inner class
      extractClassMembers(member, innerClassName, sourceStr, filePath, symbols);
    }
  }
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const sourceStr = source.toString('utf8');

  for (const node of tree.rootNode.children) {
    // ── class_declaration ──────────────────────────────────────────────────
    if (node.type === 'class_declaration') {
      if (!isPublicOrProtected(node)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      extractClassMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── interface_declaration ──────────────────────────────────────────────
    if (node.type === 'interface_declaration') {
      if (!isPublicOrProtected(node)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'interface'),
        name,
        kind: 'interface',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      extractClassMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── enum_declaration ───────────────────────────────────────────────────
    if (node.type === 'enum_declaration') {
      if (!isPublicOrProtected(node)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'enum'),
        name,
        kind: 'enum',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      extractClassMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── annotation_type_declaration ────────────────────────────────────────
    if (node.type === 'annotation_type_declaration') {
      if (!isPublicOrProtected(node)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const sourceStr = source.toString('utf8');

  for (const node of tree.rootNode.children) {
    if (node.type !== 'import_declaration') continue;

    // Check for static import: `import static foo.Bar.METHOD`
    const isStatic = node.children.some((c) => c.type === 'static');

    const pathNode = node.children.find(
      (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
    );
    if (!pathNode) continue;

    const fullPath = nodeText(pathNode, sourceStr);

    // Detect wildcard: tree-sitter-java puts `.*` as separate anonymous children,
    // not inside the scoped_identifier — check for a `*` sibling node.
    const isWildcard =
      !isStatic &&
      node.children.some((c) => c.type === '*' || nodeText(c, sourceStr) === '*');

    if (isStatic) {
      const lastDot = fullPath.lastIndexOf('.');
      if (lastDot > 0) {
        const specifier = fullPath.slice(0, lastDot);
        const methodName = fullPath.slice(lastDot + 1);
        imports.push({
          sourceFile: '',
          specifier,
          resolvedPath: null,
          importedNames: [methodName],
          isTypeOnly: false,
        });
      } else {
        imports.push({
          sourceFile: '',
          specifier: fullPath,
          resolvedPath: null,
          importedNames: [],
          isTypeOnly: false,
        });
      }
    } else if (isWildcard) {
      imports.push({
        sourceFile: '',
        specifier: fullPath,
        resolvedPath: null,
        importedNames: ['*'],
        isTypeOnly: false,
      });
    } else {
      const lastDot = fullPath.lastIndexOf('.');
      const simpleName = lastDot >= 0 ? fullPath.slice(lastDot + 1) : fullPath;
      imports.push({
        sourceFile: '',
        specifier: fullPath,
        resolvedPath: null,
        importedNames: [simpleName],
        isTypeOnly: false,
      });
    }
  }

  return imports;
}

// ─── Package extraction ───────────────────────────────────────────────────────

/** Declared package: `package com.example.foo;` → "com.example.foo". */
function extractPackage(tree: Tree | null, source: Buffer): string | null {
  if (!tree) return null;
  const sourceStr = source.toString('utf8');
  for (const node of tree.rootNode.children) {
    if (node.type !== 'package_declaration') continue;
    const pathNode = node.children.find(
      (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
    );
    const pkg = pathNode ? nodeText(pathNode, sourceStr).trim() : '';
    return pkg.length > 0 ? pkg : null;
  }
  return null;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const javaHandler: LanguageHandler = {
  extensions: () => ['.java'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-java.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,

  extractPackage,
};
