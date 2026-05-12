/**
 * get-public-api.ts
 *
 * MCP tool: get_public_api
 *
 * Returns the public API surface of a repository: all exported symbols, grouped
 * by file. A symbol is "public" when its signature begins with the `export`
 * keyword (TypeScript/JavaScript export declarations, re-exports included).
 *
 * Designed for:
 *   - Onboarding: "what does this library expose?"
 *   - API contract review: "has the surface changed between snapshots?"
 *   - Documentation seeding: enumerate exports to generate docs
 *   - Dependency analysis: know what consumers can legally import
 *
 * Use find_dead_code to find exported symbols that nobody imports.
 * Use get_blast_radius before removing an export to understand downstream impact.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

export const name = 'get_public_api';

export const description =
  'Return the public API surface of a repository: all exported symbols, grouped by file. ' +
  'A symbol is considered public when its signature begins with the export keyword. ' +
  'Use this to answer "what does this library expose?", audit API contracts, seed ' +
  'documentation, or compare the public surface before and after a refactor. ' +
  'Each result includes symbolId, name, kind, signature, summary, file path, and ' +
  'whether the symbol is a default export.' +
  '\n\nRelated tools:' +
  '\n  find_dead_code   — exported symbols that nobody imports' +
  '\n  get_blast_radius — downstream impact of removing an export' +
  '\n  get_repo_outline — all symbols (exported and unexported) by file';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Restrict to a specific file path or directory prefix ' +
      '(e.g. "src/services/" returns all exports from that subtree)',
    ),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
    ])
    .optional()
    .describe('Filter results to a specific symbol kind'),
  includeMembers: z
    .boolean()
    .optional()
    .describe(
      'When true, also include public methods of exported classes. ' +
      'Methods do not carry the export keyword themselves but are part of the exported ' +
      'API surface. Only effective when kind is not set (default false).',
    ),
  groupByFile: z
    .boolean()
    .optional()
    .describe('Group results by file (default true). Set false for a flat sorted list.'),
  limit: z
    .number().int().positive().optional()
    .describe('Maximum number of exported symbols to return (default 500)'),
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  signature: string;
  summary: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath?: string;
  kind?: string;
  includeMembers?: boolean;
  groupByFile?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    includeMembers = false,
    groupByFile = true,
    limit = 500,
  } = args;

  const db = openDatabase(repoId);
  try {
    // ── Validate repo exists ───────────────────────────────────────────────────
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }),
        }],
        isError: true,
      };
    }

    // ── Query exported symbols ─────────────────────────────────────────────────
    // A symbol is exported if its signature begins with "export"
    const conditions: string[] = [
      'repo_id = @repoId',
      "(signature LIKE 'export %' OR signature LIKE 'export' OR signature LIKE 'export\n%')",
    ];
    const params: Record<string, unknown> = { repoId };

    if (args.kind) {
      conditions.push('kind = @kind');
      params['kind'] = args.kind;
    }
    if (args.filePath) {
      conditions.push('(file_path = @filePath OR file_path LIKE @filePathPrefix)');
      params['filePath'] = args.filePath;
      params['filePathPrefix'] = `${args.filePath}%`;
    }
    params['limit'] = limit;

    const exportedSql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path ASC, start_byte ASC
      LIMIT @limit
    `;

    const rows: SymbolRow[] = db
      .prepare<Record<string, unknown>, SymbolRow>(exportedSql)
      .all(params);

    // ── Optionally include methods of exported classes ─────────────────────────
    if (includeMembers && !args.kind) {
      const exportedClassFiles = new Set(
        rows
          .filter((r) => r.kind === 'class' || r.kind === 'component')
          .map((r) => r.file_path),
      );

      if (exportedClassFiles.size > 0) {
        const existingIds = new Set(rows.map((r) => r.id));
        const fileList = Array.from(exportedClassFiles);
        const placeholders = fileList.map((_, i) => `@fp${i}`).join(', ');
        const memberParams: Record<string, unknown> = { repoId };
        fileList.forEach((fp, i) => { memberParams[`fp${i}`] = fp; });

        const memberSql = `
          SELECT id, name, kind, file_path, start_byte, signature, summary
          FROM symbols
          WHERE repo_id = @repoId
            AND kind = 'method'
            AND file_path IN (${placeholders})
          ORDER BY file_path ASC, start_byte ASC
        `;
        const memberRows = db
          .prepare<Record<string, unknown>, SymbolRow>(memberSql)
          .all(memberParams);

        for (const r of memberRows) {
          if (!existingIds.has(r.id)) {
            rows.push(r);
          }
        }
        rows.sort(
          (a, b) => a.file_path.localeCompare(b.file_path) || a.start_byte - b.start_byte,
        );
      }
    }

    // ── Compute startLine from stored file content ─────────────────────────────
    const fileSymbols = new Map<string, SymbolRow[]>();
    for (const row of rows) {
      const list = fileSymbols.get(row.file_path) ?? [];
      list.push(row);
      fileSymbols.set(row.file_path, list);
    }

    const lineMap = new Map<string, number>();
    let rawBytes = 0;
    for (const [filePath, syms] of fileSymbols) {
      const fileRow = db
        .prepare<[string, string], { raw_content: Buffer | null }>(
          'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
        )
        .get(repoId, filePath);

      if (fileRow?.raw_content) {
        rawBytes += fileRow.raw_content.length;
        const content = fileRow.raw_content;
        for (const sym of syms) {
          const slice = content.slice(0, Math.min(sym.start_byte, content.length));
          let line = 1;
          for (let i = 0; i < slice.length; i++) {
            if (slice[i] === 0x0a) line++;
          }
          lineMap.set(sym.id, line);
        }
      } else {
        for (const sym of syms) {
          lineMap.set(sym.id, Math.max(1, Math.floor(sym.start_byte / 80) + 1));
        }
      }
    }

    // ── Shape symbols ─────────────────────────────────────────────────────────
    const shaped = rows.map((row) => ({
      symbolId: row.id,
      name: row.name,
      kind: row.kind as SymbolKind,
      filePath: row.file_path,
      startLine: lineMap.get(row.id) ?? 1,
      signature: row.signature,
      summary: row.summary,
      isDefault: row.signature.includes('export default'),
    }));

    const responseBytes = shaped.reduce(
      (sum, s) => sum + s.signature.length + s.summary.length + s.filePath.length + 80,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    // ── Format output ─────────────────────────────────────────────────────────
    const uniqueFileCount = fileSymbols.size;

    let output: unknown;
    if (groupByFile) {
      const byFile = new Map<string, typeof shaped>();
      for (const sym of shaped) {
        const list = byFile.get(sym.filePath) ?? [];
        list.push(sym);
        byFile.set(sym.filePath, list);
      }
      const files = Array.from(byFile.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([filePath, exports]) => ({ filePath, exports }));

      output = {
        totalExported: shaped.length,
        fileCount: files.length,
        files,
        _tokenEstimate: tokenEstimate,
        _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
      };
    } else {
      output = {
        totalExported: shaped.length,
        fileCount: uniqueFileCount,
        symbols: shaped,
        _tokenEstimate: tokenEstimate,
        _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
