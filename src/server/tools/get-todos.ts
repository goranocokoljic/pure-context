/**
 * get-todos.ts
 *
 * MCP tool: get_todos
 *
 * Scans indexed file content for TODO/FIXME/HACK/NOTE/OPTIMIZE/BUG/XXX
 * comment tags. Returns each occurrence with its file path, line number,
 * tag type, optional assignee (e.g. TODO(alice):), and the comment text.
 *
 * Designed for:
 *   - Tracking outstanding work items embedded in source code
 *   - Generating a tech-debt inventory from comment annotations
 *   - Finding all FIXMEs before a release cutoff
 *   - Auditing comment hygiene across a codebase
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllFilesWithContent } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_todos';

export const description =
  'Scan all indexed source files for TODO/FIXME/HACK/NOTE/OPTIMIZE/BUG/XXX comment tags. ' +
  'Returns each occurrence with file path, line number, tag type, optional assignee ' +
  '(e.g. TODO(alice):), and the comment text. ' +
  'Use this to generate a tech-debt inventory, find all FIXMEs before a release, or ' +
  'audit comment hygiene across a codebase. ' +
  'Supports filtering by tag type, assignee name, and file path.' +
  '\n\nRelated tools:' +
  '\n  get_debt_report      — structured tech-debt metrics including comment-based debt' +
  '\n  get_complexity_hotspots — identify complex symbols that may have hidden TODOs' +
  '\n  search_text          — free-form text search across file content';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  tags: z
    .array(z.enum(['TODO', 'FIXME', 'HACK', 'NOTE', 'OPTIMIZE', 'BUG', 'XXX']))
    .optional()
    .describe(
      'Tag types to scan for. Defaults to all seven tags: ' +
      'TODO, FIXME, HACK, NOTE, OPTIMIZE, BUG, XXX.',
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      'Restrict to a specific file path or directory prefix ' +
      '(e.g. "src/services/" returns todos from that subtree only)',
    ),
  assignee: z
    .string()
    .optional()
    .describe(
      'Filter by assignee name. Matches "TODO(alice)" when assignee="alice". ' +
      'Case-insensitive.',
    ),
  groupByFile: z
    .boolean()
    .optional()
    .describe('Group results by file (default true). Set false for a flat sorted list.'),
  limit: z
    .number().int().positive()
    .optional()
    .describe('Maximum number of todo items to return (default 200)'),
};

// ─── Internal types ───────────────────────────────────────────────────────────

export interface TodoItem {
  filePath: string;
  line: number;
  tag: string;
  assignee: string | null;
  text: string;
}

const ALL_TAGS = ['TODO', 'FIXME', 'HACK', 'NOTE', 'OPTIMIZE', 'BUG', 'XXX'] as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  tags?: string[];
  filePath?: string;
  assignee?: string;
  groupByFile?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    groupByFile = true,
    limit = 200,
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

    // ── Build tag regex ────────────────────────────────────────────────────────
    const activeTags = (args.tags && args.tags.length > 0)
      ? args.tags.map((t) => t.toUpperCase())
      : [...ALL_TAGS];

    const tagAlternation = activeTags.join('|');
    // Matches: TODO, TODO:, TODO(alice), TODO(alice):
    // Group 1 = tag, Group 2 = assignee (optional), Group 3 = trailing text
    const pattern = new RegExp(
      `\\b(${tagAlternation})\\b(?:\\(([^)]+)\\))?[:\\s]*(.*)`,
      'i',
    );

    // ── Load and scan files ────────────────────────────────────────────────────
    const files = getAllFilesWithContent(db, repoId);
    const todos: TodoItem[] = [];
    let rawBytes = 0;
    let truncated = false;

    for (const file of files) {
      if (!file.rawContent) continue;

      // Apply file path filter
      if (args.filePath) {
        const fp = file.path;
        if (fp !== args.filePath && !fp.startsWith(args.filePath)) {
          continue;
        }
      }

      rawBytes += file.rawContent.length;
      const text = file.rawContent.toString('utf8');
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = pattern.exec(line);
        if (!m) continue;

        const tag = m[1].toUpperCase();
        const assignee = m[2] ? m[2].trim() : null;
        const itemText = m[3]
          ? m[3].replace(/\*\/$/, '').trim()  // strip trailing */ from block comments
          : '';

        // Apply assignee filter
        if (args.assignee) {
          if (!assignee || assignee.toLowerCase() !== args.assignee.toLowerCase()) {
            continue;
          }
        }

        todos.push({
          filePath: file.path,
          line: i + 1,
          tag,
          assignee,
          text: itemText,
        });

        if (todos.length >= limit) {
          truncated = true;
          break;
        }
      }

      if (truncated) break;
    }

    // ── Build response ─────────────────────────────────────────────────────────
    const responseBytes = todos.reduce(
      (sum, t) => sum + t.filePath.length + t.text.length + (t.assignee?.length ?? 0) + 40,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    // ── Tag summary ────────────────────────────────────────────────────────────
    const tagCounts: Record<string, number> = {};
    for (const todo of todos) {
      tagCounts[todo.tag] = (tagCounts[todo.tag] ?? 0) + 1;
    }

    let output: unknown;
    if (groupByFile) {
      const byFile = new Map<string, TodoItem[]>();
      for (const item of todos) {
        const list = byFile.get(item.filePath) ?? [];
        list.push(item);
        byFile.set(item.filePath, list);
      }

      const files2 = Array.from(byFile.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([filePath, items]) => ({ filePath, todos: items }));

      output = {
        totalTodos: todos.length,
        fileCount: byFile.size,
        tagCounts,
        truncated,
        files: files2,
        _tokenEstimate: tokenEstimate,
        _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
      };
    } else {
      output = {
        totalTodos: todos.length,
        fileCount: new Set(todos.map((t) => t.filePath)).size,
        tagCounts,
        truncated,
        todos,
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
