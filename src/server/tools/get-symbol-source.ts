import { z } from 'zod';
import { join } from 'node:path';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { computeSymbolRisk } from './symbol-risk.js';
import { getFileContent, getFileHash, getFileSizeBytes } from '../../core/db/file-store.js';
import { validatePath } from '../../core/security.js';
import { buildMeta } from './_meta.js';
import {
  MAX_CONTEXT_LINES,
  expandWithContextLines,
  verifyContentHash,
} from '../../core/symbol-source-helper.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_symbol_source';

export const description =
  'Retrieve the raw source code of a specific symbol using its byte offsets. ' +
  'Returns only the symbol definition, not the entire file. ' +
  'Optionally expand with surrounding context lines or verify the cached hash. ' +
  'Use search_symbols or get_file_outline to find symbol IDs first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID from search_symbols or get_file_outline'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Lines of surrounding code to include before and after the symbol boundary. ` +
      `Default 0 (symbol only). Clamped to ${MAX_CONTEXT_LINES}.`,
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      'Re-hash the source file from disk and compare with the stored hash. ' +
      'Sets hashDrift: true when the file has changed since indexing. ' +
      'Performance cost: one disk read per call.',
    ),
  includeRisk: z
    .boolean()
    .optional()
    .describe(
      'When true, attach a compact change-risk verdict { band, riskScore } ' +
      '(Phase 76). Default false (no extra cost). Use get_symbol_risk for the ' +
      'full factor breakdown.',
    ),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go',
    java: 'java', cs: 'csharp', rb: 'ruby',
    css: 'css', scss: 'scss', html: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'bash',
    ex: 'elixir', exs: 'elixir',
    hs: 'haskell', scala: 'scala', r: 'r',
  };
  return map[ext] ?? 'text';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

interface GetSymbolSourceArgs {
  repoId: string;
  symbolId: string;
  contextLines?: number;
  verify?: boolean;
  includeRisk?: boolean;
}

export function handler(args: GetSymbolSourceArgs): CallToolResult {
  const t0 = Date.now();
  const { repoId, symbolId, verify = false, includeRisk = false } = args;

  // Clamp contextLines to [0, MAX_CONTEXT_LINES].
  const requestedLines = args.contextLines ?? 0;
  const clamped = requestedLines > MAX_CONTEXT_LINES;
  const contextLines = Math.min(requestedLines, MAX_CONTEXT_LINES);

  const db = openDatabase(repoId);

  const symbol = getSymbolById(db, repoId, symbolId);
  if (!symbol) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${symbolId}" not found` }) }],
      isError: true,
    };
  }

  const repo = getRepo(db, repoId);
  if (repo) {
    try {
      validatePath(symbol.filePath, repo.rootPath);
    } catch (err) {
      db.close();
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  }

  const raw = getFileContent(db, repoId, symbol.filePath);
  const rawBytes = getFileSizeBytes(db, repoId, symbol.filePath);

  // Compact risk verdict (opt-in) — computed while the db is still open.
  let risk: { band: string; riskScore: number } | undefined;
  if (includeRisk) {
    const r = computeSymbolRisk(db, repoId, symbolId);
    if (r) risk = { band: r.band, riskScore: r.riskScore };
  }

  // Hash drift detection — one disk read, only when requested.
  let hashDrift: boolean | undefined;
  let diskHash: string | undefined;
  let cachedHash: string | undefined;

  if (verify && repo) {
    const stored = getFileHash(db, repoId, symbol.filePath);
    const absPath = join(repo.rootPath, symbol.filePath);
    const result = verifyContentHash(absPath, stored);

    hashDrift = result.drift;
    if (result.drift) {
      diskHash = result.diskHash ?? undefined;
      cachedHash = stored ?? undefined;
    }
  }

  db.close();

  if (!raw) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Source content for "${symbol.filePath}" is not cached. Re-index with content storage enabled.`,
          }),
        },
      ],
      isError: true,
    };
  }

  const source = expandWithContextLines(raw, symbol.startByte, symbol.endByte, contextLines);
  const responseBytes = Buffer.byteLength(source, 'utf8');

  const symbolOutput: Record<string, unknown> = {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    signature: symbol.signature,
    summary: symbol.summary,
    source,
    language: getLanguageFromPath(symbol.filePath),
  };

  if (contextLines > 0) {
    symbolOutput['contextLines'] = contextLines;
  }

  if (verify) {
    symbolOutput['hashDrift'] = hashDrift;
    if (hashDrift && diskHash !== undefined) {
      symbolOutput['diskHash'] = diskHash;
      symbolOutput['cachedHash'] = cachedHash;
    }
  }

  if (includeRisk && risk) {
    symbolOutput['risk'] = risk;
  }

  const response: Record<string, unknown> = {
    symbol: symbolOutput,
    _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
  };

  if (clamped) {
    response['_warnings'] = [
      `contextLines clamped from ${requestedLines} to ${MAX_CONTEXT_LINES}`,
    ];
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
