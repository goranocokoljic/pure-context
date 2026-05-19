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

/**
 * Extract text for a node using character indices against the source string.
 * web-tree-sitter's startIndex/endIndex are JavaScript char indices, NOT byte
 * offsets — using them with Buffer.toString('utf8', start, end) silently
 * truncates multi-byte characters. Always convert the buffer to a JS string
 * first and slice with character indices.
 */
function nodeText(node: SyntaxNode, sourceStr: string): string {
  return sourceStr.slice(node.startIndex, node.endIndex);
}

/** Find the first child of the given type and return its text. */
function childText(node: SyntaxNode, sourceStr: string, ...types: string[]): string {
  const child = node.children.find((c) => types.includes(c.type));
  return child ? nodeText(child, sourceStr) : '';
}

// ─── Visibility ───────────────────────────────────────────────────────────────

/** Returns true if the node has a `pub` visibility_modifier child. */
function isPublic(node: SyntaxNode, sourceStr: string): boolean {
  return node.children.some(
    (c) => c.type === 'visibility_modifier' && nodeText(c, sourceStr).startsWith('pub'),
  );
}

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Build a compact one-line signature from a node, stopping before the body block.
 * Collapses whitespace, caps at 120 chars.
 */
function buildSignature(node: SyntaxNode, sourceStr: string): string {
  const body = node.children.find(
    (c) =>
      c.type === 'block' ||
      c.type === 'declaration_list' ||
      c.type === 'field_declaration_list' ||
      c.type === 'enum_variant_list' ||
      c.type === 'trait_item',
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
 * Extract Rust `///` doc comments that immediately precede the declaration.
 * Walks backwards through named siblings collecting `line_comment` nodes
 * whose text starts with `///`.
 */
function extractDocstringWithSource(node: SyntaxNode, sourceStr: string): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;

  while (prev !== null) {
    if (prev.type !== 'line_comment') break;
    const text = nodeText(prev, sourceStr);
    if (!text.startsWith('///')) break;
    lines.unshift(text.replace(/^\/\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }

  if (lines.length === 0) return null;
  const text = lines.join(' ').trim();
  if (!text) return null;

  const match = text.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1].trim() : text).slice(0, 200)) || null;
}

/** Interface-compatible wrapper — used externally; cannot access source bytes. */
function extractDocstring(node: SyntaxNode): string | null {
  // node.text is available for ASCII files; multi-byte char files should use
  // the internal extractDocstringWithSource variant called from extractSymbols.
  return null;
}

// ─── Impl type resolution ─────────────────────────────────────────────────────

