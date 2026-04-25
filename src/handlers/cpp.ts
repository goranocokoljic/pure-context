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

function trunc(s: string, max = 120): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// ─── Declarator name extraction ───────────────────────────────────────────────

/**
 * Recursively unwrap C++ declarator nodes to find the innermost name.
 * Handles qualified identifiers, destructor names, operator names,
 * pointer/reference declarators, and function declarators.
 */
function extractDeclaratorName(declarator: SyntaxNode, src: string): string | null {
  switch (declarator.type) {
    case 'identifier':
    case 'field_identifier':
      return nodeText(declarator, src);

    case 'qualified_identifier':
      // Out-of-class definition like `Foo::bar` or `Foo::~Foo` — return full text
      return nodeText(declarator, src);

    case 'destructor_name':
      // `~Foo` — return as-is
      return nodeText(declarator, src);

    case 'operator_name':
      // `operator==`, `operator<<`, etc.
      return nodeText(declarator, src);

    case 'function_declarator': {
      for (const child of declarator.children) {
        if (child.type === 'parameter_list') continue;
        if (child.type === 'attribute_specifier') continue;
        if (child.type === 'ref_qualifier') continue;
        if (child.type === 'noexcept') continue;
        if (!child.isNamed) continue;
        const name = extractDeclaratorName(child, src);
        if (name) return name;
      }
      return null;
    }

    case 'pointer_declarator':
    case 'reference_declarator':
    case 'rvalue_reference_declarator':
    case 'parenthesized_declarator':
    case 'array_declarator':
    case 'field_declarator': {
      for (const child of declarator.children) {
        if (!child.isNamed) continue;
        const name = extractDeclaratorName(child, src);
        if (name) return name;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Walk the declarator tree to find the innermost `function_declarator` node.
 */
function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_declarator') return node;
  for (const child of node.children) {
    if (!child.isNamed) continue;
    const found = findFunctionDeclarator(child);
    if (found) return found;
  }
  return null;
}

// ─── Walk context ─────────────────────────────────────────────────────────────

interface WalkCtx {
  /** Current namespace qualification stack, e.g. ['Auth', 'Detail'] */
  nsStack: string[];
  /** Fully-qualified class name when inside a class body, null otherwise */
  className: string | null;
}

// ─── Signature builders ───────────────────────────────────────────────────────

/**
 * Build a function/method signature by slicing source from the start of the
 * function_definition to the end of its function_declarator (before the body).
 */
function buildFunctionSignature(node: SyntaxNode, src: string): string {
  const declaratorChild = node.children.find(
    (c) =>
      c.isNamed &&
      [
        'function_declarator',
        'pointer_declarator',
        'reference_declarator',
        'parenthesized_declarator',
      ].includes(c.type),
  );
  if (declaratorChild) {
    const funcDecl = findFunctionDeclarator(declaratorChild);
    if (funcDecl) {
      return trunc(src.slice(node.startIndex, funcDecl.endIndex));
    }
  }
  const body = node.children.find((c) => c.type === 'compound_statement');
  const end = body ? body.startIndex : node.endIndex;
  return trunc(src.slice(node.startIndex, end));
}

/**
 * Build a class/struct declaration signature including the optional base clause.
 */
function buildClassSignature(
  node: SyntaxNode,
  src: string,
  qualName: string,
  isStruct: boolean,
  templatePrefix: string | null,
): string {
  const keyword = isStruct ? 'struct' : 'class';
  let sig = `${keyword} ${qualName}`;

  const baseClause = node.children.find((c) => c.type === 'base_class_clause');
  if (baseClause) {
    sig += ` ${nodeText(baseClause, src).replace(/\s+/g, ' ').trim()}`;
  }

  if (templatePrefix) sig = `${templatePrefix} ${sig}`;
  return trunc(sig);
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  let prev = node.previousNamedSibling;

  // Collect consecutive // or /// (Doxygen) line comments
  const lineComments: string[] = [];
  while (prev && prev.type === 'comment') {
    const text = prev.text;
    if (!text.startsWith('//')) break;
    // Strip ///, // prefixes
    lineComments.unshift(text.replace(/^\/\/\/?\/?\s?/, '').trim());
    prev = prev.previousNamedSibling;
  }
  if (lineComments.length > 0) {
    const joined = lineComments.join(' ');
    const match = joined.match(/^([^.!?]*[.!?]?)/);
    return (match ? match[1]!.trim() : joined) || null;
  }

  // Block comment /* ... */ or /** ... */
  if (prev && prev.type === 'comment') {
    const text = prev.text;
    if (text.startsWith('/*')) {
      const inner = text
        .replace(/^\/\*+/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      if (!inner) return null;
      const match = inner.match(/^([^.!?]*[.!?]?)/);
      return (match ? match[1]!.trim() : inner) || null;
    }
  }

  return null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];
  const ctx: WalkCtx = { nsStack: [], className: null };
  walkNodes(tree.rootNode.children, ctx, filePath, src, symbols);
  return symbols;
}

function walkNodes(
  nodes: SyntaxNode[],
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  templatePrefix?: string,
): void {
  for (const node of nodes) {
    walkNode(node, ctx, filePath, src, symbols, templatePrefix);
  }
}

function walkNode(
  node: SyntaxNode,
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  templatePrefix?: string,
): void {
  switch (node.type) {

    // ── Preprocessor conditionals: recurse through ───────────────────────────
    case 'preproc_ifdef':
    case 'preproc_if':
    case 'preproc_else':
    case 'preproc_elif':
      walkNodes(node.children, ctx, filePath, src, symbols);
      break;

    // ── namespace_definition ─────────────────────────────────────────────────
    case 'namespace_definition': {
      // anonymous namespace: no name child → skip
      const nameNode = node.children.find(
        (c) => c.type === 'namespace_identifier' || (c.isNamed && c.type === 'identifier'),
      );
      if (!nameNode) break;

      const nsName = nodeText(nameNode, src);
      if (!nsName) break;

      const qualName =
        ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' + nsName : nsName;

      symbols.push({
        id: makeId(filePath, qualName, 'namespace'),
        name: qualName,
        kind: 'namespace',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`namespace ${nsName}`),
        summary: extractDocstring(node) ?? `C++ namespace: ${qualName}`,
      });

      // Recurse into body with updated namespace stack
      const bodyNode = node.children.find((c) => c.type === 'declaration_list');
      if (bodyNode) {
        const newCtx: WalkCtx = {
          nsStack: [...ctx.nsStack, nsName],
          className: null,
        };
        walkNodes(bodyNode.children, newCtx, filePath, src, symbols);
      }
      break;
    }

    // ── class_specifier ──────────────────────────────────────────────────────
    case 'class_specifier': {
      const nameNode = node.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) break; // anonymous class

      const localName = nodeText(nameNode, src);
      const bodyNode = node.children.find((c) => c.type === 'field_declaration_list');
      if (!bodyNode) break; // forward declaration

      const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
      const qualName = nsPart + localName;

      symbols.push({
        id: makeId(filePath, qualName, 'class'),
        name: qualName,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildClassSignature(node, src, qualName, false, templatePrefix ?? null),
        summary: extractDocstring(node) ?? `C++ class: ${qualName}`,
      });

      // Walk class body with private as default access
      walkClassBody(
        bodyNode,
        { nsStack: ctx.nsStack, className: qualName },
        filePath,
        src,
        symbols,
        false,
      );
      break;
    }

    // ── struct_specifier ─────────────────────────────────────────────────────
    case 'struct_specifier': {
      const nameNode = node.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) break;

      const localName = nodeText(nameNode, src);
      const bodyNode = node.children.find((c) => c.type === 'field_declaration_list');
      if (!bodyNode) break; // forward declaration

      const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
      const qualName = nsPart + localName;

      symbols.push({
        id: makeId(filePath, qualName, 'struct'),
        name: qualName,
        kind: 'struct',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildClassSignature(node, src, qualName, true, templatePrefix ?? null),
        summary: extractDocstring(node) ?? `C++ struct: ${qualName}`,
      });

      // Walk struct body with public as default access
      walkClassBody(
        bodyNode,
        { nsStack: ctx.nsStack, className: qualName },
        filePath,
        src,
        symbols,
        true,
      );
      break;
    }

    // ── enum_specifier ───────────────────────────────────────────────────────
    case 'enum_specifier': {
      const nameNode = node.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) break;

      const localName = nodeText(nameNode, src);
      const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
      const qualName = nsPart + localName;

      const enumeratorList = node.children.find((c) => c.type === 'enumerator_list');
      let sig: string;
      if (enumeratorList) {
        const vals = enumeratorList.children
          .filter((c) => c.isNamed && c.type === 'enumerator')
          .map((c) => {
            const id = c.children.find((cc) => cc.type === 'identifier');
            return id ? nodeText(id, src) : nodeText(c, src);
          });
        const shown = vals.slice(0, 3).join(', ');
        const suffix = vals.length > 3 ? ', ...' : '';
        sig = trunc(`enum ${qualName} { ${shown}${suffix} }`);
      } else {
        sig = trunc(`enum ${qualName}`);
      }

      symbols.push({
        id: makeId(filePath, qualName, 'enum'),
        name: qualName,
        kind: 'enum',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: extractDocstring(node) ?? `C++ enum: ${qualName}`,
      });
      break;
    }

    // ── template_declaration ─────────────────────────────────────────────────
    case 'template_declaration': {
      const tmplParams = node.children.find(
        (c) => c.type === 'template_parameter_list' || c.type === 'template_parameters',
      );
      if (!tmplParams) break;

      // Skip explicit template specializations: template<>
      const tmplParamText = nodeText(tmplParams, src);
      if (tmplParamText === '<>') break;

      const tmplPrefix = `template${tmplParamText}`;

      // Find the inner declaration to process
      const inner = node.children.find(
        (c) =>
          c.type === 'function_definition' ||
          c.type === 'class_specifier' ||
          c.type === 'struct_specifier' ||
          c.type === 'alias_declaration' ||
          c.type === 'declaration',
      );
      if (!inner) break;

      walkNode(inner, ctx, filePath, src, symbols, tmplPrefix);
      break;
    }

    // ── function_definition at namespace / global scope ──────────────────────
    case 'function_definition': {
      const declaratorChild = node.children.find(
        (c) =>
          c.isNamed &&
          [
            'function_declarator',
            'pointer_declarator',
            'reference_declarator',
            'parenthesized_declarator',
          ].includes(c.type),
      );
      if (!declaratorChild) break;

      const rawName = extractDeclaratorName(declaratorChild, src);
      if (!rawName) break;

      // If already qualified (e.g. out-of-class `Auth::AuthService::login`), use as-is
      const name = rawName.includes('::')
        ? rawName
        : ctx.nsStack.length > 0
          ? ctx.nsStack.join('::') + '::' + rawName
          : rawName;

      let sig = buildFunctionSignature(node, src);
      if (templatePrefix) sig = trunc(`${templatePrefix} ${sig}`);

      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: extractDocstring(node) ?? `C++ function: ${name}`,
      });
      break;
    }

    // ── alias_declaration: using Foo = Bar ───────────────────────────────────
    case 'alias_declaration': {
      // First named `type_identifier` child is the alias name
      const nameNode = node.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) break;

      const localName = nodeText(nameNode, src);
      const qualName =
        ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' + localName : localName;

      const raw = nodeText(node, src).replace(/\s+/g, ' ').trim();
      const sig = trunc(raw.endsWith(';') ? raw.slice(0, -1).trim() : raw);

      symbols.push({
        id: makeId(filePath, qualName, 'type'),
        name: qualName,
        kind: 'type',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: `C++ type alias: ${qualName}`,
      });
      break;
    }

    // ── preproc_def: object-like #define macros ──────────────────────────────
    case 'preproc_def': {
      const nameNode = node.children.find((c) => c.type === 'identifier');
      if (!nameNode) break;
      const macroName = nodeText(nameNode, src);

      const valueNode = node.children.find((c) => c.type === 'preproc_arg');
      if (!valueNode) break;
      const value = nodeText(valueNode, src).trim();
      if (!value) break; // skip header guards

      symbols.push({
        id: makeId(filePath, macroName, 'macro'),
        name: macroName,
        kind: 'macro',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`#define ${macroName} ${value}`),
        summary: `C++ macro: ${macroName}`,
      });
      break;
    }

    default:
      break;
  }
}

