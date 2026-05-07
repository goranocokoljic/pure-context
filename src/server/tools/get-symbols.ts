import { z } from 'zod';
import { join } from 'node:path';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getFileContent, getFileHash } from '../../core/db/file-store.js';
import { TooManySymbolsError } from '../../core/errors.js';
import { buildMeta } from './_meta.js';
import {
  MAX_CONTEXT_LINES,
  expandWithContextLines,
  verifyContentHash,
} from '../../core/symbol-source-helper.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

export const name = 'get_symbols';

export const description =
  'Batch-fetch full source code for a list of known symbol IDs in a single call. ' +
  'More efficient than calling get_symbol_source N times. ' +
  'Use search_symbols or get_file_outline to discover symbol IDs first. ' +
  'Optionally expand each result with surrounding context lines, or verify the ' +
  'cached content hash against disk.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolIds: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe('Up to 50 symbol IDs to fetch (from search_symbols / get_file_outline)'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Number of surrounding lines to include before/after each symbol boundary. ` +
      `Clamped to ${MAX_CONTEXT_LINES}.`,
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      'Re-hash each file from disk and compare with the stored hash. ' +
      'Sets hashDrift: true on results where the file has changed since indexing.',
    ),
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SYMBOLS = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DbSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  signature: string;
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSymbolsByIds(
  db: Database.Database,
  repoId: string,
  ids: string[],
): Map<string, DbSymbolRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], DbSymbolRow>(
      `SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
       FROM symbols
       WHERE repo_id = ? AND id IN (${placeholders})`,
    )
    .all(repoId, ...ids);
  return new Map(rows.map((r) => [r.id, r]));
}


// ─── Handler ──────────────────────────────────────────────────────────────────

interface GetSymbolsArgs {
  repoId: string;
  symbolIds: string[];
  contextLines?: number;
  verify?: boolean;
}

interface SymbolResult {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  source: string;
  signature: string;
  summary: string;
  hashDrift?: boolean;
}

export function handler(args: GetSymbolsArgs): CallToolResult {
  const t0 = Date.now();
  const { repoId, symbolIds, verify = false } = args;

  // Clamp contextLines to [0, MAX_CONTEXT_LINES].
  const contextLines = Math.min(args.contextLines ?? 0, MAX_CONTEXT_LINES);

  if (symbolIds.length > MAX_SYMBOLS) {
    throw new TooManySymbolsError(symbolIds.length, MAX_SYMBOLS);
  }

  const db = openDatabase(repoId);

  try {
    const symbolMap = getSymbolsByIds(db, repoId, symbolIds);
    const repo = verify ? getRepo(db, repoId) : null;

    // Per-file caches — avoid re-loading the same file for multiple symbols.
    const fileCache = new Map<string, Buffer | null>();
    const storedHashCache = new Map<string, string | null>();
    const verifyCache = new Map<string, { drift: boolean; diskHash: string | null }>();

    let totalResponseBytes = 0;
    let totalRawBytes = 0;

    const found: SymbolResult[] = [];
    const notFound: string[] = [];

    for (const id of symbolIds) {
      const row = symbolMap.get(id);
      if (!row) {
        notFound.push(id);
        continue;
      }

      // Load file content (cached per file path).
      if (!fileCache.has(row.file_path)) {
        fileCache.set(row.file_path, getFileContent(db, repoId, row.file_path));
      }
      const content = fileCache.get(row.file_path) ?? null;
      if (content) totalRawBytes += content.length;

      const source = content
        ? expandWithContextLines(content, row.start_byte, row.end_byte, contextLines)
        : '';

      totalResponseBytes += Buffer.byteLength(source, 'utf8');

      const result: SymbolResult = {
        symbolId: id,
        name: row.name,
        kind: row.kind,
        filePath: row.file_path,
        source,
        signature: row.signature,
        summary: row.summary,
      };

      // Hash drift detection — one disk read per file, only when requested.
      if (verify && repo) {
        if (!storedHashCache.has(row.file_path)) {
          storedHashCache.set(row.file_path, getFileHash(db, repoId, row.file_path));
        }
        if (!verifyCache.has(row.file_path)) {
          const absPath = join(repo.rootPath, row.file_path);
          const stored = storedHashCache.get(row.file_path) ?? null;
          verifyCache.set(row.file_path, verifyContentHash(absPath, stored));
        }

        result.hashDrift = verifyCache.get(row.file_path)!.drift;
      }

      found.push(result);
    }

    db.close();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              found,
              notFound,
              _meta: buildMeta({
                timingMs: Date.now() - t0,
                rawBytes: totalRawBytes,
                responseBytes: totalResponseBytes,
              }),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
