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

function isPrivate(name: string): boolean {
  return name.startsWith('_');
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  const prev = node.previousNamedSibling;
  if (!prev) return null;

  // Dart triple-slash doc comments or block /** */ comments
  if (prev.type === 'documentation_comment' || prev.type === 'comment') {
    const raw = prev.text;

    // Block comment /** ... */
    if (raw.startsWith('/**')) {
      const inner = raw
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      const match = inner.match(/^([^.!?]*[.!?]?)/);
      return (match ? match[1]!.trim() : inner) || null;
    }

    // Triple-slash lines: collect consecutive /// lines from the prev chain
    const lines: string[] = [];
    let cur: SyntaxNode | null = prev;
    while (cur && (cur.type === 'documentation_comment' || cur.type === 'comment')) {
      const t = cur.text;
      if (!t.startsWith('///') && !t.startsWith('//')) break;
      lines.unshift(t.replace(/^\/\/\/?\s?/, '').trim());
      cur = cur.previousNamedSibling;
    }
    if (lines.length === 0) return null;
    const joined = lines.join(' ');
    const match = joined.match(/^([^.!?]*[.!?]?)/);
    return (match ? match[1]!.trim() : joined) || null;
  }

  return null;
}

// ─── Signature helpers ────────────────────────────────────────────────────────

/**
 * Get the formal parameter list text for a node that has a
 * `formal_parameter_list` child, or '()' if absent.
 */
function paramsText(node: SyntaxNode, src: string): string {
  const p = node.children.find((c) => c.isNamed && c.type === 'formal_parameter_list');
  return p ? nodeText(p, src) : '()';
}

/**
 * Extract the identifier name from a function_signature, getter_signature,
 * setter_signature, or operator_signature node.
 * Returns null if the name starts with '_' or cannot be found.
 */
function nameFromSig(sigNode: SyntaxNode, src: string): string | null {
  switch (sigNode.type) {
    case 'function_signature':
    case 'getter_signature':
    case 'setter_signature': {
      const id = sigNode.children.find((c) => c.isNamed && c.type === 'identifier');
      if (!id) return null;
      return nodeText(id, src);
    }
    case 'operator_signature': {
      // Extract operator symbol from signature text: "bool operator ==(Object other)"
      const text = nodeText(sigNode, src);
      const m = text.match(/\boperator\s+([\[\]=+\-*/<>!&|^~%]+|\[\])/);
      return m ? `operator${m[1]}` : null;
    }
    default:
      return null;
  }
}

/**
 * Build a one-line method signature from a method_signature node.
 * Preserves static/async modifiers found in the outer text.
 */
function buildMethodSig(
  methodSigNode: SyntaxNode,
  innerSig: SyntaxNode,
  src: string,
): string {
  const fullText = nodeText(methodSigNode, src);
  const isStatic = /\bstatic\b/.test(fullText);
  const sigText = nodeText(innerSig, src);
  return trunc(isStatic ? `static ${sigText}` : sigText);
}

// ─── Class / mixin body extraction ───────────────────────────────────────────

function extractClassBody(
  bodyNode: SyntaxNode,
  className: string,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const child of bodyNode.children) {
    if (!child.isNamed) continue;

    switch (child.type) {
      case 'declaration':
        extractDeclarationMember(child, className, src, filePath, symbols);
        break;

      case 'method_signature':
        extractMethod(child, className, src, filePath, symbols);
        break;

      // function_body follows method_signature as a sibling — skip here
      case 'function_body':
      case 'documentation_comment':
      case 'comment':
      case 'marker_annotation':
      case 'annotation':
      case 'static_final_declaration_list':
        break;

      default:
        break;
    }
  }
}

/**
 * Handle a `declaration` child of a class body.
 * Declarations contain constructors, fields, and other class members.
 */
function extractDeclarationMember(
  declNode: SyntaxNode,
  className: string,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // Constructor: constructor_signature or constant_constructor_signature
  const ctorSig = declNode.children.find(
    (c) =>
      c.isNamed &&
      (c.type === 'constructor_signature' || c.type === 'constant_constructor_signature'),
  );
  if (ctorSig) {
    extractConstructor(ctorSig, declNode, className, src, filePath, symbols);
  }
  // Fields (initialized_identifier_list, etc.) — not emitted as symbols
}

