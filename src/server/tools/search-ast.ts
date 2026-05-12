/**
 * search-ast.ts
 *
 * MCP tool: search_ast
 *
 * Structural AST node-type search. Re-parses the raw file content stored in
 * the index using the appropriate tree-sitter grammar and walks the resulting
 * AST to find every node whose type matches `nodeType`.
 *
 * Only files backed by a WASM grammar are searched. Files handled by the
 * regex-based fallback (Perl, Terraform, Nix, Protobuf, GraphQL, Groovy,
 * Erlang, GDScript, XML, etc.) are silently skipped and noted in `skippedFiles`.
 *
 * Common node types (case-sensitive, tree-sitter names):
 *   TypeScript / JavaScript:
 *     arrow_function          function_declaration       class_declaration
 *     interface_declaration   try_statement              await_expression
 *     call_expression         import_statement           jsx_element
 *     template_string         throw_statement            type_alias_declaration
 *   Python:
 *     function_definition     class_definition           for_statement
 *     with_statement          decorated_definition       lambda
 *   Rust:
 *     function_item           struct_item                impl_item
 *     match_expression        closure_expression         trait_item
 *   Go:
 *     function_declaration    method_declaration         go_statement
 *     defer_statement         type_declaration           interface_type
 *   Java / Kotlin:
 *     method_declaration      class_declaration          try_statement
 *     lambda_expression       annotation
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import { getHandler } from '../../handlers/handler-registry.js';
import { initParser, parseFile, isInitialized } from '../../core/parse-dispatcher.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SyntaxNode } from '../../core/types.js';

export const name = 'search_ast';

export const description =
  'Structural AST node-type search. Finds every occurrence of a specific ' +
  'tree-sitter node type across indexed files — e.g. all arrow functions, all ' +
  'try/catch blocks, all await expressions, all JSX elements — without reading ' +
  'files manually. Re-parses stored file content using the appropriate grammar. ' +
  'Only files backed by a WASM grammar (TypeScript, JavaScript, Python, Go, ' +
  'Rust, Java, C/C++, etc.) are searched; regex-only handlers are skipped.' +
  '\n\nNode type is the exact tree-sitter internal name (case-sensitive):' +
  '\n  "arrow_function"       — all arrow functions' +
  '\n  "try_statement"        — all try/catch blocks' +
  '\n  "await_expression"     — all awaited expressions' +
  '\n  "class_declaration"    — all class declarations' +
  '\n  "interface_declaration"— all TypeScript interfaces' +
  '\n  "jsx_element"          — all JSX elements' +
  '\n  "template_string"      — all template literals' +
  '\n  "call_expression"      — all function calls';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  nodeType: z
    .string()
    .min(1)
    .describe(
      'The tree-sitter AST node type to search for (e.g. "arrow_function", ' +
      '"try_statement", "class_declaration"). Exact, case-sensitive match.',
    ),
  language: z
    .string()
    .optional()
    .describe(
      'Restrict search to files of a specific language ' +
      '(e.g. "typescript", "javascript", "python", "go", "rust", "java"). ' +
      'When omitted, all WASM-backed grammar files in the repo are searched.',
    ),
  filePath: z
    .string()
    .optional()
    .describe('Restrict search to a specific file path or directory prefix'),
  includeText: z
    .boolean()
    .optional()
    .describe(
      'Whether to include the matched node\'s source text in each result ' +
      '(default true). Set false to reduce response size when you only need locations.',
    ),
  maxTextLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum characters of matched node text to include (default 120)'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of matches to return (default 50)'),
};

// ─── Internals ────────────────────────────────────────────────────────────────

/** Recursively walk the AST collecting nodes whose type === targetType. */
function collectNodes(node: SyntaxNode, targetType: string, results: SyntaxNode[]): void {
  if (node.type === targetType) {
    results.push(node);
  }
  for (const child of node.children) {
    collectNodes(child, targetType, results);
  }
}

/** Count newlines in `buf` up to (not including) byte offset `byteOffset`. */
function byteOffsetToLine(buf: Buffer, byteOffset: number): number {
  let line = 1;
  const end = Math.min(byteOffset, buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0x0a) line++;
  }
  return line;
}

// ─── DB row type ──────────────────────────────────────────────────────────────

