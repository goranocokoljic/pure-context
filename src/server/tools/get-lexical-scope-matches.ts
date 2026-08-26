/**
 * get-lexical-scope-matches.ts
 *
 * MCP tool: get_lexical_scope_matches
 *
 * Find all calls to `childCall` that appear lexically inside a `parentCall`
 * scope block — e.g. all `get` calls inside `routing { ... }` (Ktor/Ruby),
 * all `before_action` calls in a Rails controller class, all `register` calls
 * inside a `ClassMethods` module (Ruby metaprogramming).
 *
 * Re-parses stored file content using the appropriate tree-sitter grammar.
 * Only files backed by a WASM grammar are searched.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import { getHandler } from '../../handlers/handler-registry.js';
import { initParser, parseFile, isInitialized } from '../../core/parse-dispatcher.js';
import { lineOfChar } from '../../core/offsets.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SyntaxNode } from '../../core/types.js';

export const name = 'get_lexical_scope_matches';

export const description =
  'Find all calls to `childCall` that appear lexically inside a `parentCall` scope — ' +
  'e.g. all `get` calls inside `routing { ... }` (Ktor), all `before_action` calls in a ' +
  'Rails controller class, all `register` calls inside a `ClassMethods` module. ' +
  'Re-parses stored file content using the appropriate tree-sitter grammar. ' +
  'Only files backed by a WASM grammar are searched.';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  childCall: z
    .string()
    .min(1)
    .describe('The inner call to find (e.g. "get", "before_action", "register")'),
  parentCall: z
    .string()
    .min(1)
    .describe('The outer scope name to search inside (e.g. "routing", "ClassMethods", "PostsController")'),
  parentKind: z
    .enum(['call', 'class', 'module'])
    .optional()
    .describe(
      'AST kind of the parent scope: "call" (function call with block, e.g. routing { }), ' +
      '"class" (class definition), "module" (module/namespace definition). ' +
      'When omitted, all scope kinds are checked.',
    ),
  childArgMatches: z
    .object({
      position: z.number().int().min(0).describe('0-indexed argument position to check'),
      type: z
        .enum(['symbol', 'string', 'identifier'])
        .describe('Expected argument AST type at the given position'),
      matchesPrivate: z
        .boolean()
        .optional()
        .describe(
          'If true, only include matches where the argument names a method defined ' +
          'in the private section of the enclosing class/module',
        ),
    })
    .optional()
    .describe('Optional argument-level filter on the child call'),
  language: z
    .string()
    .optional()
    .describe('Restrict search to files of a specific language (e.g. "ruby", "kotlin")'),
  filePath: z
    .string()
    .optional()
    .describe('Restrict search to a specific file path or directory prefix'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum matches to return (default 100)'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Query-time re-parse works purely in CHAR space: node.startIndex is a
// UTF-16 code-unit index into the DECODED string, never a byte offset.
// Decode each buffer once (memoized) and slice/count lines in the string.
const decodedCache = new WeakMap<Buffer, string>();
function decoded(buf: Buffer): string {
  let s = decodedCache.get(buf);
  if (s === undefined) {
    s = buf.toString('utf8');
    decodedCache.set(buf, s);
  }
  return s;
}

function nodeText(node: SyntaxNode, buf: Buffer): string {
  return decoded(buf).slice(node.startIndex, node.endIndex);
}

function charIndexToLine(buf: Buffer, charIndex: number): number {
  return lineOfChar(decoded(buf), charIndex);
}

/**
 * Extract the method/function name from a call-like node.
 * Handles Ruby (`call` with `method` field), JS/TS/Kotlin (`call_expression`
 * with `function` or first `identifier` child), and bare identifiers.
 */
