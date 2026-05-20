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

/**
 * Extract the method name from a method_declaration node.
 * The method name is the identifier immediately before the parameter_list.
 * Using findLast on the slice before parameter_list handles user-defined return
 * types (e.g. `Entity GetById(...)`) where the return type is also an identifier.
 */
function methodName(node: SyntaxNode, sourceStr: string): string {
  const paramList = node.children.find((c) => c.type === 'parameter_list');
  const paramIdx = paramList ? node.children.indexOf(paramList) : -1;
  const candidates = paramIdx > 0 ? node.children.slice(0, paramIdx) : node.children;
  const nameNode = candidates.findLast((c) => c.type === 'identifier');
  return nameNode ? nodeText(nameNode, sourceStr) : '';
}

// ─── Visibility ───────────────────────────────────────────────────────────────

/**
 * Returns true if the node has `public` or `protected` among its direct children.
 * C# modifiers appear as direct keyword children.
 */
function isPublicOrProtected(node: SyntaxNode, sourceStr: string): boolean {
  for (const child of node.children) {
    if (child.type === 'modifier') {
      const t = nodeText(child, sourceStr);
      if (t === 'public' || t === 'protected') return true;
    }
    // Some grammar versions emit keyword nodes directly
    if (child.type === 'public' || child.type === 'protected') return true;
  }
  return false;
}

/**
 * Returns true if the node has `const` or (`static` + `readonly`) modifiers.
 */
function isConstOrStaticReadonly(node: SyntaxNode, sourceStr: string): boolean {
  const modTexts = node.children
    .filter((c) => c.type === 'modifier')
    .map((c) => nodeText(c, sourceStr));
  if (modTexts.includes('const')) return true;
  if (modTexts.includes('static') && modTexts.includes('readonly')) return true;
  return false;
}

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Build a one-line signature, stopping before the body block.
 */
function buildSignature(node: SyntaxNode, sourceStr: string): string {
  const body = node.children.find(
    (c) =>
      c.type === 'declaration_list' ||
      c.type === 'block' ||
      c.type === 'enum_member_declaration_list' ||
      c.type === 'accessor_list',
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
 * Extract C# XML doc comments (/// lines) immediately preceding the node.
 * Returns the text content of the summary element, or raw stripped text.
 */
function extractDocstringWithSource(node: SyntaxNode, sourceStr: string): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;

  while (
    prev !== null &&
    (prev.type === 'single_line_doc_comment' ||
      (prev.type === 'comment' && nodeText(prev, sourceStr).startsWith('///')))
  ) {
    lines.unshift(nodeText(prev, sourceStr).replace(/^\/\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }

  if (lines.length === 0) return null;

  const raw = lines.join(' ').trim();
  if (!raw) return null;

  // Extract <summary> content if present
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    const text = summaryMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const match = text.match(/^([^.!?]*[.!?]?)/);
    return ((match ? match[1].trim() : text).slice(0, 200)) || null;
  }

  // No XML — return raw text after stripping any remaining XML tags
  const cleaned = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1].trim() : cleaned).slice(0, 200)) || null;
}

/** Interface-compatible wrapper — multi-byte chars require extractDocstringWithSource. */
function extractDocstring(_node: SyntaxNode): string | null {
  return null;
}

// ─── Member extraction ────────────────────────────────────────────────────────

const MEMBER_CONTAINER_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
]);

