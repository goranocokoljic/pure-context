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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

function nodeText(node: SyntaxNode, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

function trunc(s: string, max = 120): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// ─── Access control ───────────────────────────────────────────────────────────

/**
 * Return the visibility modifier text (private, fileprivate, internal, public, open)
 * or null if none is present. Looks inside a `modifiers` child node.
 */
function getVisibility(node: SyntaxNode, src: string): string | null {
  const modifiers = node.children.find((c) => c.isNamed && c.type === 'modifiers');
  if (!modifiers) return null;
  const vis = modifiers.children.find((c) => c.isNamed && c.type === 'visibility_modifier');
  return vis ? nodeText(vis, src).trim() : null;
}

/**
 * Returns true if the symbol should be skipped due to private/fileprivate access.
 */
function isPrivateAccess(node: SyntaxNode, src: string): boolean {
  const vis = getVisibility(node, src);
  return vis === 'private' || vis === 'fileprivate';
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node.previousNamedSibling;

  // Block /** */ comment
  if (cur && cur.type === 'multiline_comment') {
    const raw = cur.text;
    if (raw.startsWith('/**')) {
      const inner = raw
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      const m = inner.match(/^([^.!?]*[.!?]?)/);
      return (m ? m[1]!.trim() : inner) || null;
    }
  }

  // Triple-slash /// lines — collect consecutive comment nodes going backwards
  const lines: string[] = [];
  cur = node.previousNamedSibling;
  while (cur && cur.type === 'comment') {
    const t = cur.text;
    if (!t.startsWith('///') && !t.startsWith('//')) break;
    lines.unshift(t.replace(/^\/\/\/?\s?/, '').trim());
    cur = cur.previousNamedSibling;
  }
  if (lines.length > 0) {
    const joined = lines.join(' ');
    const m = joined.match(/^([^.!?]*[.!?]?)/);
    return (m ? m[1]!.trim() : joined) || null;
  }

  return null;
}

// ─── Signature helpers ────────────────────────────────────────────────────────

/**
 * Get the declaration header — everything up to (but not including) the body `{`.
 * Strips leading attribute annotations and normalises whitespace.
 */
function declHeader(node: SyntaxNode, src: string): string {
  const full = nodeText(node, src);
  // Take up to first `{` that opens the body
  const braceIdx = full.indexOf('{');
  const header = braceIdx >= 0 ? full.slice(0, braceIdx) : full;
  return header.replace(/\s+/g, ' ').trim();
}

/**
 * Get the function modifiers string (async, throws) from a function_declaration.
 * Looks for a `throws` child (keyword node text "throws" or "rethrows").
 */
function getFuncModifiers(node: SyntaxNode, src: string): string {
  const parts: string[] = [];
  for (const c of node.children) {
    if (!c.isNamed) continue;
    if (c.type === 'throws') parts.push(nodeText(c, src).trim());
  }
  // async is a function_modifier inside modifiers
  const modifiers = node.children.find((c) => c.isNamed && c.type === 'modifiers');
  if (modifiers) {
    for (const c of modifiers.children) {
      if (c.isNamed && c.type === 'function_modifier') {
        const t = nodeText(c, src).trim();
        if (t === 'async' || t === 'mutating' || t === 'static' || t === 'class') {
          parts.unshift(t);
        }
      }
    }
  }
  return parts.join(' ');
}

/**
 * Extract the simple name from a function_declaration's `name` field.
 * Returns the raw text (identifier or custom operator symbol).
 */
function getFunctionName(node: SyntaxNode, src: string): string | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  return nodeText(nameNode, src).trim();
}

/**
 * Get a concise parameter list string "(label: Type, ...)" from function children.
 * Falls back to "()" if no parameter children are found.
 */
function getParamList(node: SyntaxNode, src: string): string {
  const params = node.children.filter((c) => c.isNamed && c.type === 'parameter');
  if (params.length === 0) return '()';
  const paramStrs = params.map((p) => {
    // parameter fields: external_name, name, type
    const extName = p.childForFieldName('external_name');
    const pName = p.childForFieldName('name');
    const pType = p.childForFieldName('type');
    const label = extName ? nodeText(extName, src).trim() : pName ? nodeText(pName, src).trim() : '_';
    const type = pType ? nodeText(pType, src).trim() : '';
    return type ? `${label}: ${type}` : label;
  });
  return '(' + paramStrs.join(', ') + ')';
}

// ─── Type name extraction ──────────────────────────────────────────────────────

/**
 * Extract the type name string from a class_declaration's `name` field.
 * Handles user_type, type_identifier, and other complex name forms.
 */
function getTypeName(node: SyntaxNode, src: string): string | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  return nodeText(nameNode, src).trim();
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface WalkContext {
  typeName: string | null;
}

// ─── Top-level and class-body symbol extraction ───────────────────────────────

