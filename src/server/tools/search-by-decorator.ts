/**
 * search-by-decorator.ts
 *
 * MCP tool: search_by_decorator
 *
 * Find all symbols (classes, methods, functions, properties) annotated with
 * a specific decorator. Re-parses stored file content via tree-sitter to
 * locate `decorator` AST nodes, then resolves each back to its parent symbol
 * in the index.
 *
 * Three match modes:
 *  - exact    (default) — decorator name exactly matches the query (case-sensitive)
 *  - contains           — decorator name contains the query
 *  - prefix             — decorator name starts with the query
 *
 * Parameter decorators (on function parameters) are excluded — they do not
 * correspond to indexed symbols.
 *
 * Only files backed by a WASM grammar are searched. Regex-only handlers
 * (Perl, Terraform, Protobuf, GraphQL, etc.) are silently skipped.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import { getHandler } from '../../handlers/handler-registry.js';
import { initParser, parseFile, isInitialized } from '../../core/parse-dispatcher.js';
import { lineOfChar } from '../../core/offsets.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SyntaxNode } from '../../core/types.js';

export const name = 'search_by_decorator';

export const description =
  'Find all symbols annotated with a specific decorator — e.g. all @Injectable ' +
  'classes, all @Get route handlers, all @Column properties. Re-parses stored ' +
  'file content via tree-sitter to locate decorator nodes and resolves each back ' +
  'to the decorated symbol in the index. ' +
  '\n\nThree match modes:' +
  '\n  exact (default) — decorator name must exactly match (e.g. "Injectable")' +
  '\n  contains        — decorator name contains the query (e.g. "inject" finds @Injectable)' +
  '\n  prefix          — decorator name starts with the query (e.g. "Get" finds @Get, @GetMapping)' +
  '\n\nExamples:' +
  '\n  decoratorName: "Injectable"             — all @Injectable classes' +
  '\n  decoratorName: "Controller"             — all @Controller route handlers' +
  '\n  decoratorName: "Column", mode: "prefix" — all @Column, @ColumnType decorators' +
  '\n  decoratorName: "test", mode: "contains" — anything with "test" in decorator name';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  decoratorName: z
    .string()
    .min(1)
    .describe(
      'Decorator name to search for — without the "@" prefix. ' +
      'Case-sensitive for exact/prefix modes, case-sensitive for contains mode.',
    ),
  matchMode: z
    .enum(['exact', 'contains', 'prefix'])
    .optional()
    .describe(
      'How to match the decorator name: "exact" (default) — name must equal query; ' +
      '"contains" — name must contain query; "prefix" — name must start with query.',
    ),
  language: z
    .string()
    .optional()
    .describe(
      'Restrict search to files of a specific language ' +
      '(e.g. "typescript", "javascript"). ' +
      'When omitted, all WASM-backed grammar files are searched.',
    ),
  filePath: z
    .string()
    .optional()
    .describe('Restrict search to a specific file path or directory prefix'),
  includeDecoratorText: z
    .boolean()
    .optional()
    .describe(
      'Include the full decorator text in each result (e.g. "@Injectable()" or ' +
      '"@Column({ nullable: false })"). Default true.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of matches to return (default 50)'),
};

// ─── DB row types ─────────────────────────────────────────────────────────────

interface FileRow {
  path: string;
  raw_content: Buffer | null;
}

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  start_byte: number;
  signature: string;
  summary: string;
}

// ─── AST helpers ─────────────────────────────────────────────────────────────

/** Recursively collect all decorator nodes in the tree. */
function collectDecorators(node: SyntaxNode, results: SyntaxNode[]): void {
  if (node.type === 'decorator') {
    results.push(node);
  }
  for (const child of node.children) {
    collectDecorators(child, results);
  }
}

/**
 * Extract the decorator's name (without @) from a decorator AST node.
 * Handles:
 *   @Foo              → "Foo"
 *   @Foo()            → "Foo"
 *   @Foo({ ... })     → "Foo"
 *   @Ns.Foo()         → "Ns.Foo"
 */
function extractDecoratorName(decoratorNode: SyntaxNode, source: string): string {
  for (const child of decoratorNode.children) {
    // Skip the literal "@" token
    if (child.type === '@') continue;
    if (child.type === 'comment') continue;

    if (child.type === 'identifier') {
      return source.slice(child.startIndex, child.endIndex);
    }

    if (child.type === 'call_expression') {
      // First child of call_expression is the function (callee)
      const callee = child.children[0];
      if (!callee) return source.slice(child.startIndex, child.endIndex);
      if (callee.type === 'identifier') {
        return source.slice(callee.startIndex, callee.endIndex);
      }
      if (callee.type === 'member_expression') {
        return source.slice(callee.startIndex, callee.endIndex);
      }
      return source.slice(callee.startIndex, callee.endIndex);
    }

    if (child.type === 'member_expression') {
      return source.slice(child.startIndex, child.endIndex);
    }

    // Fallback: return whatever non-@ text follows
    return source.slice(child.startIndex, child.endIndex).split('(')[0].trim();
  }
  return '';
}

