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

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Walk backwards through named siblings looking for a PHPDoc block comment
 * (`/** ... *\/`). Returns the stripped first sentence, or null.
 */
function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'comment') {
      const text = prev.text;
      if (text.startsWith('/**')) {
        // Strip /** ... */ and leading " * " from each line
        const inner = text
          .slice(2, -2) // remove /** and */
          .split('\n')
          .map((l) => l.replace(/^\s*\*\s?/, '').trim())
          .filter(Boolean)
          .join(' ');
        if (!inner) return null;
        const match = inner.match(/^([^.!?]*[.!?]?)/);
        return ((match ? match[1].trim() : inner).slice(0, 200)) || null;
      }
      break; // non-docblock comment — stop
    }
    if (prev.type !== 'attribute_list') break;
    prev = prev.previousNamedSibling;
  }
  return null;
}

// ─── Signature building ───────────────────────────────────────────────────────

/** Extract text from node start up to (not including) its `body` child. */
function buildSignature(node: SyntaxNode, source: Buffer): string {
  const body = node.childForFieldName?.('body') ??
    node.children.find((c) =>
      c.type === 'compound_statement' ||
      c.type === 'declaration_list' ||
      c.type === 'enum_declaration_list',
    );
  const endByte = body ? body.startIndex : node.endIndex;
  return source
    .toString('utf8', node.startIndex, endByte)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

function getNameText(node: SyntaxNode): string {
  // The `name` field in PHP grammar nodes is a `name` type node (not `identifier`)
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c) => c.type === 'name');
  return nameNode?.text ?? '';
}

// ─── Visibility check ─────────────────────────────────────────────────────────

function isPrivateMethod(node: SyntaxNode): boolean {
  const vis = node.children.find((c) => c.type === 'visibility_modifier');
  return vis?.text === 'private';
}

// ─── Method/member extraction ─────────────────────────────────────────────────

function extractMembers(
  bodyNode: SyntaxNode,
  className: string,
  source: Buffer,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const child of bodyNode.children) {
    if (child.type === 'method_declaration') {
      if (isPrivateMethod(child)) continue;
      const name = getNameText(child);
      if (!name) continue;
      const qualified = `${className}::${name}`;
      symbols.push({
        id: makeId(filePath, qualified, 'method'),
        name: qualified,
        kind: 'method',
        filePath,
        startByte: child.startIndex,
        endByte: child.endIndex,
        signature: buildSignature(child, source),
        summary: extractDocstring(child) ?? '',
      });
    } else if (child.type === 'const_declaration') {
      // Class constants
      for (const ce of child.children) {
        if (ce.type !== 'const_element') continue;
        const name = getNameText(ce);
        if (!name) continue;
        const qualified = `${className}::${name}`;
        const sig = source
          .toString('utf8', child.startIndex, child.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        symbols.push({
          id: makeId(filePath, qualified, 'const'),
          name: qualified,
          kind: 'const',
          filePath,
          startByte: child.startIndex,
          endByte: child.endIndex,
          signature: sig,
          summary: extractDocstring(child) ?? '',
        });
      }
    }
  }
}

// ─── Top-level symbol extraction ──────────────────────────────────────────────

/**
 * Extract symbols from a list of statement nodes.
 * `nsPrefix` is the current namespace (empty string if none).
 */