function emitFunction(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const rawName = getFunctionName(node, src);
  if (!rawName) return;

  const symbolName = ctx.typeName ? `${ctx.typeName}.${rawName}` : rawName;
  const kind: SymbolKind = ctx.typeName ? 'method' : 'function';

  // Build signature from header (cleaner than extracting each part)
  const header = declHeader(node, src);
  // For methods, trim the leading modifiers that are already in context
  const sig = trunc(header);

  symbols.push({
    id: makeId(filePath, symbolName, kind),
    name: symbolName,
    kind,
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Swift ${kind}: ${symbolName}`,
  });
}

function emitInit(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const typeName = ctx.typeName ?? 'init';
  // Failable init: has a `bang` child (the `?` or `!` after `init`)
  const isFailable = node.children.some((c) => !c.isNamed && c.type === '?')
    || node.children.some((c) => c.isNamed && c.type === 'bang');
  const suffix = isFailable ? '?' : '';
  const symbolName = `${typeName}.init${suffix}`;

  const params = getParamList(node, src);
  const throwsMod = getFuncModifiers(node, src);
  const throwsPart = throwsMod ? ` ${throwsMod}` : '';
  const sig = trunc(`init${suffix}${params}${throwsPart}`);

  symbols.push({
    id: makeId(filePath, symbolName, 'method'),
    name: symbolName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Initializer: ${symbolName}`,
  });
}

function emitDeinit(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  const typeName = ctx.typeName ?? 'deinit';
  const symbolName = `${typeName}.deinit`;

  symbols.push({
    id: makeId(filePath, symbolName, 'method'),
    name: symbolName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: `deinit`,
    summary: extractDocstring(node) ?? `Deinitializer: ${symbolName}`,
  });
}

function emitSubscript(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const typeName = ctx.typeName ?? 'subscript';
  const symbolName = `${typeName}.subscript`;
  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, symbolName, 'method'),
    name: symbolName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Subscript: ${symbolName}`,
  });
}

function emitProperty(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  // Only emit computed properties (with getter/setter body) — not stored properties
  const hasComputedValue = node.childForFieldName('computed_value') !== null;
  if (!hasComputedValue) return;
  if (isPrivateAccess(node, src)) return;

  // Name from `name` field → pattern → simple_identifier
  const nameField = node.childForFieldName('name');
  if (!nameField) return;

  // pattern may be a simple_identifier directly or contain one
  const rawName = nameField.type === 'simple_identifier'
    ? nodeText(nameField, src).trim()
    : (() => {
        const si = nameField.children.find((c) => c.type === 'simple_identifier');
        return si ? nodeText(si, src).trim() : nodeText(nameField, src).trim();
      })();

  if (!rawName || rawName.startsWith('_')) return;

  const symbolName = ctx.typeName ? `${ctx.typeName}.${rawName}` : rawName;
  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, symbolName, 'const'),
    name: symbolName,
    kind: 'const',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Property: ${symbolName}`,
  });
}

function emitTopLevelLet(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  // Only emit `let` declarations (not `var`) with an uppercase/PascalCase name → kind 'const'
  const vbp = node.children.find((c) => c.isNamed && c.type === 'value_binding_pattern');
  if (!vbp || nodeText(vbp, src).trim() !== 'let') return;

  const nameField = node.childForFieldName('name');
  if (!nameField) return;

  // Find simple_identifier inside pattern
  const si = nameField.type === 'simple_identifier'
    ? nameField
    : nameField.children.find((c) => c.type === 'simple_identifier');
  if (!si) return;

  const rawName = nodeText(si, src).trim();
  // Only emit names that start with uppercase (PascalCase / UPPER_SNAKE_CASE constants)
  if (!rawName || rawName.startsWith('_') || !/^[A-Z]/.test(rawName)) return;

  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, rawName, 'const'),
    name: rawName,
    kind: 'const',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Constant: ${rawName}`,
  });
}

function emitTypealias(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nodeText(nameNode, src).trim();
  if (!name || name.startsWith('_')) return;

  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, name, 'type'),
    name,
    kind: 'type',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Type alias: ${name}`,
  });
}

function emitProtocol(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nodeText(nameNode, src).trim();
  if (!name || name.startsWith('_')) return;

  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, name, 'interface'),
    name,
    kind: 'interface',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Protocol: ${name}`,
  });

  // Recurse into protocol body
  const body = node.childForFieldName('body');
  if (body) {
    const ctx: WalkContext = { typeName: name };
    walkBody(body, src, filePath, ctx, symbols);
  }
}

function emitProtocolFunction(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const rawName = nodeText(nameNode, src).trim();
  if (!rawName || rawName.startsWith('_')) return;

  const symbolName = ctx.typeName ? `${ctx.typeName}.${rawName}` : rawName;
  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, symbolName, 'method'),
    name: symbolName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Protocol method: ${symbolName}`,
  });
}