/** Node types that are declaration containers (not parameter decorators). */
const DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'function_declaration',
  'method_definition',
  'public_field_definition',
  'property_definition',
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
]);

/** Node types that represent function parameter targets — skip these. */
const PARAM_TYPES = new Set([
  'required_parameter',
  'optional_parameter',
  'rest_pattern',
  'formal_parameters',
]);

/**
 * Given a decorator node, return the name of the symbol it decorates
 * and an approximate symbol kind. Returns null if the parent is a
 * parameter (not a symbol we index) or unrecognised.
 *
 * Tree-sitter TypeScript AST structure for decorators:
 *  - Class decorator:    decorator.parent = export_statement | class_declaration
 *  - Method decorator:   decorator.parent = class_body  (sibling to method_definition)
 *  - Property decorator: decorator.parent = public_field_definition (child)
 *
 * Stacked method decorators each appear as siblings in class_body; we walk
 * nextNamedSibling until we reach the method_definition.
 */
function getDecoratedInfo(
  decoratorNode: SyntaxNode,
  source: string,
): { name: string; kind: string; parentNode: SyntaxNode } | null {
  const parent = decoratorNode.parent;
  if (!parent) return null;

  // Skip parameter decorators
  if (PARAM_TYPES.has(parent.type)) return null;

  switch (parent.type) {
    // ── Class decorator (exported class) ────────────────────────────────────
    case 'export_statement': {
      // Walk children to find the class or function declaration
      for (const child of parent.children) {
        if (['class_declaration', 'abstract_class_declaration'].includes(child.type)) {
          const nameNode = child.children.find((c) => c.type === 'type_identifier');
          if (nameNode) {
            return {
              name: source.slice(nameNode.startIndex, nameNode.endIndex),
              kind: 'class',
              parentNode: child,
            };
          }
        }
        if (child.type === 'function_declaration') {
          const nameNode = child.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            return {
              name: source.slice(nameNode.startIndex, nameNode.endIndex),
              kind: 'function',
              parentNode: child,
            };
          }
        }
      }
      // Fallback: class_declaration in the nextSibling chain
      let next = decoratorNode.nextNamedSibling;
      while (next && next.type === 'decorator') next = next.nextNamedSibling;
      if (next && ['class_declaration', 'abstract_class_declaration'].includes(next.type)) {
        const nameNode = next.children.find((c) => c.type === 'type_identifier');
        if (nameNode) {
          return {
            name: source.slice(nameNode.startIndex, nameNode.endIndex),
            kind: 'class',
            parentNode: next,
          };
        }
      }
      return null;
    }

    // ── Class decorator (non-exported class) ────────────────────────────────
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const nameNode = parent.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) return null;
      return {
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: 'class',
        parentNode: parent,
      };
    }

    // ── Function decorator ───────────────────────────────────────────────────
    case 'function_declaration': {
      const nameNode = parent.children.find((c) => c.type === 'identifier');
      if (!nameNode) return null;
      return {
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: 'function',
        parentNode: parent,
      };
    }

    // ── Method decorator — decorator is a SIBLING inside class_body ─────────
    //
    // @Get('/')              ← decorator, parent = class_body
    // @UseGuards(...)        ← decorator, parent = class_body (stacked)
    // getUsers(): User[] {}  ← method_definition, parent = class_body
    //
    case 'class_body': {
      // Walk nextNamedSiblings to find the decorated method or property,
      // skipping any intermediate stacked decorators.
      let next = decoratorNode.nextNamedSibling;
      while (next && next.type === 'decorator') {
        next = next.nextNamedSibling;
      }
      if (!next) return null;

      if (next.type === 'method_definition') {
        const nameNode = next.children.find((c) =>
          ['property_identifier', 'identifier'].includes(c.type),
        );
        if (!nameNode) return null;
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

        // Qualify with class name: class_body.parent = class_declaration
        const classDecl = parent.parent;
        if (classDecl && ['class_declaration', 'abstract_class_declaration'].includes(classDecl.type)) {
          const classNameNode = classDecl.children.find((c) => c.type === 'type_identifier');
          if (classNameNode) {
            const className = source.slice(classNameNode.startIndex, classNameNode.endIndex);
            return { name: `${className}.${methodName}`, kind: 'method', parentNode: next };
          }
        }
        return { name: methodName, kind: 'method', parentNode: next };
      }

      // Stacked property definition (rare but handle it)
      if (['public_field_definition', 'property_definition'].includes(next.type)) {
        const nameNode = next.children.find((c) =>
          ['property_identifier', 'identifier'].includes(c.type),
        );
        if (!nameNode) return null;
        const fieldName = source.slice(nameNode.startIndex, nameNode.endIndex);
        const classDecl = parent.parent;
        if (classDecl && ['class_declaration', 'abstract_class_declaration'].includes(classDecl.type)) {
          const classNameNode = classDecl.children.find((c) => c.type === 'type_identifier');
          if (classNameNode) {
            const className = source.slice(classNameNode.startIndex, classNameNode.endIndex);
            return { name: `${className}.${fieldName}`, kind: 'const', parentNode: next };
          }
        }
        return { name: fieldName, kind: 'const', parentNode: next };
      }

      return null;
    }

    // ── Property decorator — decorator IS a child of public_field_definition ─
    case 'public_field_definition':
    case 'property_definition': {
      const nameNode = parent.children.find((c) =>
        ['property_identifier', 'identifier'].includes(c.type),
      );
      if (!nameNode) return null;
      const fieldName = source.slice(nameNode.startIndex, nameNode.endIndex);

      // Qualify with class name
      const classBody = parent.parent;
      const classDecl = classBody?.parent;
      if (classDecl && ['class_declaration', 'abstract_class_declaration'].includes(classDecl.type)) {
        const classNameNode = classDecl.children.find((c) => c.type === 'type_identifier');
        if (classNameNode) {
          const className = source.slice(classNameNode.startIndex, classNameNode.endIndex);
          return { name: `${className}.${fieldName}`, kind: 'const', parentNode: parent };
        }
      }
      return { name: fieldName, kind: 'const', parentNode: parent };
    }

    // ── Standalone const/let decorator ──────────────────────────────────────
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const child of parent.children) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            return {
              name: source.slice(nameNode.startIndex, nameNode.endIndex),
              kind: 'const',
              parentNode: parent,
            };
          }
        }
      }
      return null;
    }

    // ── Method decorator inside method_definition (grammar variant) ──────────
    case 'method_definition': {
      const nameNode = parent.children.find((c) =>
        ['property_identifier', 'identifier', 'computed_property_name'].includes(c.type),
      );
      if (!nameNode) return null;
      const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

      const classBody = parent.parent;
      const classDecl = classBody?.parent;
      if (classDecl && ['class_declaration', 'abstract_class_declaration'].includes(classDecl.type)) {
        const classNameNode = classDecl.children.find((c) => c.type === 'type_identifier');
        if (classNameNode) {
          const className = source.slice(classNameNode.startIndex, classNameNode.endIndex);
          return { name: `${className}.${methodName}`, kind: 'method', parentNode: parent };
        }
      }
      return { name: methodName, kind: 'method', parentNode: parent };
    }

    default:
      return null;
  }
}

