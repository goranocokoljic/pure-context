import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { decodeCached } from '../core/offsets.js';
import type { LanguageHandler, SymbolRecord, SymbolKind, ImportRecord, SyntaxNode, Tree } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

const BODY_NODE_TYPES = new Set([
  'statement_block', 'class_body',
]);

const SKIP_IN_EXPORT = new Set(['export', 'default', ';']);

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Signature building ───────────────────────────────────────────────────────

function buildSignature(node: SyntaxNode, source: Buffer): string {
  let endByte = node.endIndex;
  const declNode =
    node.type === 'export_statement'
      ? (node.children.find((c) => !SKIP_IN_EXPORT.has(c.type)) ?? node)
      : node;
  const bodyNode = findBodyNode(declNode);
  if (bodyNode) endByte = bodyNode.startIndex;
  // node indices are CHAR indices — slice the decoded string, never the buffer
  return decodeCached(source)
    .slice(node.startIndex, endByte)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function findBodyNode(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.children) {
    if (BODY_NODE_TYPES.has(child.type)) return child;
    if (child.type === 'variable_declarator') {
      const inner = findBodyNode(child);
      if (inner) return inner;
    }
    if (child.type === 'arrow_function') {
      for (const c of child.children) {
        if (BODY_NODE_TYPES.has(c.type)) return c;
      }
    }
  }
  return null;
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  const outer = node.parent?.type === 'export_statement' ? node.parent : node;
  const prev = outer.previousNamedSibling;
  if (!prev || prev.type !== 'comment') return null;

  const text = prev.text;
  if (!text.startsWith('/**')) return null;

  const body = text
    .slice(2, -2)
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');

  const match = body.match(/^([^.!?]+[.!?]?)/);
  return match ? match[1].trim().slice(0, 200) : body.slice(0, 200);
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

function getChildText(node: SyntaxNode, sourceStr: string, ...types: string[]): string {
  for (const child of node.children) {
    if (types.includes(child.type)) {
      return sourceStr.slice(child.startIndex, child.endIndex);
    }
  }
  return '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function processDeclaration(
  declNode: SyntaxNode,
  outerNode: SyntaxNode,
  source: Buffer,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  switch (declNode.type) {
    case 'function_declaration': {
      const name = getChildText(declNode, sourceStr, 'identifier');
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, source),
        summary: extractDocstring(declNode) ?? '',
      });
      break;
    }

    case 'class_declaration': {
      const name = getChildText(declNode, sourceStr, 'identifier');
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, source),
        summary: extractDocstring(declNode) ?? '',
      });
      const body = declNode.children.find((c) => c.type === 'class_body');
      if (body) {
        for (const member of body.children) {
          if (member.type === 'method_definition') {
            const methodName = getChildText(member, sourceStr, 'property_identifier', 'identifier');
            if (!methodName || methodName.startsWith('#')) continue;
            const qualified = `${name}.${methodName}`;
            const methodDoc = member.previousNamedSibling?.type === 'comment'
              ? extractDocstring(member)
              : null;
            symbols.push({
              id: makeId(filePath, qualified, 'method'),
              name: qualified,
              kind: 'method',
              filePath,
              startByte: member.startIndex,
              endByte: member.endIndex,
              signature: buildSignature(member, source),
              summary: methodDoc ?? '',
            });
          }
        }
      }
      break;
    }

    case 'lexical_declaration': {
      for (const child of declNode.children) {
        if (child.type !== 'variable_declarator') continue;
        const name = getChildText(child, sourceStr, 'identifier');
        if (!name) continue;
        const hasArrow = child.children.some((c) => c.type === 'arrow_function');
        const kind: SymbolKind = hasArrow ? 'function' : 'const';
        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: outerNode.startIndex,
          endByte: outerNode.endIndex,
          signature: buildSignature(outerNode, source),
          summary: extractDocstring(declNode) ?? '',
        });
      }
      break;
    }
  }
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const sourceStr = source.toString('utf8');
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (node.type !== 'import_statement') continue;

    const stringNode = node.children.find((c) => c.type === 'string');
    const specifier = stringNode
      ? getChildText(stringNode, sourceStr, 'string_fragment')
      : '';
    if (!specifier) continue;

    const importedNames: string[] = [];
    const clause = node.children.find((c) => c.type === 'import_clause');
    if (clause) {
      for (const child of clause.children) {
        if (child.type === 'identifier') {
          importedNames.push(sourceStr.slice(child.startIndex, child.endIndex));
        } else if (child.type === 'namespace_import') {
          const alias = child.children.find((c) => c.type === 'identifier');
          if (alias) importedNames.push(`* as ${sourceStr.slice(alias.startIndex, alias.endIndex)}`);
        } else if (child.type === 'named_imports') {
          for (const spec of child.children) {
            if (spec.type !== 'import_specifier') continue;
            const idents = spec.children.filter((c) => c.type === 'identifier');
            if (idents[0]) importedNames.push(sourceStr.slice(idents[0].startIndex, idents[0].endIndex));
          }
        }
      }
    }

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: null,
      importedNames,
      isTypeOnly: false, // JavaScript has no import type
    });
  }

  return imports;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const javascriptHandler: LanguageHandler = {
  extensions: () => ['.js', '.jsx', '.mjs', '.cjs'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-javascript.wasm'),

  extractSymbols: (tree, source, filePath) =>
    processDeclarationRoot(tree, source, filePath),

  extractImports,

  extractDocstring,
};

function processDeclarationRoot(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const sourceStr = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  for (const node of tree.rootNode.children) {
    if (node.type === 'export_statement') {
      for (const child of node.children) {
        if (!SKIP_IN_EXPORT.has(child.type)) {
          processDeclaration(child, node, source, sourceStr, filePath, symbols);
          break;
        }
      }
    } else {
      processDeclaration(node, node, source, sourceStr, filePath, symbols);
    }
  }
  return symbols;
}