function extractConstructor(
  ctorNode: SyntaxNode,
  parentDecl: SyntaxNode,
  className: string,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  let symbolName: string;
  let sig: string;

  if (ctorNode.type === 'constant_constructor_signature') {
    // const ClassName(params) or const ClassName.named(params)
    // Name is in `qualified` child: text could be "ClassName" or "ClassName.named"
    const qualified = ctorNode.children.find((c) => c.isNamed && c.type === 'qualified');
    const nameText = qualified ? nodeText(qualified, src) : className;
    if (nameText.startsWith('_') || nameText.includes('._')) return;

    // For ClassName.namedCtor, symbolName = ClassName.namedCtor
    // For plain ClassName, symbolName = ClassName.ClassName
    symbolName = nameText.includes('.') ? nameText : `${className}.${className}`;
    const params = paramsText(ctorNode, src);
    sig = trunc(`const ${nameText}${params}`);
  } else {
    // constructor_signature: ClassName or ClassName.namedCtor
    const identifiers = ctorNode.children.filter(
      (c) => c.isNamed && c.type === 'identifier',
    );
    if (identifiers.length === 0) return;

    const classIdText = nodeText(identifiers[0]!, src);
    if (classIdText.startsWith('_')) return;

    if (identifiers.length >= 2) {
      const namedPart = nodeText(identifiers[1]!, src);
      if (namedPart.startsWith('_')) return;
      symbolName = `${className}.${namedPart}`;
    } else {
      symbolName = `${className}.${className}`;
    }

    const params = paramsText(ctorNode, src);
    sig = trunc(`${symbolName}${params}`);
  }

  symbols.push({
    id: makeId(filePath, symbolName, 'method'),
    name: symbolName,
    kind: 'method',
    filePath,
    startByte: parentDecl.startIndex,
    endByte: parentDecl.endIndex,
    signature: sig,
    summary: extractDocstring(parentDecl) ?? `Constructor: ${symbolName}`,
  });
}

function extractMethod(
  methodSigNode: SyntaxNode,
  className: string,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // method_signature wraps: function_signature | getter_signature | setter_signature
  //                         | factory_constructor_signature | operator_signature
  const inner = methodSigNode.children.find((c) => c.isNamed);
  if (!inner) return;

  switch (inner.type) {
    case 'function_signature':
    case 'getter_signature':
    case 'setter_signature': {
      const rawName = nameFromSig(inner, src);
      if (!rawName || isPrivate(rawName)) return;
      const symbolName = `${className}.${rawName}`;
      const sig = buildMethodSig(methodSigNode, inner, src);

      symbols.push({
        id: makeId(filePath, symbolName, 'method'),
        name: symbolName,
        kind: 'method',
        filePath,
        startByte: methodSigNode.startIndex,
        endByte: methodSigNode.endIndex,
        signature: sig,
        summary: extractDocstring(methodSigNode) ?? `Method: ${symbolName}`,
      });
      break;
    }

    case 'factory_constructor_signature': {
      // factory ClassName.name(params) or factory ClassName(params)
      const identifiers = inner.children.filter(
        (c) => c.isNamed && c.type === 'identifier',
      );
      if (identifiers.length === 0) return;
      const classId = nodeText(identifiers[0]!, src);
      if (classId.startsWith('_')) return;

      let symbolName: string;
      if (identifiers.length >= 2) {
        const factoryName = nodeText(identifiers[1]!, src);
        if (factoryName.startsWith('_')) return;
        symbolName = `${className}.${factoryName}`;
      } else {
        symbolName = `${className}.${className}`;
      }

      const params = paramsText(inner, src);
      const sig = trunc(`factory ${symbolName}${params}`);

      symbols.push({
        id: makeId(filePath, symbolName, 'method'),
        name: symbolName,
        kind: 'method',
        filePath,
        startByte: methodSigNode.startIndex,
        endByte: methodSigNode.endIndex,
        signature: sig,
        summary: extractDocstring(methodSigNode) ?? `Factory constructor: ${symbolName}`,
      });
      break;
    }

    case 'operator_signature': {
      const rawName = nameFromSig(inner, src);
      if (!rawName) return;
      const symbolName = `${className}.${rawName}`;
      const sig = buildMethodSig(methodSigNode, inner, src);

      symbols.push({
        id: makeId(filePath, symbolName, 'method'),
        name: symbolName,
        kind: 'method',
        filePath,
        startByte: methodSigNode.startIndex,
        endByte: methodSigNode.endIndex,
        signature: sig,
        summary: `Operator: ${symbolName}`,
      });
      break;
    }

    default:
      break;
  }
}

// ─── Top-level type extractors ────────────────────────────────────────────────

