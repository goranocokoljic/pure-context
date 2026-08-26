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

/**
 * Extract text from node start up to (not including) its `body` child.
 *
 * Uses sourceStr (the UTF-8 decoded string) with character-based slice because
 * web-tree-sitter's callback mode reports node.startIndex / endIndex as
 * JavaScript character indices, not raw byte offsets.
 *
 * PHP 8 compatibility: leading `attribute_list` children (#[Route(...)]) are
 * skipped so signatures stay clean and don't include attribute noise.
 */
function buildSignature(node: SyntaxNode, sourceStr: string): string {
  const body = node.childForFieldName?.('body') ??
    node.children.find((c) =>
      c.type === 'compound_statement' ||
      c.type === 'declaration_list' ||
      c.type === 'enum_declaration_list',
    );
  const endChar = body ? body.startIndex : node.endIndex;
  // Skip any leading attribute_list nodes (PHP 8 #[...] attributes) so they
  // do not pollute the signature string.
  const firstNonAttr = node.children.find((c) => c.type !== 'attribute_list');
  const startChar = firstNonAttr ? firstNonAttr.startIndex : node.startIndex;
  return sourceStr
    .slice(startChar, endChar)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/**
 * Get the text of the `name` field child of a PHP grammar node.
 *
 * node.startIndex / endIndex are JavaScript character indices (not byte offsets)
 * because web-tree-sitter's callback mode indexes by character. Use
 * sourceStr.slice() — never source.toString('utf8', startIndex, endIndex).
 */
function getNameText(node: SyntaxNode, sourceStr: string): string {
  // The `name` field in PHP grammar nodes is a `name` type node (not `identifier`)
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c) => c.type === 'name');
  if (!nameNode) return '';
  return sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
}

// ─── Visibility check ─────────────────────────────────────────────────────────

function isPrivateMethod(node: SyntaxNode, sourceStr: string): boolean {
  const vis = node.children.find((c) => c.type === 'visibility_modifier');
  return vis ? sourceStr.slice(vis.startIndex, vis.endIndex) === 'private' : false;
}

// ─── Closure signature building ──────────────────────────────────────────────

/**
 * Build a one-line signature for a closure assigned to a variable.
 *
 * For anonymous functions: slice from the assignment statement start up to (but
 * not including) the compound_statement body — same strategy as buildSignature.
 *
 * For arrow functions there is no compound_statement, so include the full
 * expression (they are typically short single-line expressions).
 */