function getCallName(node: SyntaxNode, buf: Buffer): string | null {
  const methodField =
    node.childForFieldName('method') ??
    node.childForFieldName('function') ??
    node.childForFieldName('name');

  if (methodField) {
    const t = nodeText(methodField, buf);
    // Strip member receiver: "obj.method" → "method"
    return t.includes('.') ? t.split('.').pop()! : t;
  }

  // Fallback: first identifier/constant child before argument list or block
  for (const child of node.children) {
    if (
      child.type === 'identifier' ||
      child.type === 'constant' ||
      child.type === 'simple_identifier'
    ) {
      return nodeText(child, buf);
    }
    // Stop before args / block
    if (
      child.type === 'argument_list' ||
      child.type === 'arguments' ||
      child.type === 'do_block' ||
      child.type === 'block' ||
      child.type === 'call_suffix'
    )
      break;
  }

  return null;
}

/** Get the scope body node for a parent match. */
function getScopeBody(
  parentNode: SyntaxNode,
  parentKind: string | undefined,
): SyntaxNode | null {
  if (!parentKind || parentKind === 'call') {
    // Ruby: do_block or block child
    const doBlock = parentNode.children.find(
      (c) => c.type === 'do_block' || c.type === 'block',
    );
    if (doBlock) {
      return doBlock.childForFieldName('body') ?? doBlock;
    }

    // Kotlin/JS: trailing lambda literal inside call_suffix
    const callSuffix = parentNode.children.find((c) => c.type === 'call_suffix');
    if (callSuffix) {
      const lambda = callSuffix.children.find(
        (c) => c.type === 'lambda_literal' || c.type === 'trailing_lambda',
      );
      if (lambda) return lambda.childForFieldName('statements') ?? lambda;
    }

    // JS/TS: last argument as arrow_function/function_expression
    const args = parentNode.childForFieldName('arguments');
    if (args) {
      const lastArg = args.children[args.children.length - 1];
      if (
        lastArg &&
        (lastArg.type === 'arrow_function' ||
          lastArg.type === 'function_expression' ||
          lastArg.type === 'lambda_literal')
      ) {
        return lastArg.childForFieldName('body') ?? lastArg;
      }
    }

    // Fallback: search the whole node
    return parentNode;
  }

  if (parentKind === 'class' || parentKind === 'module') {
    return parentNode.childForFieldName('body') ?? parentNode;
  }

  return parentNode;
}

/** Find all parent scope nodes matching parentCall + parentKind. */
function findParentScopes(
  root: SyntaxNode,
  parentCall: string,
  parentKind: string | undefined,
  buf: Buffer,
): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  function walk(node: SyntaxNode): void {
    let match = false;

    if (!parentKind || parentKind === 'call') {
      if (
        node.type === 'call' ||
        node.type === 'call_expression' ||
        node.type === 'method_invocation' ||
        node.type === 'function_call'
      ) {
        const n = getCallName(node, buf);
        if (n === parentCall) match = true;
      }
    }

    if (!parentKind || parentKind === 'class') {
      if (
        node.type === 'class' ||
        node.type === 'class_declaration' ||
        node.type === 'class_definition'
      ) {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nodeText(nameNode, buf) === parentCall) match = true;
      }
    }

    if (!parentKind || parentKind === 'module') {
      if (node.type === 'module' || node.type === 'object_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nodeText(nameNode, buf) === parentCall) match = true;
      }
    }

    if (match) {
      results.push(node);
      // Don't recurse into matched scopes (avoid nested matches at wrong level)
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(root);
  return results;
}