function extractClass(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // class_definition: identifier + superclass/implements/with clauses + class_body
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
  if (!nameNode) return;
  const className = nodeText(nameNode, src);
  if (isPrivate(className)) return;

  // Build signature: "class Name [extends Base] [implements I1, I2] [with M1]"
  const classText = nodeText(node, src);
  // Extract just the declaration line (up to first '{')
  const declLine = classText.split('{')[0]?.trim() ?? `class ${className}`;
  const sig = trunc(declLine);

  symbols.push({
    id: makeId(filePath, className, 'class'),
    name: className,
    kind: 'class',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Dart class: ${className}`,
  });

  // Recurse into class body
  const body = node.children.find((c) => c.isNamed && c.type === 'class_body');
  if (body) {
    extractClassBody(body, className, src, filePath, symbols);
  }
}

function extractMixin(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
  if (!nameNode) return;
  const name = nodeText(nameNode, src);
  if (isPrivate(name)) return;

  const declLine = nodeText(node, src).split('{')[0]?.trim() ?? `mixin ${name}`;

  symbols.push({
    id: makeId(filePath, name, 'class'),
    name,
    kind: 'class',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: trunc(declLine),
    summary: extractDocstring(node) ?? `Dart mixin: ${name}`,
    frameworkMeta: { dart_mixin: true },
  });

  const body = node.children.find((c) => c.isNamed && c.type === 'class_body');
  if (body) extractClassBody(body, name, src, filePath, symbols);
}

function extractExtension(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // extension_declaration: optional identifier + 'on' + type_identifier + extension_body
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
  const extendedTypeNode = node.children.find(
    (c) => c.isNamed && c.type === 'type_identifier',
  );

  const extendedType = extendedTypeNode ? nodeText(extendedTypeNode, src) : 'unknown';
  const name = nameNode ? nodeText(nameNode, src) : `<anonymous extension>`;
  const symbolName = nameNode ? name : `Extension:${extendedType}`;

  if (nameNode && isPrivate(name)) return;

  const declLine = nodeText(node, src).split('{')[0]?.trim() ?? `extension ${symbolName}`;

  symbols.push({
    id: makeId(filePath, symbolName, 'class'),
    name: symbolName,
    kind: 'class',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: trunc(declLine),
    summary: extractDocstring(node) ?? `Dart extension: ${symbolName}`,
    frameworkMeta: { dart_extension: true },
  });

  const body = node.children.find((c) => c.isNamed && c.type === 'extension_body');
  if (body) extractClassBody(body, symbolName, src, filePath, symbols);
}

function extractEnum(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
  if (!nameNode) return;
  const name = nodeText(nameNode, src);
  if (isPrivate(name)) return;

  // Build signature: "enum Name { val1, val2, val3, ... }"
  const body = node.children.find((c) => c.isNamed && c.type === 'enum_body');
  let sig: string;
  if (body) {
    const values = body.children
      .filter((c) => c.isNamed && c.type === 'enum_constant')
      .slice(0, 3)
      .map((c) => {
        const id = c.children.find((cc) => cc.isNamed && cc.type === 'identifier');
        return id ? nodeText(id, src) : c.text;
      });
    const more = body.children.filter((c) => c.isNamed && c.type === 'enum_constant').length > 3 ? ', ...' : '';
    sig = trunc(`enum ${name} { ${values.join(', ')}${more} }`);
  } else {
    sig = `enum ${name}`;
  }

  symbols.push({
    id: makeId(filePath, name, 'enum'),
    name,
    kind: 'enum',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Dart enum: ${name}`,
  });
}