function extractMembers(
  typeNode: SyntaxNode,
  typeName: string,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const body = typeNode.children.find((c) => c.type === 'declaration_list');
  if (!body) return;

  // Interface members are implicitly public in C# — they carry no explicit modifier.
  // Skip the visibility check when the container is an interface.
  const isInterface = typeNode.type === 'interface_declaration';

  for (const member of body.children) {
    if (!isInterface && !isPublicOrProtected(member, sourceStr)) continue;

    // ── method_declaration ───────────────────────────────────────────────
    if (member.type === 'method_declaration') {
      const name = methodName(member, sourceStr);
      if (!name) continue;
      const qualifiedName = `${typeName}.${name}`;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: buildSignature(member, sourceStr),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── constructor_declaration ──────────────────────────────────────────
    if (member.type === 'constructor_declaration') {
      const name = childText(member, sourceStr, 'identifier');
      if (!name) continue;
      const qualifiedName = `${typeName}.${name}`;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: buildSignature(member, sourceStr),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── property_declaration ─────────────────────────────────────────────
    if (member.type === 'property_declaration') {
      const name = childText(member, sourceStr, 'identifier');
      if (!name) continue;
      const qualifiedName = `${typeName}.${name}`;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'const'),
        name: qualifiedName,
        kind: 'const',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: buildSignature(member, sourceStr),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── event_field_declaration ──────────────────────────────────────────
    // event EventHandler Clicked; → variable_declaration → variable_declarator → identifier
    if (member.type === 'event_field_declaration') {
      const varDecl = member.children.find((c) => c.type === 'variable_declaration');
      const declarator = varDecl?.children.find((c) => c.type === 'variable_declarator');
      const name = declarator ? childText(declarator, sourceStr, 'identifier') : '';
      if (!name) continue;
      const qualifiedName = `${typeName}.${name}`;
      symbols.push({
        id: makeId(filePath, qualifiedName, 'property'),
        name: qualifiedName,
        kind: 'property',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: sourceStr.slice(member.startIndex, member.endIndex).replace(/\s+/g, ' ').trim().slice(0, 120),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      continue;
    }

    // ── field_declaration with const or static readonly ──────────────────
    if (member.type === 'field_declaration') {
      if (!isConstOrStaticReadonly(member, sourceStr)) continue;
      // C# field_declaration → variable_declaration → variable_declarator → identifier
      const varDecl = member.children.find((c) => c.type === 'variable_declaration');
      const declarator = varDecl?.children.find((c) => c.type === 'variable_declarator');
      const name = declarator ? childText(declarator, sourceStr, 'identifier') : '';
      if (!name) continue;
      const qualifiedName = `${typeName}.${name}`;
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

    // ── nested type (recurse) ────────────────────────────────────────────
    if (MEMBER_CONTAINER_TYPES.has(member.type)) {
      const name = childText(member, sourceStr, 'identifier');
      if (!name) continue;
      const nestedName = `${typeName}.${name}`;
      symbols.push({
        id: makeId(filePath, nestedName, 'class'),
        name: nestedName,
        kind: 'class',
        filePath,
        startByte: member.startIndex,
        endByte: member.endIndex,
        signature: buildSignature(member, sourceStr),
        summary: extractDocstringWithSource(member, sourceStr) ?? '',
      });
      extractMembers(member, nestedName, sourceStr, filePath, symbols);
    }
  }
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function walkDeclarations(
  nodes: SyntaxNode[],
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const node of nodes) {
    // ── namespace — recurse into body ─────────────────────────────────────
    if (
      node.type === 'namespace_declaration' ||
      node.type === 'file_scoped_namespace_declaration'
    ) {
      const body = node.children.find((c) => c.type === 'declaration_list');
      if (body) walkDeclarations(body.children, sourceStr, filePath, symbols);
      continue;
    }

    if (!isPublicOrProtected(node, sourceStr)) continue;

    const name = childText(node, sourceStr, 'identifier');
    if (!name) continue;

    // ── class_declaration ──────────────────────────────────────────────────
    if (node.type === 'class_declaration') {
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
      extractMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── interface_declaration ──────────────────────────────────────────────
    if (node.type === 'interface_declaration') {
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
      extractMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── enum_declaration ───────────────────────────────────────────────────
    if (node.type === 'enum_declaration') {
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

    // ── struct_declaration → kind 'class' ──────────────────────────────────
    if (node.type === 'struct_declaration') {
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
      extractMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }

    // ── record_declaration → kind 'class' ─────────────────────────────────
    if (node.type === 'record_declaration') {
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
      extractMembers(node, name, sourceStr, filePath, symbols);
      continue;
    }
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const sourceStr = source.toString('utf8');
  walkDeclarations(tree.rootNode.children, sourceStr, filePath, symbols);
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const sourceStr = source.toString('utf8');

  function walkForUsings(nodes: SyntaxNode[]): void {
    for (const node of nodes) {
      if (node.type === 'using_directive') {
        const isStatic = node.children.some(
          (c) => c.type === 'static' || nodeText(c, sourceStr) === 'static',
        );
        const nameNode = node.children.find(
          (c) =>
            c.type === 'qualified_name' ||
            c.type === 'identifier' ||
            c.type === 'name_equals',
        );
        if (!nameNode) continue;

        let specifier: string;
        if (nameNode.type === 'name_equals') {
          const rhs = nameNode.children.find(
            (c) => c.type === 'qualified_name' || c.type === 'identifier',
          );
          specifier = rhs ? nodeText(rhs, sourceStr) : '';
        } else {
          specifier = nodeText(nameNode, sourceStr);
        }

        if (!specifier) continue;

        imports.push({
          sourceFile: '',
          specifier,
          resolvedPath: null,
          importedNames: isStatic ? [specifier.split('.').pop() ?? specifier] : [],
          isTypeOnly: false,
        });
        continue;
      }

      if (
        node.type === 'namespace_declaration' ||
        node.type === 'file_scoped_namespace_declaration'
      ) {
        const body = node.children.find((c) => c.type === 'declaration_list');
        if (body) walkForUsings(body.children);
      }
    }
  }

  walkForUsings(tree.rootNode.children);
  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const csharpHandler: LanguageHandler = {
  extensions: () => ['.cs'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-csharp.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