// Line derivation happens in CHAR space (lineOfChar over the decoded string) —
// node.startIndex is a UTF-16 code-unit index, not a byte offset (Phase 90).

/** Check whether a decorator name matches the query under the given mode. */
function nameMatches(
  decoratorName: string,
  query: string,
  mode: 'exact' | 'contains' | 'prefix',
): boolean {
  switch (mode) {
    case 'exact':    return decoratorName === query;
    case 'contains': return decoratorName.includes(query);
    case 'prefix':   return decoratorName.startsWith(query);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  decoratorName: string;
  matchMode?: 'exact' | 'contains' | 'prefix';
  language?: string;
  filePath?: string;
  includeDecoratorText?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    decoratorName,
    matchMode = 'exact',
    language,
    filePath,
    includeDecoratorText = true,
    limit = 50,
  } = args;

  if (!decoratorName || decoratorName.trim().length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'decoratorName must be a non-empty string' }),
      }],
      isError: true,
    };
  }

  const db = openDatabase(repoId);
  try {
    // ── Verify repo exists ─────────────────────────────────────────────────
    const repoRow = db.prepare<[string], { id: string }>(
      'SELECT id FROM repos WHERE id = ?',
    ).get(repoId);
    if (!repoRow) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repository not found: ${repoId}` }),
        }],
        isError: true,
      };
    }

    // ── Resolve language filter to allowed extensions ──────────────────────
    let allowedExtensions: Set<string> | null = null;
    if (language) {
      const langToExt: Record<string, string[]> = {
        typescript:  ['.ts', '.tsx'],
        javascript:  ['.js', '.jsx', '.mjs', '.cjs'],
        python:      ['.py'],
        go:          ['.go'],
        rust:        ['.rs'],
        java:        ['.java'],
        kotlin:      ['.kt', '.kts'],
        csharp:      ['.cs'],
        cpp:         ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'],
        c:           ['.c', '.h'],
        php:         ['.php'],
        ruby:        ['.rb'],
      };
      const exts = langToExt[language.toLowerCase()] ?? [];
      allowedExtensions = new Set(exts);
    }

    // ── Query files with raw content ──────────────────────────────────────
    const conditions: string[] = ['repo_id = @repoId', 'raw_content IS NOT NULL'];
    const params: Record<string, unknown> = { repoId };

    if (filePath) {
      conditions.push('(path = @filePath OR path LIKE @filePathPrefix)');
      params['filePath'] = filePath;
      params['filePathPrefix'] = `${filePath}%`;
    }

    const fileRows = db.prepare<Record<string, unknown>, FileRow>(
      `SELECT path, raw_content FROM files WHERE ${conditions.join(' AND ')} ORDER BY path`,
    ).all(params);

    // ── Initialize tree-sitter (idempotent) ───────────────────────────────
    if (!isInitialized()) {
      await initParser();
    }

    // ── Walk files and collect matches ────────────────────────────────────
    const matches: Array<{
      symbolId?: string;
      symbolName: string;
      symbolKind: string;
      filePath: string;
      startLine: number;
      decoratorName: string;
      decoratorText?: string;
      signature?: string;
      summary?: string;
    }> = [];

    const skippedFiles: string[] = [];
    let truncated = false;

    for (const row of fileRows) {
      if (!row.raw_content || truncated) break;

      const fPath = row.path;
      const content = row.raw_content;

      // ── Extension filter ───────────────────────────────────────────────
      const ext = fPath.includes('.')
        ? `.${fPath.split('.').pop()!.toLowerCase()}`
        : '';

      if (allowedExtensions && !allowedExtensions.has(ext)) continue;

      // ── Require WASM-backed grammar ────────────────────────────────────
      const h = getHandler(fPath);
      if (!h || h.grammarPath() === null) {
        if (h) skippedFiles.push(fPath);
        continue;
      }

      // ── Parse file ────────────────────────────────────────────────────
      let tree;
      try {
        tree = await parseFile(content, h);
      } catch {
        skippedFiles.push(fPath);
        continue;
      }

      const sourceStr = content.toString('utf8');

      // ── Collect and filter decorator nodes ────────────────────────────
      const decorators: SyntaxNode[] = [];
      collectDecorators(tree.rootNode, decorators);

      // Pre-load symbols for this file to enable fast cross-referencing
      const fileSymbols = db.prepare<[string, string], SymbolRow>(
        `SELECT id, name, kind, start_byte, signature, summary
         FROM symbols
         WHERE repo_id = ? AND file_path = ?`,
      ).all(repoId, fPath);

      // Build a map from name (lower) → first matching symbol for quick lookup
      const symbolByName = new Map<string, SymbolRow>();
      for (const sym of fileSymbols) {
        symbolByName.set(sym.name, sym);
      }

      for (const decoratorNode of decorators) {
        const dName = extractDecoratorName(decoratorNode, sourceStr);
        if (!dName) continue;

        if (!nameMatches(dName, decoratorName, matchMode)) continue;

        // Get the decorated symbol info from the AST
        const decorated = getDecoratedInfo(decoratorNode, sourceStr);
        if (!decorated) continue;

        // Cross-reference with the symbols table
        const dbSymbol = symbolByName.get(decorated.name);

        const startLine = lineOfChar(sourceStr, decoratorNode.startIndex);

        const dText = includeDecoratorText
          ? sourceStr.slice(decoratorNode.startIndex, decoratorNode.endIndex).replace(/\s+/g, ' ').trim()
          : undefined;

        matches.push({
          symbolId: dbSymbol?.id,
          symbolName: decorated.name,
          symbolKind: dbSymbol?.kind ?? decorated.kind,
          filePath: fPath,
          startLine,
          decoratorName: dName,
          decoratorText: dText,
          signature: dbSymbol?.signature,
          summary: dbSymbol?.summary,
        });

        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
    }

    // ── Token estimate ─────────────────────────────────────────────────────
    const responseBytes = matches.reduce(
      (sum, m) =>
        sum +
        m.symbolName.length +
        m.filePath.length +
        (m.decoratorText?.length ?? 0) +
        (m.signature?.length ?? 0) +
        (m.summary?.length ?? 0) +
        60,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            matches,
            totalFound: matches.length,
            truncated,
            decoratorQueried: decoratorName,
            matchMode,
            filesSearched: fileRows.length - skippedFiles.length,
            skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
            _tokenEstimate: tokenEstimate,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      }],
    };
  } finally {
    db.close();
  }
}