function extractTypeAlias(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // type_alias: type_identifier (name) + rhs
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'type_identifier');
  if (!nameNode) return;
  const name = nodeText(nameNode, src);
  if (isPrivate(name)) return;

  const sig = trunc(nodeText(node, src));

  symbols.push({
    id: makeId(filePath, name, 'type'),
    name,
    kind: 'type',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Dart typedef: ${name}`,
  });
}

function extractTopLevelConst(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // static_final_declaration_list must be preceded by const_builtin or final_builtin
  // Pattern: const_builtin → type_identifier → static_final_declaration_list
  //       or final_builtin → type_identifier → static_final_declaration_list
  const prev = node.previousNamedSibling;
  if (!prev) return;

  let isConst = false;
  let isFinal = false;
  let typeStr = '';

  if (prev.type === 'type_identifier') {
    typeStr = nodeText(prev, src);
    const prevPrev = prev.previousNamedSibling;
    if (prevPrev?.type === 'const_builtin') isConst = true;
    else if (prevPrev?.type === 'final_builtin') isFinal = true;
  } else if (prev.type === 'const_builtin') {
    isConst = true;
  } else if (prev.type === 'final_builtin') {
    isFinal = true;
  }

  if (!isConst && !isFinal) return;

  const keyword = isConst ? 'const' : 'final';

  for (const decl of node.children) {
    if (!decl.isNamed || decl.type !== 'static_final_declaration') continue;

    const nameNode = decl.children.find((c) => c.isNamed && c.type === 'identifier');
    if (!nameNode) continue;
    const name = nodeText(nameNode, src);
    if (isPrivate(name)) continue;

    const typePart = typeStr ? ` ${typeStr}` : '';
    const sig = trunc(`${keyword}${typePart} ${name} = ...`);

    symbols.push({
      id: makeId(filePath, name, 'const'),
      name,
      kind: 'const',
      filePath,
      startByte: node.startIndex,
      endByte: node.endIndex,
      signature: sig,
      summary: extractDocstring(node) ?? `Dart constant: ${name}`,
    });
  }
}

function extractTopLevelFunction(
  node: SyntaxNode,
  src: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // A top-level function_signature is a real function only if followed by function_body
  const next = node.nextNamedSibling;
  if (!next || next.type !== 'function_body') return;

  let name: string;
  if (node.type === 'function_signature') {
    const id = node.children.find((c) => c.isNamed && c.type === 'identifier');
    if (!id) return;
    name = nodeText(id, src);
  } else if (node.type === 'getter_signature' || node.type === 'setter_signature') {
    const id = node.children.find((c) => c.isNamed && c.type === 'identifier');
    if (!id) return;
    name = nodeText(id, src);
  } else {
    return;
  }

  if (isPrivate(name)) return;

  // Check if function_body is async
  const bodyText = nodeText(next, src);
  const isAsync = bodyText.trimStart().startsWith('async');

  const sigBase = nodeText(node, src);
  const sig = trunc(isAsync ? `async ${sigBase}` : sigBase);

  symbols.push({
    id: makeId(filePath, name, 'function'),
    name,
    kind: 'function',
    filePath,
    startByte: node.startIndex,
    endByte: next.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `Dart function: ${name}`,
  });
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed) continue;

    switch (node.type) {
      case 'static_final_declaration_list':
        extractTopLevelConst(node, src, filePath, symbols);
        break;

      case 'class_definition':
        extractClass(node, src, filePath, symbols);
        break;

      case 'mixin_declaration':
        extractMixin(node, src, filePath, symbols);
        break;

      case 'extension_declaration':
        extractExtension(node, src, filePath, symbols);
        break;

      case 'enum_declaration':
        extractEnum(node, src, filePath, symbols);
        break;

      case 'type_alias':
        extractTypeAlias(node, src, filePath, symbols);
        break;

      case 'function_signature':
      case 'getter_signature':
      case 'setter_signature':
        extractTopLevelFunction(node, src, filePath, symbols);
        break;

      default:
        break;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Resolve a Dart import URI to a relative file path.
 * - Relative paths (../foo.dart) → preserve as-is
 * - package: and dart: URIs → null (external)
 */
function resolveImportPath(uri: string): string | null {
  if (uri.startsWith('dart:') || uri.startsWith('package:')) return null;
  if (uri.startsWith('.')) {
    // Already relative — return as-is; the graph builder resolves it relative to the source file
    return uri;
  }
  return null;
}

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed || node.type !== 'import_or_export') continue;

    // import_or_export → library_import → import_specification
    const libImport = node.children.find((c) => c.isNamed && c.type === 'library_import');
    if (!libImport) continue;

    const importSpec = libImport.children.find(
      (c) => c.isNamed && c.type === 'import_specification',
    );
    if (!importSpec) continue;

    // URI: configurable_uri → uri → string_literal
    const configUri = importSpec.children.find(
      (c) => c.isNamed && c.type === 'configurable_uri',
    );
    if (!configUri) continue;

    const uriNode = configUri.children.find((c) => c.isNamed && c.type === 'uri');
    if (!uriNode) continue;

    const strLit = uriNode.children.find((c) => c.isNamed && c.type === 'string_literal');
    if (!strLit) continue;

    // Strip surrounding quotes
    const rawUri = nodeText(strLit, src);
    const uri = rawUri.slice(1, -1); // remove ' or " delimiters

    // 'show' clause: combinator → identifier children
    const combinator = importSpec.children.find(
      (c) => c.isNamed && c.type === 'combinator',
    );
    const importedNames = combinator
      ? combinator.children
          .filter((c) => c.isNamed && c.type === 'identifier')
          .map((c) => nodeText(c, src))
      : [];

    imports.push({
      sourceFile: '',
      specifier: uri,
      resolvedPath: resolveImportPath(uri),
      importedNames,
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const dartHandler: LanguageHandler = {
  extensions: () => ['.dart'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-dart.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
