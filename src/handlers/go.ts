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

// ─── Visibility ───────────────────────────────────────────────────────────────

/** Go exports only names that start with an uppercase letter. */
function isExported(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

// ─── Signature building ───────────────────────────────────────────────────────

/**
 * Build a one-line signature by taking source from the node start up to (but
 * not including) the opening brace block. Collapses whitespace, caps at 120 chars.
 */
function buildSignature(node: SyntaxNode, source: Buffer): string {
  const blockNode = node.children.find((c) => c.type === 'block');
  const endByte = blockNode ? blockNode.startIndex : node.endIndex;
  return source
    .toString('utf8', node.startIndex, endByte)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Build a compact signature for a type declaration.
 * Shows the keyword + name + type keyword (struct/interface), truncated body preview.
 */
function buildTypeSignature(typeDecl: SyntaxNode, source: Buffer): string {
  // Full text is "type Name struct { ... }" — collapse to one line and truncate
  return source
    .toString('utf8', typeDecl.startIndex, typeDecl.endIndex)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Build a signature for a const spec (single constant).
 * "const NAME = value" or "const NAME Type = value"
 */
function buildConstSignature(spec: SyntaxNode, source: Buffer): string {
  return 'const ' + source
    .toString('utf8', spec.startIndex, spec.endIndex)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 116); // 116 + "const " = 122, then sliced to 120
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Extract a Go doc comment: one or more `// ...` comment lines that immediately
 * precede the declaration node (as the previousNamedSibling chain).
 */
function extractDocstring(node: SyntaxNode): string | null {
  // Walk backwards through named siblings to collect adjacent comment lines
  const lines: string[] = [];
  let prev = node.previousNamedSibling;

  while (prev?.type === 'comment') {
    lines.unshift(prev.text.replace(/^\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }

  if (lines.length === 0) return null;

  const text = lines.join(' ').trim();
  if (!text) return null;

  // Return up to the first sentence-ending punctuation
  const match = text.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1].trim() : text).slice(0, 200)) || null;
}

// ─── Receiver type extraction ─────────────────────────────────────────────────

/**
 * Extract the receiver type name from the first parameter_list of a method_declaration.
 * Handles both pointer receivers `(s *AuthService)` and value receivers `(s AuthService)`.
 */
function extractReceiverType(methodNode: SyntaxNode): string {
  const receiverList = methodNode.children.find((c) => c.type === 'parameter_list');
  if (!receiverList) return '';

  const paramDecl = receiverList.children.find((c) => c.type === 'parameter_declaration');
  if (!paramDecl) return '';

  // Pointer receiver: parameter_declaration → pointer_type → type_identifier
  const ptrType = paramDecl.children.find((c) => c.type === 'pointer_type');
  if (ptrType) {
    return ptrType.children.find((c) => c.type === 'type_identifier')?.text ?? '';
  }

  // Value receiver: parameter_declaration → type_identifier
  return paramDecl.children.find((c) => c.type === 'type_identifier')?.text ?? '';
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    // ── function_declaration ─────────────────────────────────────────────────
    if (node.type === 'function_declaration') {
      const nameNode = node.children.find((c) => c.type === 'identifier');
      if (!nameNode) continue;
      const name = nameNode.text;
      if (!isExported(name)) continue;
      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      continue;
    }

    // ── method_declaration ───────────────────────────────────────────────────
    if (node.type === 'method_declaration') {
      const nameNode = node.children.find((c) => c.type === 'field_identifier');
      if (!nameNode) continue;
      const methodName = nameNode.text;
      if (!isExported(methodName)) continue;

      const receiverType = extractReceiverType(node);
      const qualifiedName = receiverType ? `${receiverType}.${methodName}` : methodName;

      symbols.push({
        id: makeId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      continue;
    }

    // ── type_declaration (struct / interface / type alias / custom type) ─────
    if (node.type === 'type_declaration') {
      // Go uses type_spec for `type Foo struct{}`/`type Foo Bar`
      // and type_alias for `type Foo = Bar`
      const typeSpec = node.children.find(
        (c) => c.type === 'type_spec' || c.type === 'type_alias',
      );
      if (!typeSpec) continue;

      const nameNode = typeSpec.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) continue;
      const name = nameNode.text;
      if (!isExported(name)) continue;

      // Determine kind from the type body (type_alias is always kind 'type')
      const typeBody = typeSpec.type === 'type_spec'
        ? typeSpec.children.find(
            (c) => c.type !== 'type_identifier' && c.type !== 'type_parameters',
          )
        : null;
      let kind: SymbolKind = 'type';
      if (typeBody?.type === 'struct_type') kind = 'class';
      else if (typeBody?.type === 'interface_type') kind = 'interface';

      symbols.push({
        id: makeId(filePath, name, kind),
        name,
        kind,
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildTypeSignature(node, source),
        summary: extractDocstring(node) ?? '',
      });
      continue;
    }

    // ── const_declaration ────────────────────────────────────────────────────
    if (node.type === 'const_declaration') {
      // May contain multiple const_spec children (grouped const block)
      for (const child of node.children) {
        if (child.type !== 'const_spec') continue;
        const nameNode = child.children.find((c) => c.type === 'identifier');
        if (!nameNode) continue;
        const name = nameNode.text;
        if (!isExported(name)) continue;
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: child.startIndex,
          endByte: child.endIndex,
          signature: buildConstSignature(child, source),
          summary: extractDocstring(node) ?? '',
        });
      }
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract the path string from an import_spec's interpreted_string_literal.
 * e.g. `"fmt"` → `fmt`, `"math/rand"` → `math/rand`
 */
function getImportPath(spec: SyntaxNode): string {
  const strLit = spec.children.find((c) => c.type === 'interpreted_string_literal');
  if (!strLit) return '';
  const content = strLit.children.find((c) => c.type === 'interpreted_string_literal_content');
  return content?.text ?? '';
}

function extractImports(tree: Tree, _source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (node.type !== 'import_declaration') continue;

    // Collect all import_spec nodes (either direct child or inside import_spec_list)
    const specs: SyntaxNode[] = [];
    for (const child of node.children) {
      if (child.type === 'import_spec') {
        specs.push(child);
      } else if (child.type === 'import_spec_list') {
        for (const inner of child.children) {
          if (inner.type === 'import_spec') specs.push(inner);
        }
      }
    }

    for (const spec of specs) {
      const specifier = getImportPath(spec);
      if (!specifier) continue;

      // Detect blank imports (`_ "pkg"`) — skip entirely (side-effect only)
      const isBlank = spec.children.some((c) => c.type === 'blank_identifier');
      if (isBlank) continue;

      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null, // Go uses module paths — resolution requires go.mod parsing
        importedNames: [],  // Go imports are package-level, not named symbol imports
        isTypeOnly: false,
      });
    }
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const goHandler: LanguageHandler = {
  extensions: () => ['.go'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-go.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,
};
