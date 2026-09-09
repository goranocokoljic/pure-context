import { readdirSync, existsSync } from 'fs';
import { z } from 'zod';
import { getIndexDir, getJobsDir, openDatabase, getRepo } from '../../core/db/schema.js';
import { readHeadDrift, formatDriftLine } from '../../core/git-head.js';
import { getRepoLinks } from '../../core/db/link-store.js';
import { describeLinkDrift, formatLinkDriftLine } from '../../core/workspace-links.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'list_repos';

export const description =
  'List all indexed repositories. Scans the local index directory and returns ' +
  'metadata (repo ID, root path, symbol count, file count, last indexed time) ' +
  'for every project that has been indexed. Each git-backed repo also carries `head` — ' +
  "the sha the index reflects vs the checkout's HEAD (behindBy commits, dirtyFiles, " +
  'inProgress when a detached re-index is running) and a one-line `freshness` verdict. ' +
  'Read it before trusting an index: "behind" → index_folder({ path, onlyChanged: true }). ' +
  '`links` (when present) lists the indexes this one resolves dependency edges across ' +
  '(same git checkout, or graph.linkedRepos) with per-link drift — "moved" means re-run ' +
  'index_folder on THIS repo to re-resolve the seam.';

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
      const storedLinks = meta ? getRepoLinks(db, repoId) : [];
      db.close();
      if (meta) {
        // Filter by workspace if specified
        if (args.workspaceId && meta.tenantId !== args.workspaceId) continue;
        // Phase 97: drift vs the working tree (bounded git calls; omitted
        // when the root is not a git checkout or no longer exists).
        const head = readHeadDrift(meta.rootPath, meta.gitTreeSha ?? null, {
          jobsDir: getJobsDir(),
          repoId,
        });
        // Phase 99: per-link drift (sibling HEAD now vs when the edges were built).
        const links = storedLinks.map((l) => {
          const d = describeLinkDrift(l);
          return { ...d, line: formatLinkDriftLine(d) };
        });
        repos.push({
          ...meta,
          workspaceId: meta.tenantId ?? 'local',
          ...(head ? { head, freshness: formatDriftLine(head) } : {}),
          ...(links.length > 0 ? { links } : {}),
        });
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