function extractFromStatements(
  nodes: SyntaxNode[],
  nsPrefix: string,
  source: Buffer,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const qualify = (n: string) => (nsPrefix ? `${nsPrefix}\\${n}` : n);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;

    // ── function_definition ──────────────────────────────────────────────────
    if (node.type === 'function_definition') {
      const name = getNameText(node);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'function'),
        name: qualName,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      continue;
    }

    // ── class_declaration ────────────────────────────────────────────────────
    if (node.type === 'class_declaration') {
      const name = getNameText(node);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'class'),
        name: qualName,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      // Extract methods + class constants from declaration_list
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, source, filePath, symbols);
      continue;
    }

    // ── interface_declaration ─────────────────────────────────────────────────
    if (node.type === 'interface_declaration') {
      const name = getNameText(node);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'interface'),
        name: qualName,
        kind: 'interface',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, source, filePath, symbols);
      continue;
    }

    // ── trait_declaration ─────────────────────────────────────────────────────
    if (node.type === 'trait_declaration') {
      const name = getNameText(node);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'interface'),
        name: qualName,
        kind: 'interface', // Traits map to 'interface' for navigation purposes
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, source, filePath, symbols);
      continue;
    }

    // ── enum_declaration ──────────────────────────────────────────────────────
    if (node.type === 'enum_declaration') {
      const name = getNameText(node);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'enum'),
        name: qualName,
        kind: 'enum',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      continue;
    }

    // ── const_declaration (top-level) ─────────────────────────────────────────
    if (node.type === 'const_declaration') {
      for (const ce of node.children) {
        if (ce.type !== 'const_element') continue;
        const name = getNameText(ce);
        if (!name) continue;
        const qualName = qualify(name);
        const sig = source
          .toString('utf8', node.startIndex, node.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        symbols.push({
          id: makeId(filePath, qualName, 'const'),
          name: qualName,
          kind: 'const',
          filePath,
          startByte: ce.startIndex,
          endByte: ce.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? '',
        });
      }
      continue;
    }

    // ── namespace_definition ──────────────────────────────────────────────────
    if (node.type === 'namespace_definition') {
      const nameNode = node.childForFieldName?.('name') ??
        node.children.find((c) => c.type === 'namespace_name');
      const ns = nameNode?.text ?? '';

      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'compound_statement');

      if (body) {
        // Braced namespace: `namespace Foo { ... }`
        // Recursively extract from body statements
        extractFromStatements(body.children, ns, source, filePath, symbols);
      } else {
        // Unbraced namespace: `namespace Foo;`
        // All nodes after this one belong to the new namespace.
        extractFromStatements(nodes.slice(i + 1), ns, source, filePath, symbols);
        return; // remaining nodes handled by the recursive call
      }
      continue;
    }
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const topLevel = tree.rootNode.children;
  extractFromStatements(topLevel, '', source, filePath, symbols);
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract PHP `use` statements (namespace_use_declaration nodes).
 * e.g. `use App\Http\Controllers\UserController as UserCtrl;`
 */
function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];

  function walk(nodes: SyntaxNode[]): void {
    for (const node of nodes) {
      if (node.type === 'namespace_use_declaration') {
        // Collect namespace_use_clause children
        const clauses = node.children.filter((c) => c.type === 'namespace_use_clause');
        // Also check for namespace_use_group (grouped use)
        const groups = node.children.filter((c) => c.type === 'namespace_use_group');
        for (const group of groups) {
          clauses.push(...group.children.filter((c) => c.type === 'namespace_use_clause'));
        }

        for (const clause of clauses) {
          const qualNode = clause.children.find(
            (c) => c.type === 'qualified_name' || c.type === 'name',
          );
          if (!qualNode) continue;
          const specifier = qualNode.text;
          const segments = specifier.split('\\');
          const lastName = segments[segments.length - 1] ?? specifier;

          const aliasNode = clause.childForFieldName?.('alias') ??
            clause.children.find((c) => c.type === 'name' && c !== qualNode);
          const importedName = aliasNode ? aliasNode.text : lastName;

          imports.push({
            sourceFile: '',
            specifier,
            resolvedPath: null, // Composer autoload — no local path resolution
            importedNames: [importedName],
            isTypeOnly: false,
          });
        }
        continue;
      }

      // Recurse into namespace bodies
      if (node.type === 'namespace_definition') {
        const body = node.childForFieldName?.('body') ??
          node.children.find((c) => c.type === 'compound_statement');
        if (body) walk(body.children);
      }
    }
  }

  walk(tree.rootNode.children);
  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const phpHandler: LanguageHandler = {
  extensions: () => ['.php'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-php.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
