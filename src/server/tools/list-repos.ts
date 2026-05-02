import { readdirSync, existsSync } from 'fs';
import { z } from 'zod';
import { getIndexDir, openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'list_repos';

export const description =
  'List all indexed repositories. Scans the local index directory and returns ' +
  'metadata (repo ID, root path, symbol count, file count, last indexed time) ' +
  'for every project that has been indexed.';

export const inputSchema = {
  workspaceId: z.string().optional().describe(
    'Filter repos by workspace ID. When omitted, returns all repos (single-user mode).'
  ),
};

export function handler(args: { workspaceId?: string } = {}): CallToolResult {
  const t0 = Date.now();
  const dir = getIndexDir();

  if (!existsSync(dir)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            repos: [],
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          }),
        },
      ],
    };
  }

  const repos: object[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const repoId = file.slice(0, -3);
    try {
      const db = openDatabase(repoId);
      const meta = getRepo(db, repoId);
      db.close();
      if (meta) {
        // Filter by workspace if specified
        if (args.workspaceId && meta.tenantId !== args.workspaceId) continue;
        repos.push({ ...meta, workspaceId: meta.tenantId ?? 'local' });
      }
    } catch {
      // Corrupt or unreadable DB — skip silently
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repos,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
