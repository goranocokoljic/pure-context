import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { LanguageHandler, SymbolRecord, SymbolKind, ImportRecord, SyntaxNode, Tree } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/handlers/ → ../../grammars/
const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

const BODY_NODE_TYPES = new Set([
  'statement_block', 'class_body', 'interface_body', 'enum_body',
]);

const SKIP_IN_EXPORT = new Set(['export', 'default', ';', 'decorator']);

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Signature building ───────────────────────────────────────────────────────

function buildSignature(node: SyntaxNode, sourceStr: string): string {
  let endChar = node.endIndex;

  // If this is an export_statement, unwrap to the inner declaration before
  // searching for a body node so we don't miss class_body / statement_block.
  const declNode =
    node.type === 'export_statement'
      ? (node.children.find((c) => !SKIP_IN_EXPORT.has(c.type)) ?? node)
      : node;

  const bodyNode = findBodyNode(declNode);
  if (bodyNode) endChar = bodyNode.startIndex;

  // node.startIndex / endIndex are JavaScript character indices (not byte offsets)
  // because web-tree-sitter callback mode advances its cursor by char count.
  return sourceStr
    .slice(node.startIndex, endChar)
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
  // The JSDoc comment precedes either the declaration or its wrapping export_statement
  const outer = node.parent?.type === 'export_statement' ? node.parent : node;
  const prev = outer.previousNamedSibling;
  if (!prev || prev.type !== 'comment') return null;

  const text = prev.text;
  if (!text.startsWith('/**')) return null;

  // Strip /** ... */ delimiters, leading * per line, and collapse whitespace
  const body = text
    .slice(2, -2)               // remove /** and */
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');

  // First sentence: up to first period followed by whitespace or end
  const match = body.match(/^([^.!?]+[.!?]?)/);
  return match ? match[1].trim().slice(0, 200) : body.slice(0, 200);
}

// ─── Name extraction helpers ──────────────────────────────────────────────────

// node.startIndex / endIndex are JavaScript character indices (not byte offsets)
// because web-tree-sitter's callback mode indexes by character.
function getChildText(node: SyntaxNode, sourceStr: string, ...types: string[]): string {
  for (const child of node.children) {
    if (types.includes(child.type)) {
      return sourceStr.slice(child.startIndex, child.endIndex);
    }
  }
  return '';
}

// ─── Body snippet extraction ──────────────────────────────────────────────────

/**
 * Extract the first ~200 chars of a function/method body as plain searchable text.
 * Skips the opening brace and normalises whitespace so body tokens land in FTS.
 */
