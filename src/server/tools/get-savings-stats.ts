import { z } from 'zod';
import {
  getTotalSaved,
  resetSavings,
  getSessionStart,
} from '../../core/token-tracker.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Context window sizes (in tokens) ────────────────────────────────────────

const CONTEXT_WINDOWS = {
  claude_200k: 200_000,
  gpt4_128k: 128_000,
} as const;

// ─── Tool definition ──────────────────────────────────────────────────────────

export const name = 'get_savings_stats';

export const description =
  'Query cumulative token savings tracked across all PureContext tool calls. ' +
  'Returns total tokens saved, cost avoided per model tier, and context-window equivalents. ' +
  'Pass reset:true to clear the counter and start fresh.';

export const inputSchema = {
  reset: z
    .boolean()
    .optional()
    .default(false)
    .describe('Reset the savings counter to zero (returns previous total)'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: { reset?: boolean }): CallToolResult {
  if (args.reset) {
    const previous = resetSavings();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ reset: true, previous_total: previous }, null, 2),
        },
      ],
    };
  }

  const total = getTotalSaved();

  const equivalent_context_windows: Record<string, number> = {};
  for (const [label, size] of Object.entries(CONTEXT_WINDOWS)) {
    equivalent_context_windows[label] = parseFloat((total / size).toFixed(2));
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_tokens_saved: total,
            equivalent_context_windows,
            session_start: getSessionStart().toISOString(),
            _meta: {
              powered_by: 'PureContext MCP',
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}