/**
 * Walk the body of a class or struct, tracking the current access level.
 * Emits methods (definitions and declarations), nested classes/structs.
 * Skips private members.
 *
 * @param isStruct  true → default access is public; false (class) → private
 */
function walkClassBody(
  bodyNode: SyntaxNode,
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  isStruct: boolean,
): void {
  let accessLevel: 'public' | 'private' | 'protected' = isStruct ? 'public' : 'private';

  for (const child of bodyNode.children) {
    // Update current access level on access specifier nodes
    if (child.type === 'access_specifier') {
      const text = nodeText(child, src);
      if (text.startsWith('public')) accessLevel = 'public';
      else if (text.startsWith('protected')) accessLevel = 'protected';
      else if (text.startsWith('private')) accessLevel = 'private';
      continue;
    }

    // Skip all private members
    if (accessLevel === 'private') continue;

    switch (child.type) {

      // Method definition (incl. constructor/destructor/operator overload)
      case 'function_definition':
        emitMethod(child, ctx, filePath, src, symbols, null);
        break;

      // Template method inside class body
      case 'template_declaration': {
        const tmplParams = child.children.find(
          (c) => c.type === 'template_parameter_list' || c.type === 'template_parameters',
        );
        const tmplParamText = tmplParams ? nodeText(tmplParams, src) : '';
        if (tmplParamText === '<>') break;

        const tmplPrefix = tmplParams ? `template${tmplParamText}` : null;
        const inner = child.children.find(
          (c) => c.type === 'function_definition',
        );
        if (inner) emitMethod(inner, ctx, filePath, src, symbols, tmplPrefix);
        break;
      }

      // Method declaration (no body) — e.g. in header files
      case 'declaration':
      case 'field_declaration': {
        // Only extract if it has a function declarator (method declaration, not data field)
        const hasFuncDecl = child.children.some(
          (c) =>
            c.isNamed &&
            (c.type === 'function_declarator' ||
              c.type === 'field_declarator' ||
              findFunctionDeclarator(c) !== null),
        );
        if (!hasFuncDecl) break;

        // Find the outermost declarator child
        const declaratorChild = child.children.find(
          (c) =>
            c.isNamed &&
            [
              'function_declarator',
              'pointer_declarator',
              'reference_declarator',
              'parenthesized_declarator',
              'field_declarator',
            ].includes(c.type),
        );
        if (!declaratorChild) break;

        const rawName = extractDeclaratorName(declaratorChild, src);
        if (!rawName) break;

        const methodName = ctx.className ? ctx.className + '::' + rawName : rawName;
        const declText = nodeText(child, src).replace(/;\s*$/, '').trim();

        symbols.push({
          id: makeId(filePath, methodName, 'method'),
          name: methodName,
          kind: 'method',
          filePath,
          startByte: child.startIndex,
          endByte: child.endIndex,
          signature: trunc(declText),
          summary: extractDocstring(child) ?? `C++ method: ${methodName}`,
        });
        break;
      }

      // Nested class definition
      case 'class_specifier': {
        const nameNode = child.children.find((c) => c.type === 'type_identifier');
        if (!nameNode) break;
        const nestedName = nodeText(nameNode, src);
        const nestedQualName = ctx.className
          ? ctx.className + '::' + nestedName
          : (ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '') + nestedName;

        const nestedBody = child.children.find((c) => c.type === 'field_declaration_list');
        if (!nestedBody) break;

        symbols.push({
          id: makeId(filePath, nestedQualName, 'class'),
          name: nestedQualName,
          kind: 'class',
          filePath,
          startByte: child.startIndex,
          endByte: child.endIndex,
          signature: buildClassSignature(child, src, nestedQualName, false, null),
          summary: extractDocstring(child) ?? `C++ class: ${nestedQualName}`,
        });

        walkClassBody(
          nestedBody,
          { nsStack: ctx.nsStack, className: nestedQualName },
          filePath,
          src,
          symbols,
          false,
        );
        break;
      }

      // Nested struct definition
      case 'struct_specifier': {
        const nameNode = child.children.find((c) => c.type === 'type_identifier');
        if (!nameNode) break;
        const nestedName = nodeText(nameNode, src);
        const nestedQualName = ctx.className
          ? ctx.className + '::' + nestedName
          : (ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '') + nestedName;

        const nestedBody = child.children.find((c) => c.type === 'field_declaration_list');
        if (!nestedBody) break;

        symbols.push({
          id: makeId(filePath, nestedQualName, 'struct'),
          name: nestedQualName,
          kind: 'struct',
          filePath,
          startByte: child.startIndex,
          endByte: child.endIndex,
          signature: buildClassSignature(child, src, nestedQualName, true, null),
          summary: extractDocstring(child) ?? `C++ struct: ${nestedQualName}`,
        });

        walkClassBody(
          nestedBody,
          { nsStack: ctx.nsStack, className: nestedQualName },
          filePath,
          src,
          symbols,
          true,
        );
        break;
      }

      default:
        break;
    }
  }
}