function extractBodySnippet(bodyNode: SyntaxNode, sourceStr: string): string {
  // Skip the opening '{' (+1 char); grab up to 600 raw chars for normalisation headroom
  // node.startIndex / endIndex are character indices (not byte offsets)
  const start = bodyNode.startIndex + 1;
  const end = Math.min(start + 600, bodyNode.endIndex - 1);
  if (start >= end) return '';
  return sourceStr
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function processDeclaration(
  declNode: SyntaxNode,
  outerNode: SyntaxNode,   // export_statement if exported, same as declNode otherwise
  sourceStr: string,       // source.toString('utf8') — character-indexed
  filePath: string,
  symbols: SymbolRecord[],
  tsOnly: boolean,
): void {
  switch (declNode.type) {
    case 'function_declaration': {
      const name = getChildText(declNode, sourceStr, 'identifier');
      if (!name) break;
      const summary = extractDocstring(declNode) ?? '';
      const fnBody = findBodyNode(declNode);
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, sourceStr),
        summary,
        ...(fnBody ? { bodySnippet: extractBodySnippet(fnBody, sourceStr) } : {}),
      });
      break;
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = getChildText(declNode, sourceStr, 'type_identifier');
      if (!name) break;
      const summary = extractDocstring(declNode) ?? '';
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, sourceStr),
        summary,
      });
      // Extract methods from class_body
      const body = declNode.children.find((c) => c.type === 'class_body');
      if (body) {
        for (const member of body.children) {
          if (member.type === 'method_definition') {
            const methodName = getChildText(member, sourceStr, 'property_identifier', 'identifier');
            if (!methodName || methodName.startsWith('#')) continue; // skip private
            const qualified = `${name}.${methodName}`;
            const methodDoc = member.previousNamedSibling?.type === 'comment'
              ? extractDocstring(member)
              : null;
            const methodBody = findBodyNode(member);
            symbols.push({
              id: makeId(filePath, qualified, 'method'),
              name: qualified,
              kind: 'method',
              filePath,
              startByte: member.startIndex,
              endByte: member.endIndex,
              signature: buildSignature(member, sourceStr),
              summary: methodDoc ?? '',
              ...(methodBody ? { bodySnippet: extractBodySnippet(methodBody, sourceStr) } : {}),
            });
          }
        }
      }
      break;
    }

    case 'lexical_declaration': {
      // const/let at top level — only extract named declarators
      for (const child of declNode.children) {
        if (child.type !== 'variable_declarator') continue;
        const name = getChildText(child, sourceStr, 'identifier');
        if (!name) continue;
        const hasArrow = child.children.some((c) => c.type === 'arrow_function');
        const kind: SymbolKind = hasArrow ? 'function' : 'const';
        const summary = extractDocstring(declNode) ?? '';
        // For arrow functions, try to find a block body for the snippet
        let arrowBodySnippet: string | undefined;
        if (hasArrow) {
          const arrowNode = child.children.find((c) => c.type === 'arrow_function');
          if (arrowNode) {
            const arrowBody = arrowNode.children.find((c) => BODY_NODE_TYPES.has(c.type));
            if (arrowBody) arrowBodySnippet = extractBodySnippet(arrowBody, sourceStr);
          }
        }
        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: outerNode.startIndex,
          endByte: outerNode.endIndex,
          signature: buildSignature(outerNode, sourceStr),
          summary,
          ...(arrowBodySnippet ? { bodySnippet: arrowBodySnippet } : {}),
        });
      }
      break;
    }

    case 'type_alias_declaration': {
      if (!tsOnly) break;
      const name = getChildText(declNode, sourceStr, 'type_identifier');
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, sourceStr),
        summary: extractDocstring(declNode) ?? '',
      });
      break;
    }

    case 'interface_declaration': {
      if (!tsOnly) break;
      const name = getChildText(declNode, sourceStr, 'type_identifier');
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'interface'),
        name,
        kind: 'interface',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, sourceStr),
        summary: extractDocstring(declNode) ?? '',
      });
      break;
    }

    case 'enum_declaration': {
      if (!tsOnly) break;
      const name = getChildText(declNode, sourceStr, 'identifier');
      if (!name) break;
      symbols.push({
        id: makeId(filePath, name, 'enum'),
        name,
        kind: 'enum',
        filePath,
        startByte: outerNode.startIndex,
        endByte: outerNode.endIndex,
        signature: buildSignature(outerNode, sourceStr),
        summary: extractDocstring(declNode) ?? '',
      });
      break;
    }
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string, tsOnly: boolean): SymbolRecord[] {
  const sourceStr = source.toString('utf8');
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (node.type === 'export_statement') {
      // Find the declaration inside, skipping export/default keywords
      for (const child of node.children) {
        if (!SKIP_IN_EXPORT.has(child.type)) {
          processDeclaration(child, node, sourceStr, filePath, symbols, tsOnly);
          break;
        }
      }
    } else {
      // Also index non-exported top-level declarations (useful for navigation)
      processDeclaration(node, node, sourceStr, filePath, symbols, tsOnly);
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const sourceStr = source.toString('utf8');
  const imports: ImportRecord[] = [];

  // Detect source file path from the tree (needed for ImportRecord.sourceFile)
  // Caller sets this — we leave it empty here and fill it in the handler wrapper
  const sourceFile = '';

  for (const node of tree.rootNode.children) {
    if (node.type !== 'import_statement') continue;

    // Detect `import type`
    const isTypeOnly = node.children.some((c) => c.type === 'type');

    // Extract specifier string (the path after 'from')
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
          // default import: `import Foo from '...'`
          importedNames.push(sourceStr.slice(child.startIndex, child.endIndex));
        } else if (child.type === 'namespace_import') {
          // `import * as ns from '...'`
          const alias = child.children.find((c) => c.type === 'identifier');
          if (alias) importedNames.push(`* as ${sourceStr.slice(alias.startIndex, alias.endIndex)}`);
        } else if (child.type === 'named_imports') {
          // `import { foo, bar as baz } from '...'`
          for (const spec of child.children) {
            if (spec.type !== 'import_specifier') continue;
            const idents = spec.children.filter((c) => c.type === 'identifier');
            // idents[0] = original name, idents[1] = alias (if present)
            if (idents[0]) importedNames.push(sourceStr.slice(idents[0].startIndex, idents[0].endIndex));
          }
        }
      }
    }
    // Side-effect import: `import './foo'` has no clause — importedNames stays []

    imports.push({
      sourceFile,
      specifier,
      resolvedPath: null, // resolved by path-resolver in Task 7
      importedNames,
      isTypeOnly,
    });
  }

  return imports;
}

// ─── Handler implementations ─────────────────────────────────────────────────

export const typescriptHandler: LanguageHandler = {
  extensions: () => ['.ts', '.mts', '.cts'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-typescript.wasm'),

  extractSymbols: (tree, source, filePath) =>
    extractSymbols(tree, source, filePath, true),

  extractImports: (tree, source) => {
    const imports = extractImports(tree, source);
    return imports;
  },

  extractDocstring,
};

export const tsxHandler: LanguageHandler = {
  extensions: () => ['.tsx'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-tsx.wasm'),

  extractSymbols: (tree, source, filePath) =>
    extractSymbols(tree, source, filePath, true),

  extractImports: (tree, source) => extractImports(tree, source),

  extractDocstring,
};