interface FileRow {
  path: string;
  raw_content: Buffer | null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  nodeType: string;
  language?: string;
  filePath?: string;
  includeText?: boolean;
  maxTextLength?: number;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    nodeType,
    language,
    filePath,
    includeText = true,
    maxTextLength = 120,
    limit = 50,
  } = args;

  // ── Validate nodeType is a non-empty string ──────────────────────────────────
  if (!nodeType || nodeType.trim().length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'nodeType must be a non-empty string' }),
      }],
      isError: true,
    };
  }

  const db = openDatabase(repoId);
  try {
    // ── Verify repo exists ───────────────────────────────────────────────────
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

    // ── Build file query ─────────────────────────────────────────────────────
    // Resolve language → allowed extensions if language filter was specified
    let allowedExtensions: Set<string> | null = null;
    if (language) {
      const h = getHandler(`.${language}`);
      if (h) {
        allowedExtensions = new Set(h.extensions());
      } else {
        // Try by looking up a handler via getHandler with common patterns
        // e.g. "typescript" → try ".ts"
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
          lua:         ['.lua'],
          dart:        ['.dart'],
          swift:       ['.swift'],
          scala:       ['.scala', '.sc'],
          elixir:      ['.ex', '.exs'],
          haskell:     ['.hs', '.lhs'],
          r:           ['.r'],
          bash:        ['.sh', '.bash'],
        };
        const exts = langToExt[language.toLowerCase()];
        if (exts) {
          allowedExtensions = new Set(exts);
        }
        // If language is unknown, proceed without extension filter — will just get 0 matches
      }
    }

    const conditions: string[] = ['repo_id = @repoId', 'raw_content IS NOT NULL'];
    const params: Record<string, unknown> = { repoId };

    if (filePath) {
      conditions.push('(path = @filePath OR path LIKE @filePathPrefix)');
      params['filePath'] = filePath;
      params['filePathPrefix'] = `${filePath}%`;
    }

    const sql = `
      SELECT path, raw_content
      FROM files
      WHERE ${conditions.join(' AND ')}
      ORDER BY path
    `;

    const fileRows = db.prepare<Record<string, unknown>, FileRow>(sql).all(params);

    // ── Initialize tree-sitter parser (idempotent) ───────────────────────────
    if (!isInitialized()) {
      await initParser();
    }

    // ── Walk files and collect matches ───────────────────────────────────────
    const matches: Array<{
      filePath: string;
      startLine: number;
      endLine: number;
      startByte: number;
      endByte: number;
      nodeType: string;
      text: string;
    }> = [];
    const skippedFiles: string[] = [];
    let totalMatchesBeforeLimit = 0;
    let truncated = false;

    for (const row of fileRows) {
      if (!row.raw_content) continue;

      const filePath = row.path;
      const content = row.raw_content;

      // ── Extension filter ─────────────────────────────────────────────────
      const ext = filePath.includes('.')
        ? `.${filePath.split('.').pop()!.toLowerCase()}`
        : '';

      if (allowedExtensions && !allowedExtensions.has(ext)) {
        continue;
      }

      // ── Get handler — skip files with no WASM grammar ───────────────────
      const h = getHandler(filePath);
      if (!h || h.grammarPath() === null) {
        if (h) skippedFiles.push(filePath); // has handler but regex-only
        continue;
      }

      // ── Parse and walk AST ───────────────────────────────────────────────
      let tree;
      try {
        tree = await parseFile(content, h);
      } catch {
        skippedFiles.push(filePath);
        continue;
      }

      const found: SyntaxNode[] = [];
      collectNodes(tree.rootNode, nodeType, found);
      totalMatchesBeforeLimit += found.length;

      for (const node of found) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        const startLine = byteOffsetToLine(content, node.startIndex);
        const endLine = byteOffsetToLine(content, node.endIndex);
        const rawText = content.toString('utf8', node.startIndex, node.endIndex);
        const text = includeText
          ? rawText.length > maxTextLength
            ? rawText.slice(0, maxTextLength) + '…'
            : rawText
          : '';

        matches.push({
          filePath,
          startLine,
          endLine,
          startByte: node.startIndex,
          endByte: node.endIndex,
          nodeType,
          text,
        });
      }

      if (truncated) break;
    }

    // ── Token estimate ───────────────────────────────────────────────────────
    const responseBytes = matches.reduce(
      (sum, m) => sum + m.text.length + m.filePath.length + 60,
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
            nodeTypeSearched: nodeType,
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
