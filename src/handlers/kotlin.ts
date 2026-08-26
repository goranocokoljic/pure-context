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

function nodeText(node: SyntaxNode, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

function childText(node: SyntaxNode, src: string, ...types: string[]): string {
  const child = node.children.find((c) => types.includes(c.type));
  return child ? nodeText(child, src) : '';
}

/** Return the text of the first named `simple_identifier` child. */
function simpleName(node: SyntaxNode, src: string): string {
  const child = node.children.find((c) => c.type === 'simple_identifier');
  return child ? nodeText(child, src) : '';
}

/** Return the text of the first `type_identifier` child. */
function typeName(node: SyntaxNode, src: string): string {
  const child = node.children.find((c) => c.type === 'type_identifier');
  return child ? nodeText(child, src) : '';
}

// ─── Visibility ───────────────────────────────────────────────────────────────

type KotlinVisibility = 'public' | 'internal' | 'protected' | 'private';

/**
 * Visibility modifier of a declaration. Default visibility in Kotlin is public.
 *
 * Only `private` declarations are excluded from the index. `internal` means
 * visible within the compilation module — in a multi-module Gradle build that
 * is exactly the unit being indexed, so `internal` symbols (impl classes, Hilt
 * modules, repository implementations) must stay findable. Their visibility is
 * recorded in frameworkMeta so API-surface tools can still filter them.
 */
function visibilityOf(node: SyntaxNode, src: string): KotlinVisibility {
  const modifiers = node.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return 'public';
  for (const c of modifiers.children) {
    if (c.type !== 'visibility_modifier') continue;
    const t = nodeText(c, src);
    if (t === 'private' || t === 'internal' || t === 'protected') return t;
  }
  return 'public';
}

/** Merge non-public visibility into a symbol's frameworkMeta. */
function withVisibility(
  meta: Record<string, unknown> | undefined,
  visibility: KotlinVisibility,
): Record<string, unknown> | undefined {
  return visibility === 'public' ? meta : { ...(meta ?? {}), visibility };
}

// ─── Class kind detection ─────────────────────────────────────────────────────

/**
 * Determine whether a `class_declaration` is an interface, enum, or plain class.
 * Returns 'interface', 'enum', or 'class'.
 */
function classKind(node: SyntaxNode): 'interface' | 'enum' | 'class' {
  // Interface: has anonymous "interface" keyword child
  if (node.children.some((c) => !c.isNamed && c.type === 'interface')) {
    return 'interface';
  }
  // Enum: has enum_class_body child
  if (node.children.some((c) => c.type === 'enum_class_body')) {
    return 'enum';
  }
  return 'class';
}

// ─── Signature builders ───────────────────────────────────────────────────────

function buildFunctionSignature(node: SyntaxNode, src: string): string {
  // Grab from `fun` keyword to the end of the return type (before the body)
  const bodyChild = node.children.find((c) => c.type === 'function_body');
  const end = bodyChild ? bodyChild.startIndex : node.endIndex;
  const raw = src.slice(node.startIndex, end).trim().replace(/\s+/g, ' ');
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

function buildClassSignature(node: SyntaxNode, src: string): string {
  // Grab up to (but not including) the class body
  const bodyChild = node.children.find(
    (c) => c.type === 'class_body' || c.type === 'enum_class_body',
  );
  const end = bodyChild ? bodyChild.startIndex : node.endIndex;
  const raw = src.slice(node.startIndex, end).trim().replace(/\s+/g, ' ');
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

function buildObjectSignature(node: SyntaxNode, src: string): string {
  const bodyChild = node.children.find((c) => c.type === 'class_body');
  const end = bodyChild ? bodyChild.startIndex : node.endIndex;
  const raw = src.slice(node.startIndex, end).trim().replace(/\s+/g, ' ');
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

function buildPropertySignature(node: SyntaxNode, src: string): string {
  const raw = nodeText(node, src).split('\n')[0]!.trim();
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

interface WalkContext {
  /** Qualified class name for method resolution, e.g. "User" or "User.Companion" */
  className: string | null;
  /** True when inside a companion object body */
  inCompanion: boolean;
}

function walkNode(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
  ctx: WalkContext,
): void {
  switch (node.type) {
    case 'function_declaration': {
      const fnVisibility = visibilityOf(node, src);
      if (fnVisibility === 'private') break;
      const name = simpleName(node, src);
      if (!name) break;

      // Detect extension functions: a user_type or nullable_type child appears
      // before a "." anonymous node before the simple_identifier (function name).
      let receiverText: string | null = null;
      if (ctx.className === null) {
        const dotIdx = node.children.findIndex(
          (c) => !c.isNamed && c.type === '.',
        );
        if (dotIdx > 0) {
          const beforeDot = node.children[dotIdx - 1];
          if (beforeDot && (beforeDot.type === 'user_type' || beforeDot.type === 'nullable_type')) {
            // Strip generic type parameters for a clean symbol name
            receiverText = nodeText(beforeDot, src).replace(/<[^>]*>/g, '').trim();
          }
        }
      }

      const qualName = ctx.className
        ? `${ctx.className}.${name}`
        : receiverText
          ? `${receiverText}.${name}`
          : name;
      const kind: SymbolKind = (ctx.className || receiverText) ? 'method' : 'function';
      const sig = buildFunctionSignature(node, src);
      symbols.push({
        id: makeId(filePath, qualName, kind),
        name: qualName,
        kind,
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: (ctx.className || receiverText)
          ? `Kotlin method: ${qualName}`
          : `Kotlin function: ${qualName}`,
        frameworkMeta: withVisibility(undefined, fnVisibility),
      });
      // Do not recurse into function bodies
      break;
    }

    case 'class_declaration': {
      const classVisibility = visibilityOf(node, src);
      if (classVisibility === 'private') break;
      const name = typeName(node, src);
      if (!name) break;

      const ck = classKind(node);
      const kind: SymbolKind = ck === 'interface' ? 'interface' : ck === 'enum' ? 'enum' : 'class';
      const sig = buildClassSignature(node, src);
      symbols.push({
        id: makeId(filePath, name, kind),
        name,
        kind,
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: `Kotlin ${kind}: ${name}`,
        frameworkMeta: withVisibility(undefined, classVisibility),
      });

      // Extract primary constructor properties (val/var class_parameter nodes)
      const primaryCtor = node.children.find((c) => c.type === 'primary_constructor');
      if (primaryCtor) {
        for (const param of primaryCtor.children) {
          if (param.type !== 'class_parameter') continue;
          const bindingKind = childText(param, src, 'binding_pattern_kind');
          if (bindingKind !== 'val' && bindingKind !== 'var') continue;
          const paramVisibility = visibilityOf(param, src);
          if (paramVisibility === 'private') continue;
          const propName = simpleName(param, src);
          if (!propName) continue;
          const qualPropName = `${name}.${propName}`;
          const sig = nodeText(param, src).replace(/\s+/g, ' ').trim().slice(0, 120);
          symbols.push({
            id: makeId(filePath, qualPropName, 'property'),
            name: qualPropName,
            kind: 'property',
            filePath,
            startByte: param.startIndex,
            endByte: param.endIndex,
            signature: sig,
            summary: `Kotlin property: ${qualPropName}`,
            frameworkMeta: withVisibility(undefined, paramVisibility),
          });
        }
      }

      // Recurse into class body
      const body = node.children.find(
        (c) => c.type === 'class_body' || c.type === 'enum_class_body',
      );
      if (body) {
        for (const child of body.children) {
          walkNode(child, src, filePath, symbols, { className: name, inCompanion: false });
        }
      }
      break;
    }

    case 'object_declaration': {
      const objVisibility = visibilityOf(node, src);
      if (objVisibility === 'private') break;
      const name = typeName(node, src);
      if (!name) break;

      const sig = buildObjectSignature(node, src);
      symbols.push({
        id: makeId(filePath, name, 'class'),
        name,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: `Kotlin object: ${name}`,
        frameworkMeta: withVisibility({ kotlin_object: true }, objVisibility),
      });

      const body = node.children.find((c) => c.type === 'class_body');
      if (body) {
        for (const child of body.children) {
          walkNode(child, src, filePath, symbols, { className: name, inCompanion: false });
        }
      }
      break;
    }

    case 'companion_object': {
      // Companion object functions become ClassName.functionName
      const body = node.children.find((c) => c.type === 'class_body');
      if (body) {
        for (const child of body.children) {
          walkNode(child, src, filePath, symbols, {
            className: ctx.className ?? 'Unknown',
            inCompanion: true,
          });
        }
      }
      break;
    }

    case 'type_alias': {
      const aliasVisibility = visibilityOf(node, src);
      if (aliasVisibility === 'private') break;
      const name = typeName(node, src);
      if (!name) break;
      const raw = nodeText(node, src).replace(/\s+/g, ' ');
      const sig = raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
      symbols.push({
        id: makeId(filePath, name, 'type'),
        name,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: `Kotlin typealias: ${name}`,
        frameworkMeta: withVisibility(undefined, aliasVisibility),
      });
      break;
    }

    case 'property_declaration': {
      // Only top-level `val` with an uppercase name → const
      if (ctx.className !== null) break;
      const bindingKind = childText(node, src, 'binding_pattern_kind');
      if (bindingKind !== 'val') break;
      const varDecl = node.children.find((c) => c.type === 'variable_declaration');
      if (!varDecl) break;
      const name = simpleName(varDecl, src);
      if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) break;
      const constVisibility = visibilityOf(node, src);
      if (constVisibility === 'private') break;
      const sig = buildPropertySignature(node, src);
      symbols.push({
        id: makeId(filePath, name, 'const'),
        name,
        kind: 'const',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: `Kotlin constant: ${name}`,
        frameworkMeta: withVisibility(undefined, constVisibility),
      });
      break;
    }

    default: {
      // Recurse into top-level nodes (source_file children)
      if (ctx.className === null) {
        for (const child of node.children) {
          walkNode(child, src, filePath, symbols, ctx);
        }
      }
      break;
    }
  }
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  for (const child of tree.rootNode.children) {
    walkNode(child, src, filePath, symbols, { className: null, inCompanion: false });
  }
  return symbols;
}

// ─── extractImports ───────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  function findImportHeaders(node: SyntaxNode): void {
    if (node.type === 'import_header') {
      // identifier child holds the full qualified name
      const identifierNode = node.children.find((c) => c.type === 'identifier');
      if (!identifierNode) return;
      const specifier = nodeText(identifierNode, src);
      const parts = specifier.split('.');
      const lastName = parts[parts.length - 1] ?? '';
      imports.push({
        sourceFile: '',
        specifier,
        resolvedPath: null,
        importedNames: lastName && lastName !== '*' ? [lastName] : [],
        isTypeOnly: false,
      });
    } else {
      for (const child of node.children) {
        findImportHeaders(child);
      }
    }
  }

  findImportHeaders(tree.rootNode);
  return imports;
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  // Check previous named sibling for KDoc or line comment
  let prev = node.previousNamedSibling;

  // Walk backward through consecutive line_comment nodes
  const lineComments: string[] = [];
  while (prev && prev.type === 'line_comment') {
    lineComments.unshift(prev.text.replace(/^\/\/\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }

  // Check if there's a KDoc multiline comment immediately before
  if (prev && prev.type === 'multiline_comment') {
    const raw = prev.text;
    if (raw.startsWith('/**')) {
      const body = raw
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .filter((line) => line.length > 0)
        .join(' ');
      return body || null;
    }
  }

  // Fall back to line comments
  if (lineComments.length > 0) {
    return lineComments.join(' ');
  }

  return null;
}

// ─── extractPackage ───────────────────────────────────────────────────────────

/**
 * Declared package of the file: `package com.example.foo` → "com.example.foo".
 * Kotlin does not require the package to match the directory layout, so this
 * is the authoritative source for JVM import resolution.
 */
function extractPackage(tree: Tree | null, source: Buffer): string | null {
  if (!tree) return null;
  const src = source.toString('utf8');
  for (const child of tree.rootNode.children) {
    if (child.type === 'package_header') {
      const identifierNode = child.children.find((c) => c.type === 'identifier');
      const pkg = identifierNode ? nodeText(identifierNode, src).trim() : '';
      return pkg.length > 0 ? pkg : null;
    }
  }
  return null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const kotlinHandler: LanguageHandler = {
  extensions: () => ['.kt', '.kts'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-kotlin.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
  extractPackage,
};