/**
 * Emit a method symbol from a function_definition inside a class body.
 * Handles regular methods, constructors, destructors, and operator overloads.
 */
function emitMethod(
  node: SyntaxNode,
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  templatePrefix: string | null,
): void {
  const declaratorChild = node.children.find(
    (c) =>
      c.isNamed &&
      [
        'function_declarator',
        'pointer_declarator',
        'reference_declarator',
        'parenthesized_declarator',
      ].includes(c.type),
  );
  if (!declaratorChild) return;

  const rawName = extractDeclaratorName(declaratorChild, src);
  if (!rawName) return;

  const methodName = ctx.className ? ctx.className + '::' + rawName : rawName;

  let sig = buildFunctionSignature(node, src);
  if (templatePrefix) sig = trunc(`${templatePrefix} ${sig}`);

  symbols.push({
    id: makeId(filePath, methodName, 'method'),
    name: methodName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: sig,
    summary: extractDocstring(node) ?? `C++ method: ${methodName}`,
  });
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  collectImportNodes(tree.rootNode.children, src, imports);
  return imports;
}

function collectImportNodes(
  nodes: SyntaxNode[],
  src: string,
  imports: ImportRecord[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      // ── #include ────────────────────────────────────────────────────────────
      case 'preproc_include': {
        const pathNode = node.children.find(
          (c) => c.type === 'string_literal' || c.type === 'system_lib_string',
        );
        if (!pathNode) break;

        const raw = nodeText(pathNode, src);
        const isSystem = pathNode.type === 'system_lib_string';
        const specifier = raw.slice(1, -1); // strip < > or " "

        imports.push({
          sourceFile: '',
          specifier,
          resolvedPath: isSystem ? null : specifier,
          importedNames: [],
          isTypeOnly: false,
        });
        break;
      }

      // ── using std::vector  OR  using namespace std ──────────────────────
      // In tree-sitter-cpp both forms parse as `using_declaration`.
      // The namespace-directive form has a `namespace` keyword child.
      case 'using_declaration': {
        // Detect `using namespace Foo` by presence of a `namespace` keyword child
        const isNamespaceDirective = node.children.some(
          (c) => !c.isNamed && c.type === 'namespace',
        );

        const nameNode = node.children.find(
          (c) =>
            c.isNamed &&
            (c.type === 'qualified_identifier' ||
              c.type === 'namespace_identifier' ||
              c.type === 'identifier'),
        );
        if (!nameNode) break;

        const specifier = nodeText(nameNode, src);

        if (isNamespaceDirective) {
          // `using namespace std;` — no specific names imported
          imports.push({
            sourceFile: '',
            specifier,
            resolvedPath: null,
            importedNames: [],
            isTypeOnly: false,
          });
        } else {
          // `using std::vector;` — the imported name is the last segment
          const parts = specifier.split('::');
          const importedName = parts[parts.length - 1] ?? specifier;
          imports.push({
            sourceFile: '',
            specifier,
            resolvedPath: null,
            importedNames: importedName ? [importedName] : [],
            isTypeOnly: false,
          });
        }
        break;
      }

      // tree-sitter-cpp doesn't emit a separate `using_directive` node,
      // but handle it defensively in case grammar versions differ.
      case 'using_directive': {
        const nameNode = node.children.find(
          (c) =>
            c.isNamed &&
            (c.type === 'namespace_identifier' ||
              c.type === 'qualified_identifier' ||
              c.type === 'identifier'),
        );
        if (!nameNode) break;
        imports.push({
          sourceFile: '',
          specifier: nodeText(nameNode, src),
          resolvedPath: null,
          importedNames: [],
          isTypeOnly: false,
        });
        break;
      }

      // Recurse through preprocessor conditionals
      case 'preproc_ifdef':
      case 'preproc_if':
      case 'preproc_else':
      case 'preproc_elif':
      case 'namespace_definition':
      case 'declaration_list':
        collectImportNodes(node.children, src, imports);
        break;

      default:
        break;
    }
  }
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const cppHandler: LanguageHandler = {
  extensions: () => ['.cpp', '.cxx', '.cc', '.c++', '.hpp', '.hxx', '.hh', '.h++'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-cpp.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