function emitProtocolProperty(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const nameField = node.childForFieldName('name');
  if (!nameField) return;
  // name field is a `pattern` node — extract the simple_identifier from it
  const si = nameField.type === 'simple_identifier'
    ? nameField
    : nameField.children.find((c) => c.type === 'simple_identifier');
  const rawName = si ? nodeText(si, src).trim() : nodeText(nameField, src).trim();
  if (!rawName || rawName.startsWith('_')) return;

  const symbolName = ctx.typeName ? `${ctx.typeName}.${rawName}` : rawName;
  const sig = trunc(declHeader(node, src));

  symbols.push({
    id: makeId(filePath, symbolName, 'const'),
    name: symbolName,
    kind: 'const',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Protocol property: ${symbolName}`,
  });
}

// ─── class_declaration (class / struct / actor / extension / enum) ─────────────

function emitClassDecl(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  if (isPrivateAccess(node, src)) return;

  const kindNode = node.childForFieldName('declaration_kind');
  if (!kindNode) return;
  const declKind = nodeText(kindNode, src).trim(); // 'class', 'struct', 'actor', 'extension', 'enum'

  const typeName = getTypeName(node, src);
  if (!typeName) return;

  // For extension, the name is the extended type, not a new type definition
  // Extensions starting with _ are unusual but still navigable
  const displayName = ctx.typeName
    ? `${ctx.typeName}.${typeName}` // nested type
    : typeName;

  const sig = trunc(declHeader(node, src));

  let symbolKind: SymbolKind;
  const frameworkMeta: Record<string, unknown> = {};

  switch (declKind) {
    case 'class':
      symbolKind = 'class';
      break;
    case 'struct':
      symbolKind = 'class'; // structs are value-type class equivalents
      break;
    case 'enum':
      symbolKind = 'enum';
      break;
    case 'actor':
      symbolKind = 'class';
      frameworkMeta['swift_actor'] = true;
      break;
    case 'extension':
      symbolKind = 'class';
      frameworkMeta['swift_extension'] = true;
      break;
    default:
      symbolKind = 'class';
  }

  const summary =
    extractDocstring(node) ??
    `Swift ${declKind}: ${displayName}`;

  const record: SymbolRecord = {
    id: makeId(filePath, displayName, symbolKind),
    name: displayName,
    kind: symbolKind,
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary,
  };
  if (Object.keys(frameworkMeta).length > 0) record.frameworkMeta = frameworkMeta;
  symbols.push(record);

  // Recurse into body
  const bodyNode = node.childForFieldName('body');
  if (bodyNode) {
    const innerCtx: WalkContext = { typeName: displayName };
    walkBody(bodyNode, src, filePath, innerCtx, symbols);
  }
}

// ─── Body walker (class_body, protocol_body, enum_class_body) ─────────────────

function walkBody(
  bodyNode: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  for (const child of bodyNode.children) {
    if (!child.isNamed) continue;
    walkNode(child, src, filePath, ctx, symbols);
  }
}

// ─── Universal node walker ─────────────────────────────────────────────────────

function walkNode(
  node: SyntaxNode,
  src: string,
  filePath: string,
  ctx: WalkContext,
  symbols: SymbolRecord[],
): void {
  switch (node.type) {
    case 'class_declaration':
      emitClassDecl(node, src, filePath, ctx, symbols);
      break;

    case 'protocol_declaration':
      emitProtocol(node, src, filePath, symbols);
      break;

    case 'function_declaration':
      emitFunction(node, src, filePath, ctx, symbols);
      break;

    case 'protocol_function_declaration':
      emitProtocolFunction(node, src, filePath, ctx, symbols);
      break;

    case 'protocol_property_declaration':
      emitProtocolProperty(node, src, filePath, ctx, symbols);
      break;

    case 'init_declaration':
      emitInit(node, src, filePath, ctx, symbols);
      break;

    case 'deinit_declaration':
      emitDeinit(node, src, filePath, ctx, symbols);
      break;

    case 'subscript_declaration':
      emitSubscript(node, src, filePath, ctx, symbols);
      break;

    case 'property_declaration':
      if (ctx.typeName) {
        // Inside a type body — emit computed properties only
        emitProperty(node, src, filePath, ctx, symbols);
      } else {
        // Top-level let/var — emit as const if PascalCase/uppercase
        emitTopLevelLet(node, src, filePath, symbols);
      }
      break;

    case 'typealias_declaration':
      emitTypealias(node, src, filePath, symbols);
      break;

    default:
      break;
  }
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  const ctx: WalkContext = { typeName: null };

  for (const node of tree.rootNode.children) {
    if (!node.isNamed) continue;
    walkNode(node, src, filePath, ctx, symbols);
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed || node.type !== 'import_declaration') continue;

    // import_declaration children include identifier nodes — collect them all
    // e.g. `import Foundation` → one identifier "Foundation"
    // e.g. `import struct Foundation.URL` → modifier + identifiers
    const identifiers = node.children
      .filter((c) => c.isNamed && c.type === 'identifier')
      .map((c) => nodeText(c, src).trim());

    if (identifiers.length === 0) continue;

    // Join identifiers with '.' for nested module paths (e.g. `import A.B`)
    const specifier = identifiers.join('.');

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: null, // Swift Package Manager handles resolution
      importedNames: [],
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const swiftHandler: LanguageHandler = {
  extensions: () => ['.swift'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-swift.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