/** Recursively find the first type_identifier text in a type node. */
function extractTypeName(node: SyntaxNode, sourceStr: string): string {
  if (node.type === 'type_identifier') return nodeText(node, sourceStr);
  if (node.type === 'scoped_type_identifier') {
    // e.g. foo::Bar — use the last type_identifier segment
    const last = [...node.children].reverse().find((c) => c.type === 'type_identifier');
    return last ? nodeText(last, sourceStr) : '';
  }
  if (node.type === 'generic_type') {
    // e.g. Vec<T> — use the base type
    const base = node.children.find(
      (c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier',
    );
    return base ? extractTypeName(base, sourceStr) : '';
  }
  return '';
}

/**
 * Extract the name of the type being implemented from an `impl_item` node.
 * For `impl Trait for Type { }`, returns `Type`.
 * For `impl Type { }`, returns `Type`.
 */
function extractImplTypeName(node: SyntaxNode, sourceStr: string): string {
  // If there's a `for` keyword child, the implementing type comes after it
  const forIdx = node.children.findIndex((c) => c.type === 'for');
  if (forIdx >= 0) {
    for (let i = forIdx + 1; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === 'declaration_list') break;
      const name = extractTypeName(child, sourceStr);
      if (name) return name;
    }
  }

  // No `for` — the implementing type is the first type-like child after `impl`
  let pastImpl = false;
  for (const child of node.children) {
    if (child.type === 'impl') { pastImpl = true; continue; }
    if (!pastImpl) continue;
    if (child.type === 'type_parameters') continue;
    if (child.type === 'visibility_modifier') continue;
    if (child.type === 'declaration_list') break;
    if (child.type === 'where_clause') break;
    const name = extractTypeName(child, sourceStr);
    if (name) return name;
  }

  return '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const sourceStr = source.toString('utf8');

  for (const node of tree.rootNode.children) {
    // ── function_item ──────────────────────────────────────────────────────
    if (node.type === 'function_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      continue;
    }

    // ── struct_item ────────────────────────────────────────────────────────
    if (node.type === 'struct_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'type_identifier');
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
      continue;
    }

    // ── enum_item ──────────────────────────────────────────────────────────
    if (node.type === 'enum_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'type_identifier');
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
      continue;
    }

    // ── trait_item ─────────────────────────────────────────────────────────
    if (node.type === 'trait_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'type_identifier');
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
      continue;
    }

    // ── const_item ─────────────────────────────────────────────────────────
    if (node.type === 'const_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sourceStr
          .slice(node.startIndex, node.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      continue;
    }

    // ── type_item (type alias) ─────────────────────────────────────────────
    if (node.type === 'type_item') {
      if (!isPublic(node, sourceStr)) continue;
      const name = childText(node, sourceStr, 'type_identifier');
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sourceStr
          .slice(node.startIndex, node.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        summary: extractDocstringWithSource(node, sourceStr) ?? '',
      });
      continue;
    }

    // ── impl_item — extract methods ────────────────────────────────────────
    if (node.type === 'impl_item') {
      const typeName = extractImplTypeName(node, sourceStr);
      if (!typeName) continue;

      const body = node.children.find((c) => c.type === 'declaration_list');
      if (!body) continue;

      for (const member of body.children) {
        if (member.type !== 'function_item') continue;
        if (!isPublic(member, sourceStr)) continue;
        const methodName = childText(member, sourceStr, 'identifier');
        if (!methodName) continue;
        // Use qualified name for ID hashing to guarantee uniqueness within a file
        // (two different impl types can have a method with the same bare name).
        // The name field stores only the bare method name for search matching.
        const qualifiedName = `${typeName}.${methodName}`;
        const methodSig = buildSignature(member, sourceStr);
        const sigWithContext = `${typeName}::${methodSig}`.slice(0, 120);
        symbols.push({
          id: makeId(filePath, qualifiedName, 'method'),
          name: methodName,     // bare name — search matches on this
          kind: 'method',
          filePath,
          startByte: member.startIndex,
          endByte: member.endIndex,
          signature: sigWithContext,
          summary: extractDocstringWithSource(member, sourceStr) ?? '',
        });
      }
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractUseListNames(node: SyntaxNode, sourceStr: string): string[] {
  if (node.type !== 'use_list') return [];
  const names: string[] = [];
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      names.push(nodeText(child, sourceStr));
    } else if (child.type === 'use_as_clause') {
      const orig = child.children.find(
        (c) => c.type === 'identifier' || c.type === 'type_identifier',
      );
      if (orig) names.push(nodeText(orig, sourceStr));
    } else if (child.type === 'self') {
      names.push('self');
    }
  }
  return names;
}

function parseUseTree(
  node: SyntaxNode,
  sourceStr: string,
): { specifier: string; importedNames: string[] } {
  if (node.type === 'scoped_use_list') {
    const pathParts: string[] = [];
    const list = node.children.find((c) => c.type === 'use_list');
    for (const child of node.children) {
      if (
        child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'scoped_identifier'
      ) {
        pathParts.push(nodeText(child, sourceStr));
      }
    }
    const specifier = pathParts.join('::');
    const importedNames = list ? extractUseListNames(list, sourceStr) : [];
    return { specifier, importedNames };
  }

  if (node.type === 'use_wildcard') {
    const base = node.children.find(
      (c) => c.type === 'identifier' || c.type === 'scoped_identifier',
    );
    const specifier = base
      ? nodeText(base, sourceStr)
      : nodeText(node, sourceStr).replace(/\s*::\s*\*$/, '');
    return { specifier, importedNames: ['*'] };
  }

  if (node.type === 'use_as_clause') {
    const orig = node.children.find(
      (c) => c.type === 'identifier' || c.type === 'scoped_identifier',
    );
    const name = node.children.find((c) => c.type === 'identifier');
    return {
      specifier: orig ? nodeText(orig, sourceStr) : '',
      importedNames: name ? [nodeText(name, sourceStr)] : [],
    };
  }

  if (node.type === 'scoped_identifier') {
    const lastIdent = [...node.children]
      .reverse()
      .find((c) => c.type === 'identifier' || c.type === 'type_identifier');
    return {
      specifier: nodeText(node, sourceStr),
      importedNames: lastIdent ? [nodeText(lastIdent, sourceStr)] : [],
    };
  }

  if (node.type === 'identifier' || node.type === 'type_identifier') {
    const text = nodeText(node, sourceStr);
    return { specifier: text, importedNames: [text] };
  }

  if (node.type === 'use_list') {
    return { specifier: '', importedNames: extractUseListNames(node, sourceStr) };
  }

  return { specifier: nodeText(node, sourceStr), importedNames: [] };
}

function buildUseSpecifier(
  node: SyntaxNode,
  sourceStr: string,
): { specifier: string; importedNames: string[] } {
  const useTree = node.children.find(
    (c) =>
      c.type !== 'use' &&
      c.type !== 'visibility_modifier' &&
      c.type !== ';' &&
      c.type !== 'pub',
  );
  if (!useTree) return { specifier: '', importedNames: [] };
  return parseUseTree(useTree, sourceStr);
}

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const sourceStr = source.toString('utf8');

  for (const node of tree.rootNode.children) {
    // ── use_declaration ────────────────────────────────────────────────────
    if (node.type === 'use_declaration') {
      const { specifier, importedNames } = buildUseSpecifier(node, sourceStr);
      if (!specifier && importedNames.length === 0) continue;
      imports.push({
        sourceFile: '',
        specifier: specifier || importedNames.join(', '),
        resolvedPath: null,
        importedNames,
        isTypeOnly: false,
      });
      continue;
    }

    // ── extern_crate_declaration ───────────────────────────────────────────
    if (node.type === 'extern_crate_declaration') {
      const name = childText(node, sourceStr, 'identifier');
      if (!name) continue;
      imports.push({
        sourceFile: '',
        specifier: name,
        resolvedPath: null,
        importedNames: [],
        isTypeOnly: false,
      });
      continue;
    }
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const rustHandler: LanguageHandler = {
  extensions: () => ['.rs'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-rust.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
