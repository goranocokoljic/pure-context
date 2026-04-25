import { z } from 'zod';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { computeRepoId, getIndexDir, openDatabase, getRepo } from '../../core/db/schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'resolve_repo';

export const description =
  'Resolve a local path to its repo ID and check whether it has been indexed. ' +
  'Use this to get the repoId before calling other tools, or to check if a ' +
  'project needs (re-)indexing.';

export const inputSchema = {
  path: z.string().describe('Absolute or relative path to the project root'),
};

export function handler(args: { path: string }): CallToolResult {
  const absPath = resolve(args.path);
  const repoId = computeRepoId(absPath);
  const dbPath = join(getIndexDir(), `${repoId}.db`);
  const indexed = existsSync(dbPath);

  if (!indexed) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            repoId,
            rootPath: absPath,
            indexed: false,
            hint: 'Call index_folder first to index this project.',
          }, null, 2),
        },
      ],
    };
  }

  const db = openDatabase(repoId);
  const meta = getRepo(db, repoId);
  db.close();

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ indexed: true, ...meta }, null, 2),
      },
    ],
  };
}