/** Recursively find all child call nodes in a scope body. */
function findChildCallsInScope(
  scopeBody: SyntaxNode,
  childCall: string,
  buf: Buffer,
): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  function walk(node: SyntaxNode): void {
    if (
      node.type === 'call' ||
      node.type === 'call_expression' ||
      node.type === 'method_invocation' ||
      node.type === 'function_call'
    ) {
      const n = getCallName(node, buf);
      if (n === childCall) {
        results.push(node);
        return; // don't look for nested matches inside this call
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(scopeBody);
  return results;
}

/** Get the argument at `position` from a call node's argument list. */
function getArgAtPosition(
  callNode: SyntaxNode,
  position: number,
): SyntaxNode | null {
  // Look for argument_list / arguments child
  const argList =
    callNode.childForFieldName('arguments') ??
    callNode.children.find(
      (c) =>
        c.type === 'argument_list' ||
        c.type === 'arguments' ||
        c.type === 'call_suffix',
    );

  if (!argList) return null;

  let idx = 0;
  for (const child of argList.children) {
    // Skip punctuation and grouping nodes
    if (
      child.type === '(' ||
      child.type === ')' ||
      child.type === ',' ||
      child.type === ' '
    )
      continue;

    if (idx === position) return child;
    idx++;
  }

  return null;
}

/** Map argument node type to the childArgMatches.type expectation. */
function nodeMatchesArgType(
  node: SyntaxNode,
  expectedType: 'symbol' | 'string' | 'identifier',
): boolean {
  if (expectedType === 'symbol') {
    return (
      node.type === 'simple_symbol' ||
      node.type === 'symbol' ||
      node.type === ':' ||
      (node.type === 'pair' && node.children[0]?.type === 'simple_symbol')
    );
  }
  if (expectedType === 'string') {
    return (
      node.type === 'string' ||
      node.type === 'string_literal' ||
      node.type === 'interpreted_string_literal'
    );
  }
  if (expectedType === 'identifier') {
    return node.type === 'identifier' || node.type === 'simple_identifier';
  }
  return false;
}

/**
 * Extract the string value from a symbol/string/identifier argument.
 * E.g. `:authenticate` → "authenticate", `"path"` → "path"
 */
function argValue(node: SyntaxNode, buf: Buffer): string {
  const raw = nodeText(node, buf);
  // Strip leading colon from Ruby symbols
  if (raw.startsWith(':')) return raw.slice(1);
  // Strip quotes from strings
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Find methods defined in the private section of a class/module body node.
 * "Private section" = after a standalone `private` call with no arguments.
 */
function findPrivateMethodsInBody(bodyNode: SyntaxNode | null, buf: Buffer): Set<string> {
  if (!bodyNode) return new Set();
  const privates = new Set<string>();
  let seenPrivate = false;

  for (const child of bodyNode.children) {
    if (!seenPrivate) {
      // Standalone `private` keyword — call node with no significant args
      const isPrivateKeyword =
        (child.type === 'call' && getCallName(child, buf) === 'private') ||
        (child.type === 'identifier' && nodeText(child, buf) === 'private');

      if (isPrivateKeyword) {
        // Only treat as section marker if there are no non-block args
        // (i.e. `private` alone, not `private def foo`)
        const argList = child.childForFieldName('arguments');
        if (!argList || argList.namedChildCount === 0) {
          seenPrivate = true;
          continue;
        }
      }
    }

    if (seenPrivate && child.type === 'method') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) privates.add(nodeText(nameNode, buf));
    }
  }

  return privates;
}

// ─── DB row type ──────────────────────────────────────────────────────────────

interface FileRow {
  path: string;
  raw_content: Buffer | null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  childCall: string;
  parentCall: string;
  parentKind?: 'call' | 'class' | 'module';
  childArgMatches?: {
    position: number;
    type: 'symbol' | 'string' | 'identifier';
    matchesPrivate?: boolean;
  };
  language?: string;
  filePath?: string;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    childCall,
    parentCall,
    parentKind,
    childArgMatches,
    language,
    filePath,
    limit = 100,
  } = args;

  const db = openDatabase(repoId);
  try {
    const repoRow = db
      .prepare<[string], { id: string }>('SELECT id FROM repos WHERE id = ?')
      .get(repoId);
    if (!repoRow) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Repository not found: ${repoId}` }),
          },
        ],
        isError: true,
      };
    }

    // ── Resolve language → allowed extensions ────────────────────────────────
    let allowedExtensions: Set<string> | null = null;
    if (language) {
      const langToExt: Record<string, string[]> = {
        typescript: ['.ts', '.tsx'],
        javascript: ['.js', '.jsx', '.mjs', '.cjs'],
        python: ['.py'],
        go: ['.go'],
        rust: ['.rs'],
        java: ['.java'],
        kotlin: ['.kt', '.kts'],
        ruby: ['.rb'],
        php: ['.php'],
        cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'],
        c: ['.c', '.h'],
        swift: ['.swift'],
        scala: ['.scala'],
        elixir: ['.ex', '.exs'],
      };
      const exts = langToExt[language.toLowerCase()];
      if (exts) allowedExtensions = new Set(exts);
    }

    // ── Build file query ─────────────────────────────────────────────────────
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
    const fileRows = db
      .prepare<Record<string, unknown>, FileRow>(sql)
      .all(params);

    // ── Initialize parser ────────────────────────────────────────────────────
    if (!isInitialized()) {
      await initParser();
    }

    // ── Walk files ───────────────────────────────────────────────────────────
    const matches: Array<{
      filePath: string;
      startLine: number;
      endLine: number;
      snippet: string;
      parentName: string;
      resolvedArg?: string;
    }> = [];
    const skippedFiles: string[] = [];
    let truncated = false;

    for (const row of fileRows) {
      if (!row.raw_content) continue;
      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const fp = row.path;
      const content = row.raw_content;

      // Extension filter
      const ext = fp.includes('.')
        ? `.${fp.split('.').pop()!.toLowerCase()}`
        : '';
      if (allowedExtensions && !allowedExtensions.has(ext)) continue;

      const h = getHandler(fp);
      if (!h || h.grammarPath() === null) {
        if (h) skippedFiles.push(fp);
        continue;
      }

      let tree;
      try {
        tree = await parseFile(content, h);
      } catch {
        skippedFiles.push(fp);
        continue;
      }

      const parentScopes = findParentScopes(
        tree.rootNode,
        parentCall,
        parentKind,
        content,
      );

      for (const parentNode of parentScopes) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }

        const scopeBody = getScopeBody(parentNode, parentKind);
        if (!scopeBody) continue;

        // Build private method set for this scope (if matchesPrivate is needed)
        let privateMethods: Set<string> | null = null;
        if (childArgMatches?.matchesPrivate) {
          privateMethods = findPrivateMethodsInBody(scopeBody, content);
        }

        const childCalls = findChildCallsInScope(scopeBody, childCall, content);

        for (const callNode of childCalls) {
          if (matches.length >= limit) {
            truncated = true;
            break;
          }

          let resolvedArg: string | undefined;

          if (childArgMatches) {
            const argNode = getArgAtPosition(callNode, childArgMatches.position);
            if (!argNode) continue;
            if (!nodeMatchesArgType(argNode, childArgMatches.type)) continue;

            resolvedArg = argValue(argNode, content);

            if (childArgMatches.matchesPrivate && privateMethods) {
              if (!privateMethods.has(resolvedArg)) continue;
            }
          }

          const startLine = charIndexToLine(content, callNode.startIndex);
          const endLine = charIndexToLine(content, callNode.endIndex);
          const rawText = decoded(content).slice(callNode.startIndex, callNode.endIndex);
          const snippet =
            rawText.length > 150 ? rawText.slice(0, 150) + '…' : rawText;

          matches.push({
            filePath: fp,
            startLine,
            endLine,
            snippet,
            parentName: parentCall,
            ...(resolvedArg !== undefined ? { resolvedArg } : {}),
          });
        }
      }

      if (truncated) break;
    }

    const responseBytes = matches.reduce(
      (sum, m) => sum + m.snippet.length + m.filePath.length + 60,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              matches,
              totalFound: matches.length,
              truncated,
              parentCall,
              childCall,
              skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
              _tokenEstimate: tokenEstimate,
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            },
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    db.close();
  }
}
