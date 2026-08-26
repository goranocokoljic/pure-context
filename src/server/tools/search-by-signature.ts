/**
 * search-by-signature.ts
 *
 * MCP tool: search_by_signature
 *
 * Find all symbols whose type signature matches a pattern — e.g. all functions
 * returning `Promise<void>`, all functions accepting a `Request` parameter,
 * all async functions.
 *
 * Implementation: pure SQL against the `symbols.signature` column.
 * Three modes:
 *  - contains   → WHERE signature LIKE '%pattern%'   (default)
 *  - startsWith → WHERE signature LIKE 'pattern%'
 *  - regex      → user-defined REGEXP function via better-sqlite3
 *
 * No AST re-parsing needed — signatures are stored as one-line strings.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { byteOffsetToLine } from './symbol-lines.js';
import type { SymbolKind } from '../../core/types.js';
import type Database from 'better-sqlite3';

export const name = 'search_by_signature';

export const description =
  'Find all symbols whose type signature matches a pattern. ' +
  'Use this to locate all async functions, all functions returning a specific type, ' +
  'all functions accepting a particular parameter type, or all exported symbols — ' +
  'without reading files. Operates on the stored one-line signature string for every ' +
  'indexed symbol. Three match modes: "contains" (default), "startsWith", "regex". ' +
  '\n\nPattern examples:' +
  '\n  "Promise<void>"     — all functions returning Promise<void>' +
  '\n  "async"             — all async functions (signature starts with "async")' +
  '\n  "(req: Request"     — all functions taking a Request parameter' +
  '\n  ": string[]"        — all functions returning string[]' +
  '\n  "@Injectable"       — all symbols with Injectable decorator in signature' +
  '\n  "export async"      — all exported async symbols (startsWith mode)';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  pattern: z
    .string()
    .describe('Pattern to match against the symbol signature string'),
  mode: z
    .enum(['contains', 'startsWith', 'regex'])
    .optional()
    .describe(
      'Match mode: "contains" (default) — signature contains pattern; ' +
      '"startsWith" — signature starts with pattern; ' +
      '"regex" — pattern is a JavaScript-compatible regular expression',
    ),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
    ])
    .optional()
    .describe('Filter results to a specific symbol kind'),
  filePath: z
    .string()
    .optional()
    .describe('Restrict search to a specific file path or directory prefix'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return (default 50)'),
};

// ─── Row type from the DB query ───────────────────────────────────────────────

interface SignatureRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  signature: string;
  summary: string;
}

// ─── Helper: register REGEXP on a db connection ───────────────────────────────

function registerRegexp(db: InstanceType<typeof Database>): void {
  // SQLite does not ship with REGEXP — register a JS implementation.
  // The function is invoked by SQLite as: regexp(pattern, value)
  // which corresponds to: value REGEXP pattern
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    try {
      const re = new RegExp(String(pattern));
      return re.test(String(value ?? '')) ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  pattern: string;
  mode?: 'contains' | 'startsWith' | 'regex';
  kind?: string;
  filePath?: string;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const mode = args.mode ?? 'contains';
  const limit = args.limit ?? 50;

  // ── Validate regex before touching the DB ─────────────────────────────────
  if (mode === 'regex') {
    try {
      new RegExp(args.pattern);
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Invalid regular expression: ${(err as Error).message}`,
            pattern: args.pattern,
          }),
        }],
        isError: true,
      };
    }
  }

  const db = openDatabase(args.repoId);
  try {
    if (mode === 'regex') {
      registerRegexp(db);
    }

    // ── Build query ──────────────────────────────────────────────────────────
    const conditions: string[] = ['repo_id = @repoId'];
    const params: Record<string, unknown> = { repoId: args.repoId };

    if (mode === 'contains') {
      conditions.push('signature LIKE @sigPattern');
      params['sigPattern'] = `%${args.pattern}%`;
    } else if (mode === 'startsWith') {
      conditions.push('signature LIKE @sigPattern');
      params['sigPattern'] = `${args.pattern}%`;
    } else {
      // regex — uses the REGEXP function registered above
      conditions.push('signature REGEXP @sigPattern');
      params['sigPattern'] = args.pattern;
    }

    if (args.kind) {
      conditions.push('kind = @kind');
      params['kind'] = args.kind;
    }

    if (args.filePath) {
      conditions.push('(file_path = @filePath OR file_path LIKE @filePathPrefix)');
      params['filePath'] = args.filePath;
      params['filePathPrefix'] = `${args.filePath}%`;
    }

    const sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path, start_byte
      LIMIT @limit
    `;
    params['limit'] = limit;

    const rows = db.prepare<Record<string, unknown>, SignatureRow>(sql).all(params);

    // ── Compute startLine approximation from file content ─────────────────────
    // Group symbols by file to batch file reads
    const fileSymbols = new Map<string, SignatureRow[]>();
    for (const row of rows) {
      const list = fileSymbols.get(row.file_path) ?? [];
      list.push(row);
      fileSymbols.set(row.file_path, list);
    }

    const lineMap = new Map<string, number>(); // id → startLine

    for (const [filePath, syms] of fileSymbols) {
      // Try to get file content for accurate line numbers
      const fileRow = db.prepare<[string, string], { raw_content: Buffer | null }>(
        'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
      ).get(args.repoId, filePath);

      if (fileRow?.raw_content) {
        const content = fileRow.raw_content;
        for (const sym of syms) {
          lineMap.set(sym.id, byteOffsetToLine(content, sym.start_byte));
        }
      } else {
        // Fallback: rough approximation
        for (const sym of syms) {
          lineMap.set(sym.id, Math.max(1, Math.floor(sym.start_byte / 80) + 1));
        }
      }
    }

    const symbols = rows.map((row) => ({
      symbolId: row.id,
      name: row.name,
      kind: row.kind as SymbolKind,
      filePath: row.file_path,
      startLine: lineMap.get(row.id) ?? 1,
      signature: row.signature,
      summary: row.summary,
    }));

    // ── Token estimate ─────────────────────────────────────────────────────────
    const responseBytes = symbols.reduce(
      (sum, s) => sum + s.signature.length + s.summary.length + s.filePath.length + 50,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            symbols,
            totalFound: symbols.length,
            patternUsed: args.pattern,
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