function buildClosureSignature(
  stmtNode: SyntaxNode,
  closureNode: SyntaxNode,
  sourceStr: string,
): string {
  if (closureNode.type === 'anonymous_function') {
    const body = closureNode.childForFieldName?.('body') ??
      closureNode.children.find((c) => c.type === 'compound_statement');
    const endChar = body ? body.startIndex : closureNode.endIndex;
    return sourceStr
      .slice(stmtNode.startIndex, endChar)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }
  // Arrow function: include the full statement (minus trailing semicolons)
  return sourceStr
    .slice(stmtNode.startIndex, stmtNode.endIndex)
    .replace(/[;\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Body snippet extraction ──────────────────────────────────────────────────

/**
 * Extract the first ~200 chars of a function/method body as plain searchable text.
 * Skips the opening brace and normalises whitespace so body tokens land in FTS.
 */
function extractBodySnippet(bodyNode: SyntaxNode, sourceStr: string): string {
  // Skip the opening '{' (+1 char); grab up to 600 raw chars for normalisation headroom
  const start = bodyNode.startIndex + 1;
  const end = Math.min(start + 600, bodyNode.endIndex - 1);
  if (start >= end) return '';
  return sourceStr
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ─── Method/member extraction ─────────────────────────────────────────────────

function extractMembers(
  bodyNode: SyntaxNode,
  className: string,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const child of bodyNode.children) {
    if (child.type === 'abstract_method_declaration') {
      // Abstract methods in abstract classes and traits — no body node
      if (isPrivateMethod(child, sourceStr)) continue;
      const name = getNameText(child, sourceStr);
      if (!name) continue;
      const qualified = `${className}::${name}`;
      symbols.push({
        id: makeId(filePath, qualified, 'method'),
        name: qualified,
        kind: 'method',
        filePath,
        startByte: child.startIndex,
        endByte: child.endIndex,
        signature: buildSignature(child, sourceStr),
        summary: extractDocstring(child) ?? '',
      });
    } else if (child.type === 'method_declaration') {
      if (isPrivateMethod(child, sourceStr)) continue;
      const name = getNameText(child, sourceStr);
      if (!name) continue;
      const qualified = `${className}::${name}`;
      const methodBodyNode = child.childForFieldName?.('body') ??
        child.children.find((c) => c.type === 'compound_statement');
      symbols.push({
        id: makeId(filePath, qualified, 'method'),
        name: qualified,
        kind: 'method',
        filePath,
        startByte: child.startIndex,
        endByte: child.endIndex,
        signature: buildSignature(child, sourceStr),
        summary: extractDocstring(child) ?? '',
        ...(methodBodyNode ? { bodySnippet: extractBodySnippet(methodBodyNode, sourceStr) } : {}),
      });
    } else if (child.type === 'property_declaration') {
      // Class property declarations: public string $name = 'default';
      if (isPrivateMethod(child, sourceStr)) continue;
      for (const pe of child.children) {
        if (pe.type !== 'property_element') continue;
        // variable_name node holds the $ + name; its 'name' field is the identifier
        const varNode = pe.children.find((c) => c.type === 'variable_name');
        if (!varNode) continue;
        const nameNode = varNode.childForFieldName?.('name') ??
          varNode.children.find((c) => c.type === 'name');
        if (!nameNode) continue;
        const propName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        if (!propName) continue;
        const qualified = `${className}::$${propName}`;
        const sig = sourceStr
          .slice(child.startIndex, child.endIndex)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        symbols.push({
          id: makeId(filePath, qualified, 'property'),
          name: qualified,
          kind: 'property',
          filePath,
          startByte: pe.startIndex,
          endByte: pe.endIndex,
          signature: sig,
          summary: extractDocstring(child) ?? '',
        });
      }
    } else if (child.type === 'const_declaration') {
      // Class constants
      for (const ce of child.children) {
        if (ce.type !== 'const_element') continue;
        const name = getNameText(ce, sourceStr);
        if (!name) continue;
        const qualified = `${className}::${name}`;
        const sig = sourceStr
          .slice(child.startIndex, child.endIndex)
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

// ─── Enum case extraction ─────────────────────────────────────────────────────

/**
 * Extract `case Foo;` / `case Foo = value;` nodes from an enum_declaration_list.
 * Each case becomes a `const` symbol named `EnumName::CaseName`.
 */
function extractEnumCases(
  bodyNode: SyntaxNode,
  enumName: string,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const child of bodyNode.children) {
    if (child.type !== 'enum_case') continue;
    const name = getNameText(child, sourceStr);
    if (!name) continue;
    const qualified = `${enumName}::${name}`;
    const sig = sourceStr
      .slice(child.startIndex, child.endIndex)
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

// ─── Top-level symbol extraction ──────────────────────────────────────────────

/**
 * Extract symbols from a list of statement nodes.
 * `nsPrefix` is the current namespace (empty string if none).
 */
function extractFromStatements(
  nodes: SyntaxNode[],
  nsPrefix: string,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const qualify = (n: string) => (nsPrefix ? `${nsPrefix}\\${n}` : n);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;

    // ── function_definition ──────────────────────────────────────────────────
    if (node.type === 'function_definition') {
      const name = getNameText(node, sourceStr);
      if (!name) continue;
      const qualName = qualify(name);
      const fnBodyNode = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'compound_statement');
      symbols.push({
        id: makeId(filePath, qualName, 'function'),
        name: qualName,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstring(node) ?? '',
        ...(fnBodyNode ? { bodySnippet: extractBodySnippet(fnBodyNode, sourceStr) } : {}),
      });
      continue;
    }

    // ── class_declaration ────────────────────────────────────────────────────
    if (node.type === 'class_declaration') {
      const name = getNameText(node, sourceStr);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'class'),
        name: qualName,
        kind: 'class',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstring(node) ?? '',
      });
      // Extract methods + class constants from declaration_list
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, sourceStr, filePath, symbols);
      continue;
    }

    // ── interface_declaration ─────────────────────────────────────────────────
    if (node.type === 'interface_declaration') {
      const name = getNameText(node, sourceStr);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'interface'),
        name: qualName,
        kind: 'interface',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstring(node) ?? '',
      });
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, sourceStr, filePath, symbols);
      continue;
    }

    // ── trait_declaration ─────────────────────────────────────────────────────
    if (node.type === 'trait_declaration') {
      const name = getNameText(node, sourceStr);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'interface'),
        name: qualName,
        kind: 'interface', // Traits map to 'interface' for navigation purposes
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstring(node) ?? '',
      });
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'declaration_list');
      if (body) extractMembers(body, qualName, sourceStr, filePath, symbols);
      continue;
    }

    // ── enum_declaration ──────────────────────────────────────────────────────
    if (node.type === 'enum_declaration') {
      const name = getNameText(node, sourceStr);
      if (!name) continue;
      const qualName = qualify(name);
      symbols.push({
        id: makeId(filePath, qualName, 'enum'),
        name: qualName,
        kind: 'enum',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: buildSignature(node, sourceStr),
        summary: extractDocstring(node) ?? '',
      });
      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'enum_declaration_list');
      if (body) extractEnumCases(body, qualName, sourceStr, filePath, symbols);
      continue;
    }

    // ── define() constants and closure assignments ───────────────────────────
    // PHP global constants via: define('NAME', value) or define("NAME", value)
    // PHP closures via: $var = function(...) {...} or $var = fn(...) => expr
    if (node.type === 'expression_statement') {
      const expr = node.children.find((c) => c.type === 'function_call_expression');
      if (expr) {
        const fnNameNode = expr.children.find((c) => c.type === 'name');
        const fnName = fnNameNode
          ? sourceStr.slice(fnNameNode.startIndex, fnNameNode.endIndex).toLowerCase()
          : '';
        if (fnName === 'define') {
          const argsNode = expr.children.find((c) => c.type === 'arguments');
          if (argsNode) {
            const args = argsNode.children.filter((c) => c.type === 'argument');
            if (args.length >= 1) {
              const firstArg = args[0]!;
              // Strip surrounding quotes from the string literal
              const rawArg = sourceStr
                .slice(firstArg.startIndex, firstArg.endIndex)
                .trim();
              const constName = rawArg.replace(/^['"]|['"]$/g, '');
              if (constName && /^[A-Z_a-z][A-Z_a-z0-9]*$/.test(constName)) {
                const qualName = qualify(constName);
                const sig = sourceStr
                  .slice(node.startIndex, node.endIndex)
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 120);
                symbols.push({
                  id: makeId(filePath, qualName, 'const'),
                  name: qualName,
                  kind: 'const',
                  filePath,
                  startByte: node.startIndex,
                  endByte: node.endIndex,
                  signature: sig,
                  summary: extractDocstring(node) ?? '',
                });
              }
            }
          }
        }
      }

      // ── closure assignments: $var = function(...) {...} or $var = fn(…) => … ──
      const assignment = node.children.find((c) => c.type === 'assignment_expression');
      if (assignment) {
        const lhs = assignment.children.find((c) => c.type === 'variable_name');
        const rhs = assignment.children.find((c) =>
          c.type === 'anonymous_function' ||
          c.type === 'arrow_function',
        );
        if (lhs && rhs) {
          const nameNode = lhs.childForFieldName?.('name') ??
            lhs.children.find((c) => c.type === 'name');
          const varName = nameNode
            ? sourceStr.slice(nameNode.startIndex, nameNode.endIndex)
            : '';
          if (varName) {
            const qualName = qualify(varName);
            // Only compound_statement bodies yield a bodySnippet; arrow function
            // expression bodies are skipped (extractBodySnippet needs a block).
            const closureBody = rhs.children.find((c) => c.type === 'compound_statement');
            symbols.push({
              id: makeId(filePath, qualName, 'function'),
              name: qualName,
              kind: 'function',
              filePath,
              startByte: node.startIndex,
              endByte: node.endIndex,
              signature: buildClosureSignature(node, rhs, sourceStr),
              summary: extractDocstring(node) ?? '',
              ...(closureBody ? { bodySnippet: extractBodySnippet(closureBody, sourceStr) } : {}),
            });
          }
        }
      }
      continue;
    }

    // ── const_declaration (top-level) ─────────────────────────────────────────
    if (node.type === 'const_declaration') {
      for (const ce of node.children) {
        if (ce.type !== 'const_element') continue;
        const name = getNameText(ce, sourceStr);
        if (!name) continue;
        const qualName = qualify(name);
        const sig = sourceStr
          .slice(node.startIndex, node.endIndex)
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
      const ns = nameNode ? sourceStr.slice(nameNode.startIndex, nameNode.endIndex) : '';

      const body = node.childForFieldName?.('body') ??
        node.children.find((c) => c.type === 'compound_statement');

      if (body) {
        // Braced namespace: `namespace Foo { ... }`
        // Recursively extract from body statements
        extractFromStatements(body.children, ns, sourceStr, filePath, symbols);
      } else {
        // Unbraced namespace: `namespace Foo;`
        // All nodes after this one belong to the new namespace.
        extractFromStatements(nodes.slice(i + 1), ns, sourceStr, filePath, symbols);
        return; // remaining nodes handled by the recursive call
      }
      continue;
    }
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  // web-tree-sitter callback mode reports node.startIndex / endIndex as
  // JavaScript character indices, not raw byte offsets. Decode to a JS string
  // once and use .slice(startIndex, endIndex) everywhere for correct results.
  const sourceStr = source.toString('utf8');
  const topLevel = tree.rootNode.children;
  extractFromStatements(topLevel, '', sourceStr, filePath, symbols);
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract PHP `use` statements (namespace_use_declaration nodes).
 * e.g. `use App\Http\Controllers\UserController as UserCtrl;`
 */
function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const sourceStr = source.toString('utf8');

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
          const specifier = sourceStr.slice(qualNode.startIndex, qualNode.endIndex);
          const segments = specifier.split('\\');
          const lastName = segments[segments.length - 1] ?? specifier;

          const aliasNode = clause.childForFieldName?.('alias') ??
            clause.children.find((c) => c.type === 'name' && c !== qualNode);
          const importedName = aliasNode
            ? sourceStr.slice(aliasNode.startIndex, aliasNode.endIndex)
            : lastName;

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

// ─── extractPackage ───────────────────────────────────────────────────────────

/**
 * Declared namespace of the file: `namespace App\Http;` (or the braced form)
 * → "App\Http", stored with backslashes as written. Only the FIRST namespace
 * declaration is captured — files with several braced namespaces store the
 * first one (documented v1 limitation, mirrors the C# outermost-only rule;
 * the resolver's symbol-table lookup covers the rest).
 */
function extractPackage(tree: Tree | null, source: Buffer): string | null {
  if (!tree) return null;
  const sourceStr = source.toString('utf8');
  for (const node of tree.rootNode.children) {
    if (node.type !== 'namespace_definition') continue;
    const nameNode = node.childForFieldName?.('name') ??
      node.children.find((c) => c.type === 'namespace_name');
    const ns = nameNode
      ? sourceStr.slice(nameNode.startIndex, nameNode.endIndex).trim()
      : '';
    return ns.length > 0 ? ns : null;
  }
  return null;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const phpHandler: LanguageHandler = {
  extensions: () => ['.php'],

  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-php.wasm'),

  extractSymbols,

  extractImports,

  extractDocstring,

  extractPackage,
};
