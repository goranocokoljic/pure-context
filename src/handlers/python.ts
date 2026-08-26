import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { decodeCached } from '../core/offsets.js';
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

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Walk the node tree to find the first `block` node (the indented body).
 * For decorated_definition, the block is nested inside function_definition or
 * class_definition, not at the decorated_definition level directly.
 */
function findFirstBlock(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'block') return node;
  for (const child of node.children) {
    const found = findFirstBlock(child);
    if (found) return found;
  }
  return null;
}

/**
 * Build a one-line signature: source from the node start up to (but not
 * including) the indented body block. Collapses whitespace, caps at 120 chars.
 */
function buildSignature(outerNode: SyntaxNode, source: Buffer): string {
  const block = findFirstBlock(outerNode);
  const endIdx = block ? block.startIndex : outerNode.endIndex;
  // node indices are CHAR indices — slice the decoded string, never the buffer
  return decodeCached(source)
    .slice(outerNode.startIndex, endIdx)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Extract a Python docstring: the first expression_statement child of the
 * function/class block that is a string literal.
 */
function extractDocstring(node: SyntaxNode): string | null {
  const block = node.children.find((c) => c.type === 'block');
  if (!block) return null;

  const firstStmt = block.children.find((c) => c.type === 'expression_statement');
  if (!firstStmt) return null;

  const strNode = firstStmt.children.find(
    (c) => c.type === 'string' || c.type === 'concatenated_string',
  );
  if (!strNode) return null;

  let raw = strNode.text;

  // Strip triple-quote delimiters (""" / ''')
  if (raw.startsWith('"""') || raw.startsWith("'''")) {
    raw = raw.slice(3, -3);
  } else if (raw.startsWith('"') || raw.startsWith("'")) {
    raw = raw.slice(1, -1);
  }

  raw = raw.trim();
  if (!raw) return null;

  // Collapse the first paragraph (up to first blank line) into one line
  const firstPara = raw.split(/\n\s*\n/)[0] ?? raw;
  const collapsed = firstPara
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  return collapsed.slice(0, 400) || null;
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/** Get the plain identifier name from a function_definition or class_definition. */
function getName(node: SyntaxNode): string {
  return node.children.find((c) => c.type === 'identifier')?.text ?? '';
}

/**
 * If node is a `decorated_definition`, unwrap to the inner function_definition
 * or class_definition. Otherwise return the node unchanged.
 */
function unwrapDecorated(
  node: SyntaxNode,
): { outer: SyntaxNode; inner: SyntaxNode } | null {
  if (node.type === 'decorated_definition') {
    const inner = node.children.find(
      (c) => c.type === 'function_definition' || c.type === 'class_definition',
    );
    if (inner) return { outer: node, inner };
    return null;
  }
  if (node.type === 'function_definition' || node.type === 'class_definition') {
    return { outer: node, inner: node };
  }
  return null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractClassMembers(
  classNode: SyntaxNode,
  className: string,
  source: Buffer,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const block = classNode.children.find((c) => c.type === 'block');
  if (!block) return;

  for (const child of block.children) {
    const pair = unwrapDecorated(child);
    if (!pair) continue;
    const { outer, inner } = pair;

    if (inner.type === 'function_definition') {
      const name = getName(inner);
      if (!name) continue;
      const qualified = `${className}.${name}`;
      symbols.push({
        id: makeId(filePath, qualified, 'method'),
        name: qualified,
        kind: 'method',
        filePath,
        startByte: outer.startIndex,
        endByte: outer.endIndex,
        signature: buildSignature(outer, source),
        summary: extractDocstring(inner) ?? '',
      });
    }
    // Nested classes are not indexed — too noisy for navigation.
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    // ── function_definition / class_definition (possibly decorated) ──────────
    const pair = unwrapDecorated(node);
    if (pair) {
      const { outer, inner } = pair;

      if (inner.type === 'function_definition') {
        const name = getName(inner);
        if (!name) continue;
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: outer.startIndex,
          endByte: outer.endIndex,
          signature: buildSignature(outer, source),
          summary: extractDocstring(inner) ?? '',
        });
        continue;
      }

      if (inner.type === 'class_definition') {
        const name = getName(inner);
        if (!name) continue;
        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: outer.startIndex,
          endByte: outer.endIndex,
          signature: buildSignature(outer, source),
          summary: extractDocstring(inner) ?? '',
        });
        extractClassMembers(inner, name, source, filePath, symbols);
        continue;
      }
    }

    // ── Module-level type alias (Python 3.12+) ────────────────────────────────
    if (node.type === 'type_alias_statement') {
      const nameNode = node.children.find((c) => c.type === 'type' || c.type === 'identifier');
      if (!nameNode) continue;
      // The first identifier-like child is the alias name
      const name = nameNode.type === 'type'
        ? nameNode.children.find((c) => c.type === 'identifier')?.text ?? nameNode.text
        : nameNode.text;
      if (!name) continue;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: decodeCached(source)
          .slice(node.startIndex, node.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        summary: '',
      });
      continue;
    }

    // ── Module-level UPPER_CASE constant ─────────────────────────────────────
    if (node.type === 'expression_statement') {
      const assignment = node.children.find((c) => c.type === 'assignment');
      if (!assignment) continue;
      const lhs = assignment.children.find((c) => c.type === 'identifier');
      if (!lhs) continue;
      const constName = lhs.text;
      // Only extract ALL_CAPS names (Python constant convention: at least 2 chars)
      if (!/^[A-Z][A-Z0-9_]{1,}$/.test(constName)) continue;
      symbols.push({
        id: makeId(filePath, constName, 'const'),
        name: constName,
        kind: 'const',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: decodeCached(source)
          .slice(node.startIndex, node.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        summary: '',
      });
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Collect imported names from direct children of an import_from_statement that
 * appear after the 'import' keyword. Names are dotted_name nodes (e.g. Path,
 * format_number) or wildcard_import (*).
 */
function collectFromImportNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  let pastImportKeyword = false;
  for (const child of node.children) {
    if (child.type === 'import') {
      pastImportKeyword = true;
      continue;
    }
    if (!pastImportKeyword) continue;
    if (child.type === 'wildcard_import') {
      names.push('*');
    } else if (child.type === 'dotted_name' || child.type === 'identifier') {
      // First identifier in dotted_name is the bare import name
      const ident = child.children.find((c) => c.type === 'identifier') ?? child;
      names.push(ident.text);
    } else if (child.type === 'aliased_import') {
      const original = child.children.find(
        (c) => c.type === 'dotted_name' || c.type === 'identifier',
      );
      if (original) {
        const ident = original.children.find((c) => c.type === 'identifier') ?? original;
        names.push(ident.text);
      }
    }
  }
  return names;
}

function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    // import os  /  import os.path  /  import os as o
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (child.type === 'dotted_name') {
          imports.push({
            sourceFile: '',
            specifier: child.text,
            resolvedPath: null,
            importedNames: [],
            isTypeOnly: false,
          });
        } else if (child.type === 'aliased_import') {
          const modNode = child.children.find((c) => c.type === 'dotted_name');
          if (modNode) {
            imports.push({
              sourceFile: '',
              specifier: modNode.text,
              resolvedPath: null,
              importedNames: [],
              isTypeOnly: false,
            });
          }
        }
      }
      continue;
    }

    // from __future__ import annotations
    // The grammar uses a dedicated `future_import_statement` node for this.
    if (node.type === 'future_import_statement') {
      const importedNames = collectFromImportNames(node);
      imports.push({
        sourceFile: '',
        specifier: '__future__',
        resolvedPath: null,
        importedNames,
        isTypeOnly: true, // __future__ imports are always compile-time directives
      });
      continue;
    }

    // from pathlib import Path  /  from . import foo  /  from ..utils import bar
    if (node.type === 'import_from_statement') {
      // Build specifier from the module reference (between 'from' and 'import')
      let specifier = '';
      const moduleNode = node.children.find(
        (c) => c.type === 'dotted_name' || c.type === 'relative_import',
      );

      if (moduleNode) {
        if (moduleNode.type === 'relative_import') {
          // relative_import: import_prefix (dots) + optional dotted_name
          const prefix = moduleNode.children.find((c) => c.type === 'import_prefix');
          const mod = moduleNode.children.find((c) => c.type === 'dotted_name');
          specifier = (prefix?.text ?? '') + (mod?.text ?? '');
        } else {
          specifier = moduleNode.text; // dotted_name
        }
      }

      if (!specifier) continue;

      const importedNames = collectFromImportNames(node);

      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null,
        importedNames,
        isTypeOnly: false,
      });
    }
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const pythonHandler: LanguageHandler = {
  extensions: () => ['.py'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-python.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
