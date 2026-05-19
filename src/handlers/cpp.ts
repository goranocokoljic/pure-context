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

// ─── Body snippet ─────────────────────────────────────────────────────────────

/**
 * Extract a short text snippet from a class/struct body or function body.
 * Normalises whitespace and caps at 200 characters.
 */
function extractBodySnippet(bodyNode: SyntaxNode, src: string): string {
  // Skip the opening '{' (+1 char); grab up to 600 raw chars
  const start = bodyNode.startIndex + 1;
  const end = Math.min(start + 600, bodyNode.endIndex - 1);
  if (start >= end) return '';
  return src
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ─── Declarator name extraction ───────────────────────────────────────────────

/**
 * Strip template arguments from a qualified identifier scope part.
 * Handles: `Scene<Float, Spectrum>::render` → `Scene::render`
 *          `Outer::Inner<T>::method`        → `Outer::Inner::method`
 *          `Foo::bar`                       → `Foo::bar` (unchanged)
 */
function stripTemplateArgsFromQualified(node: SyntaxNode, src: string): string {
  // template_type like `Scene<Float, Spectrum>` → return just the base name
  if (node.type === 'template_type') {
    const nameNode = node.children.find(
      (c) => c.isNamed && (c.type === 'type_identifier' || c.type === 'namespace_identifier'),
    );
    return nameNode ? nodeText(nameNode, src) : nodeText(node, src);
  }

  // qualified_identifier: recurse to strip template args at each scope level
  if (node.type === 'qualified_identifier') {
    // Find the '::' separator (first unnamed '::' child)
    const dcolonIdx = node.children.findIndex(
      (c) => !c.isNamed && nodeText(c, src) === '::',
    );
    if (dcolonIdx < 0) return nodeText(node, src);

    // Scope is the last named child before '::'
    const scopeChild = node.children.slice(0, dcolonIdx).findLast((c) => c.isNamed);
    // Name is the first named child after '::'
    const nameChild = node.children.slice(dcolonIdx + 1).find((c) => c.isNamed);

    const scope = scopeChild ? stripTemplateArgsFromQualified(scopeChild, src) : '';
    // Also recurse on the name part to handle template_type / qualified_identifier names
    const name = nameChild ? stripTemplateArgsFromQualified(nameChild, src) : '';
    return scope ? `${scope}::${name}` : name;
  }

  return nodeText(node, src);
}

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
      // Out-of-class definition like `Foo::bar`, `Foo::~Foo`, or
      // `Scene<Float, Spectrum>::render` — strip template args from scope parts.
      return stripTemplateArgsFromQualified(declarator, src);

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
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i]!;

    // ── Detect sibling-level class/struct declaration (NAMESPACE_BEGIN pattern) ──
    // When NAMESPACE_BEGIN macros (or other constructs) prevent proper parsing,
    // tree-sitter may scatter the class declaration across consecutive sibling nodes:
    //   [i]   class_specifier (no field_declaration_list body — e.g. "class MI_EXPORT_LIB")
    //   [i+1] ERROR            (contains the class name as first identifier/type_identifier)
    //   [i+k] {                (opening brace)
    //   [i+k+1..j-1] body children
    //   [j]   }                (closing brace)
    //
    // This fires only when the class_specifier has no body (otherwise walkNode handles it).
    if (
      (node.type === 'class_specifier' || node.type === 'struct_specifier') &&
      !node.children.some((c) => c.type === 'field_declaration_list')
    ) {
      const nextSib = nodes[i + 1];
      if (nextSib && nextSib.type === 'ERROR') {
        const nameIdent = nextSib.children.find(
          (c) => c.isNamed && (c.type === 'identifier' || c.type === 'type_identifier'),
        );
        const localName = nameIdent ? nodeText(nameIdent, src) : null;
        if (localName && localName !== 'final' && localName !== 'override') {
          // Find the opening brace in subsequent siblings (skipping base-class / template args)
          let braceAbsIdx = -1;
          for (let j = i + 2; j < nodes.length && j < i + 10; j++) {
            if (nodes[j]!.type === '{') { braceAbsIdx = j; break; }
          }
          if (braceAbsIdx >= 0) {
            const isStruct = node.type === 'struct_specifier';
            // Find closing brace
            let closeAbsIdx = nodes.length;
            for (let j = braceAbsIdx + 1; j < nodes.length; j++) {
              if (nodes[j]!.type === '}') { closeAbsIdx = j; break; }
            }
            const bodyChildren = nodes.slice(braceAbsIdx + 1, closeAbsIdx);

            // Body snippet
            const braceNode = nodes[braceAbsIdx]!;
            const closeNode = closeAbsIdx < nodes.length ? nodes[closeAbsIdx]! : null;
            const bodyRaw = src.slice(
              braceNode.endIndex,
              Math.min(braceNode.endIndex + 600, closeNode ? closeNode.startIndex : node.endIndex),
            );
            const bodySnippet = bodyRaw.replace(/\s+/g, ' ').trim().slice(0, 200);

            const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
            const qualName = nsPart + localName;
            const kind: SymbolKind = isStruct ? 'struct' : 'class';

            // Look back for template_parameter_list among preceding siblings
            const tmplParamsNode = nodes.slice(0, i).findLast(
              (c) => c.type === 'template_parameter_list',
            );
            const tmplParamText = tmplParamsNode ? nodeText(tmplParamsNode, src) : '';
            const tmplPrefixLocal = tmplParamText
              ? `template${tmplParamText}`
              : (templatePrefix ?? null);

            let sig = `${isStruct ? 'struct' : 'class'} ${qualName}`;
            if (tmplPrefixLocal) sig = `${tmplPrefixLocal} ${sig}`;

            symbols.push({
              id: makeId(filePath, qualName, kind),
              name: qualName,
              kind,
              filePath,
              startByte: node.startIndex,
              endByte: closeNode ? closeNode.endIndex : node.endIndex,
              signature: trunc(sig),
              summary: extractDocstring(node) ?? `C++ ${kind}: ${qualName}`,
              ...(bodySnippet ? { bodySnippet } : {}),
            });

            walkErrorClassBody(
              bodyChildren,
              { nsStack: ctx.nsStack, className: qualName },
              filePath,
              src,
              symbols,
              isStruct,
            );

            // Advance past all consumed siblings (ERROR, template_function, {, body, })
            i = closeAbsIdx + 1;
            continue;
          }
        }
      }
    }

    walkNode(node, ctx, filePath, src, symbols, templatePrefix);
    i++;
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
      // Use the LAST type_identifier before the base clause or body.
      // This handles `class MI_EXPORT_LIB ClassName` patterns correctly —
      // the export macro appears as the first type_identifier, the real name last.
      let nameNode: SyntaxNode | undefined;
      for (const child of node.children) {
        if (child.type === 'base_class_clause' || child.type === 'field_declaration_list') break;
        if (child.type === 'type_identifier') nameNode = child;
      }
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
        bodySnippet: extractBodySnippet(bodyNode, src),
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
      // Use the LAST type_identifier before the base clause or body.
      // Handles `struct MI_EXPORT_LIB StructName` patterns correctly.
      let nameNode: SyntaxNode | undefined;
      for (const child of node.children) {
        if (child.type === 'base_class_clause' || child.type === 'field_declaration_list') break;
        if (child.type === 'type_identifier') nameNode = child;
      }
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
        bodySnippet: extractBodySnippet(bodyNode, src),
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
      // ── Detect `class/struct MACRO ClassName [: Base] { ... }` misparse ───
      // tree-sitter-cpp misparsed these as function_definition where the
      // "return type" is class_specifier(MACRO) and body is compound_statement.
      // e.g. `class MI_EXPORT_LIB Scene : public Base { ... }`.
      const exportMacroType = node.children.find(
        (c) => c.isNamed && (c.type === 'class_specifier' || c.type === 'struct_specifier'),
      );
      if (exportMacroType) {
        const isStruct = exportMacroType.type === 'struct_specifier';
        const typeIdx = node.children.indexOf(exportMacroType);

        // Find real class name: identifier after specifier, or inside ERROR node
        let localName: string | null = null;
        for (let i = typeIdx + 1; i < node.children.length; i++) {
          const c = node.children[i]!;
          if (c.type === 'compound_statement') break; // hit the body
          if (c.isNamed && c.type === 'identifier') {
            localName = nodeText(c, src);
            break;
          }
          if (c.type === 'ERROR') {
            // Class name lands in ERROR when there's a base-class clause after it
            const inner = c.children.find((ec) => ec.isNamed && ec.type === 'identifier');
            if (inner) { localName = nodeText(inner, src); break; }
          }
        }
        // Guard: if no class name found, this is NOT an export macro class —
        // it's a regular C function whose return type happens to be a
        // struct/class specifier (e.g. `struct AP_info *get_ap_info(...)`).
        // Fall through to the normal function_definition extraction below.
        if (localName) {
          const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
          const qualName = nsPart + localName;
          const kind: SymbolKind = isStruct ? 'struct' : 'class';
          const keyword = isStruct ? 'struct' : 'class';
          let sig = `${keyword} ${qualName}`;
          if (templatePrefix) sig = trunc(`${templatePrefix} ${sig}`);

          const body = node.children.find((c) => c.type === 'compound_statement');
          symbols.push({
            id: makeId(filePath, qualName, kind),
            name: qualName,
            kind,
            filePath,
            startByte: node.startIndex,
            endByte: node.endIndex,
            signature: trunc(sig),
            summary: extractDocstring(node) ?? `C++ ${kind}: ${qualName}`,
            ...(body ? { bodySnippet: extractBodySnippet(body, src) } : {}),
          });

          // Walk the compound_statement to extract public method declarations
          if (body) {
            walkExportMacroClassBody(
              body,
              { nsStack: ctx.nsStack, className: qualName },
              filePath,
              src,
              symbols,
              isStruct,
            );
          }
          break;
        }
        // localName was null → fall through to normal function extraction
      }

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

    // ── type_definition: C-style typedef struct/enum/union ───────────────────
    // Handles: typedef struct { ... } Name; and typedef enum { ... } Name;
    // Important for C headers (.h) included in C++ projects.
    case 'type_definition': {
      const typeChild = node.children.find(
        (c) => c.isNamed && (
          c.type === 'struct_specifier' ||
          c.type === 'union_specifier' ||
          c.type === 'enum_specifier'
        ),
      );
      if (!typeChild) break;

      // The typedef alias is the last type_identifier child of the type_definition
      // (not inside the type specifier), e.g. `typedef struct { ... } AuthSession;`
      const declaratorNode = node.children.findLast(
        (c) => c.type === 'type_identifier',
      );
      if (!declaratorNode) break;

      const alias = nodeText(declaratorNode, src);
      const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
      const qualName = nsPart + alias;

      if (typeChild.type === 'enum_specifier') {
        const enumeratorList = typeChild.children.find((c) => c.type === 'enumerator_list');
        let sig: string;
        if (enumeratorList) {
          const vals = enumeratorList.children
            .filter((c) => c.isNamed && c.type === 'enumerator')
            .slice(0, 3)
            .map((c) => {
              const id = c.children.find((cc) => cc.type === 'identifier');
              return id ? nodeText(id, src) : nodeText(c, src);
            });
          const suffix = enumeratorList.children.filter((c) => c.isNamed && c.type === 'enumerator').length > 3 ? ', ...' : '';
          sig = trunc(`typedef enum ${alias} { ${vals.join(', ')}${suffix} }`);
        } else {
          sig = trunc(`typedef enum ${alias}`);
        }
        symbols.push({
          id: makeId(filePath, qualName, 'enum'),
          name: qualName,
          kind: 'enum',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? `C enum: ${qualName}`,
        });
      } else {
        // struct or union
        const isUnion = typeChild.type === 'union_specifier';
        symbols.push({
          id: makeId(filePath, qualName, 'struct'),
          name: qualName,
          kind: 'struct',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`typedef ${isUnion ? 'union' : 'struct'} ${alias}`),
          summary: extractDocstring(node) ?? `C ${isUnion ? 'union' : 'struct'}: ${qualName}`,
        });
      }
      break;
    }

    // ── ERROR recovery: template class declarations misparsed by tree-sitter ──
    // Fires for mitsuba3-style headers where NAMESPACE_BEGIN(mitsuba) macros
    // (or preceding #include directives) confuse tree-sitter so the whole
    //   `template <Ts...> class MI_EXPORT_LIB ClassName final : public Base { ... }`
    // becomes an ERROR node instead of a proper template_declaration.
    //
    // Two child patterns observed:
    //
    //   Pattern 1 — export macro (scene.h, MI_EXPORT_LIB):
    //     template
    //     template_parameter_list      <typename Float, typename Spectrum>
    //     class_specifier              "class MI_EXPORT_LIB"
    //     ERROR                        "Scene final : public ..."
    //       identifier                 "Scene"   ← class name (clean)
    //     {
    //     ... labeled_statement / ERROR / declaration ... (body)
    //
    //   Pattern 2 — no export macro (microfacet.h, MicrofacetDistribution):
    //     template
    //     template_parameter_list      <typename Float, typename Spectrum>
    //     class                        (bare keyword, unnamed)
    //     type_identifier              "MicrofacetDistribution"  ← class name directly
    //     base_class_clause
    //     {
    //     access_specifier             public
    //     ... declaration / function_definition ... (body)
    case 'ERROR': {
      const children = node.children;

      // Must have 'template' keyword child
      if (!children.some((c) => c.type === 'template')) break;

      const tmplParams = children.find((c) => c.type === 'template_parameter_list');
      if (!tmplParams) break;

      let isStruct = false;
      let localName: string | null = null;

      // Pattern 1: class_specifier (export macro: "class MI_EXPORT_LIB")
      const classSpec = children.find(
        (c) => c.type === 'class_specifier' || c.type === 'struct_specifier',
      );
      if (classSpec) {
        isStruct = classSpec.type === 'struct_specifier';
        const classSpecIdx = children.indexOf(classSpec);
        for (let i = classSpecIdx + 1; i < children.length; i++) {
          const c = children[i]!;
          if (c.type === '{') break;
          if (c.isNamed && c.type === 'identifier') {
            localName = nodeText(c, src);
            break;
          }
          if (c.type === 'ERROR') {
            const inner = c.children.find((ec) => ec.isNamed && ec.type === 'identifier');
            if (inner) { localName = nodeText(inner, src); break; }
          }
        }
      } else {
        // Pattern 2: bare 'class'/'struct' keyword followed by type_identifier
        const classKwIdx = children.findIndex((c) => c.type === 'class' || c.type === 'struct');
        if (classKwIdx < 0) break;
        isStruct = children[classKwIdx]!.type === 'struct';
        for (let i = classKwIdx + 1; i < children.length; i++) {
          const c = children[i]!;
          if (c.type === '{') break;
          if (c.isNamed && (c.type === 'type_identifier' || c.type === 'identifier')) {
            localName = nodeText(c, src);
            break;
          }
        }
      }

      if (!localName || localName === 'final' || localName === 'override') break;

      const nsPart = ctx.nsStack.length > 0 ? ctx.nsStack.join('::') + '::' : '';
      const qualName = nsPart + localName;
      const kind: SymbolKind = isStruct ? 'struct' : 'class';
      const tmplParamText = nodeText(tmplParams, src);
      const tmplPrefix = `template${tmplParamText}`;

      // Build body snippet from the content between '{' and the node end
      const braceIdx = children.findIndex((c) => c.type === '{');
      let bodySnippet = '';
      if (braceIdx >= 0) {
        const afterBrace = children[braceIdx]!.endIndex;
        const closingBrace = children.findLast((c) => c.type === '}');
        const bodyEnd = closingBrace ? closingBrace.startIndex : node.endIndex;
        const rawBody = src.slice(afterBrace, Math.min(afterBrace + 600, bodyEnd));
        bodySnippet = rawBody.replace(/\s+/g, ' ').trim().slice(0, 200);
      }

      symbols.push({
        id: makeId(filePath, qualName, kind),
        name: qualName,
        kind,
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: trunc(`${tmplPrefix} ${isStruct ? 'struct' : 'class'} ${qualName}`),
        summary: extractDocstring(node) ?? `C++ ${kind}: ${qualName}`,
        ...(bodySnippet ? { bodySnippet } : {}),
      });

      // Walk body children for method symbols
      if (braceIdx >= 0) {
        walkErrorClassBody(
          children.slice(braceIdx + 1),
          { nsStack: ctx.nsStack, className: qualName },
          filePath,
          src,
          symbols,
          isStruct,
        );
      }
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
 * Walk a `compound_statement` that was misparsed as a function body but is
 * actually the body of a class/struct declared with an export macro.
 * e.g. `class MI_EXPORT_LIB Scene { public: void render(); };`
 *
 * tree-sitter wraps `public:` as `labeled_statement` nodes inside the compound.
 */
function walkExportMacroClassBody(
  bodyNode: SyntaxNode,
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  isStruct: boolean,
): void {
  let accessLevel: 'public' | 'private' | 'protected' = isStruct ? 'public' : 'private';

  for (const child of bodyNode.children) {
    if (!child.isNamed) continue;

    if (child.type === 'labeled_statement') {
      // `public: decl...` or `private: decl...`
      const labelNode = child.children.find((c) => c.type === 'statement_identifier');
      if (labelNode) {
        const label = nodeText(labelNode, src);
        if (label === 'public') accessLevel = 'public';
        else if (label === 'protected') accessLevel = 'protected';
        else if (label === 'private') accessLevel = 'private';
      }
      if (accessLevel === 'private') continue;

      // Walk the statement body (declarations / function definitions after label)
      for (const stmt of child.children) {
        if (!stmt.isNamed || stmt.type === 'statement_identifier') continue;
        if (stmt.type === 'function_definition') {
          emitMethod(stmt, ctx, filePath, src, symbols, null);
        } else if (stmt.type === 'declaration') {
          emitDeclMethod(stmt, ctx, filePath, src, symbols);
        }
      }
    } else if (child.type === 'function_definition' && accessLevel !== 'private') {
      emitMethod(child, ctx, filePath, src, symbols, null);
    } else if (child.type === 'declaration' && accessLevel !== 'private') {
      emitDeclMethod(child, ctx, filePath, src, symbols);
    }
  }
}

/**
 * Walk body children of a class/struct that tree-sitter parsed inside an ERROR node.
 * Body children are direct children of the ERROR node that come after the `{` token.
 * Handles labeled_statement (access specifiers), ERROR (misparsed method stubs),
 * function_definition, and declaration nodes.
 */
function walkErrorClassBody(
  bodyChildren: SyntaxNode[],
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
  isStruct: boolean,
): void {
  let accessLevel: 'public' | 'private' | 'protected' = isStruct ? 'public' : 'private';

  for (const child of bodyChildren) {
    // Handle direct access_specifier nodes (Pattern 2: microfacet.h style)
    if (child.type === 'access_specifier') {
      const text = nodeText(child, src);
      if (text.startsWith('public')) accessLevel = 'public';
      else if (text.startsWith('protected')) accessLevel = 'protected';
      else if (text.startsWith('private')) accessLevel = 'private';
      continue;
    }

    if (!child.isNamed) continue;

    if (child.type === 'labeled_statement') {
      const labelNode = child.children.find((c) => c.type === 'statement_identifier');
      if (labelNode) {
        const label = nodeText(labelNode, src);
        if (label === 'public') accessLevel = 'public';
        else if (label === 'protected') accessLevel = 'protected';
        else if (label === 'private') accessLevel = 'private';
      }
      if (accessLevel === 'private') continue;
      // Walk statement body (declarations / definitions after the access label)
      for (const stmt of child.children) {
        if (!stmt.isNamed || stmt.type === 'statement_identifier') continue;
        if (stmt.type === 'function_definition') {
          emitMethod(stmt, ctx, filePath, src, symbols, null);
        } else if (stmt.type === 'declaration') {
          emitDeclMethod(stmt, ctx, filePath, src, symbols);
        }
      }
    } else if (child.type === 'function_definition' && accessLevel !== 'private') {
      emitMethod(child, ctx, filePath, src, symbols, null);
    } else if (child.type === 'declaration' && accessLevel !== 'private') {
      emitDeclMethod(child, ctx, filePath, src, symbols);
    } else if (child.type === 'ERROR' && accessLevel !== 'private') {
      // Method declarations misparsed as ERROR — look for function_declarator child
      const funcDecl = child.children.find((c) => c.type === 'function_declarator');
      if (funcDecl) {
        const rawName = extractDeclaratorName(funcDecl, src);
        if (rawName) {
          const methodName = ctx.className ? ctx.className + '::' + rawName : rawName;
          symbols.push({
            id: makeId(filePath, methodName, 'method'),
            name: methodName,
            kind: 'method',
            filePath,
            startByte: child.startIndex,
            endByte: child.endIndex,
            signature: trunc(nodeText(child, src).replace(/\s+/g, ' ')),
            summary: extractDocstring(child) ?? `C++ method: ${methodName}`,
          });
        }
      }
    }
  }
}

/** Extract a method symbol from a `declaration` node (header-only method stub). */
function emitDeclMethod(
  node: SyntaxNode,
  ctx: WalkCtx,
  filePath: string,
  src: string,
  symbols: SymbolRecord[],
): void {
  const hasFuncDecl = node.children.some(
    (c) =>
      c.isNamed &&
      (c.type === 'function_declarator' || findFunctionDeclarator(c) !== null),
  );
  if (!hasFuncDecl) return;

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
  const declText = nodeText(node, src).replace(/;\s*$/, '').trim();

  symbols.push({
    id: makeId(filePath, methodName, 'method'),
    name: methodName,
    kind: 'method',
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: trunc(declText),
    summary: extractDocstring(node) ?? `C++ method: ${methodName}`,
  });
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
  extensions: () => ['.cpp', '.cxx', '.cc', '.c++', '.hpp', '.hxx', '.hh', '.h++', '.h'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-cpp.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
