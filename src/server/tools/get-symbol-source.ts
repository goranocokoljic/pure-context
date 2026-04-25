import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getFileContent, getFileSizeBytes } from '../../core/db/file-store.js';
import { validatePath } from '../../core/security.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_symbol_source';

export const description =
  'Retrieve the raw source code of a specific symbol using its byte offsets. ' +
  'Returns only the symbol definition, not the entire file. ' +
  'Use search_symbols or get_file_outline to find symbol IDs first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID from search_symbols or get_file_outline'),
};

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

export function handler(args: { repoId: string; symbolId: string }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);

  const symbol = getSymbolById(db, args.repoId, args.symbolId);
  if (!symbol) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${args.symbolId}" not found` }) }],
      isError: true,
    };
  }

  const repo = getRepo(db, args.repoId);
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

  const raw = getFileContent(db, args.repoId, symbol.filePath);
  const rawBytes = getFileSizeBytes(db, args.repoId, symbol.filePath);
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

  const responseBytes = symbol.endByte - symbol.startByte;
  const source = raw.slice(symbol.startByte, symbol.endByte).toString('utf8');

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbol: {
              id: symbol.id,
              name: symbol.name,
              kind: symbol.kind,
              filePath: symbol.filePath,
              signature: symbol.signature,
              summary: symbol.summary,
              source,
              language: getLanguageFromPath(symbol.filePath),
            },
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
