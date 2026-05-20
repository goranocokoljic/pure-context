/**
 * trace-invocation-chain.ts
 *
 * MCP tool: trace_invocation_chain
 *
 * Trace multi-hop call chains from a start symbol forward through callees,
 * returning all discovered paths as ordered symbol lists. Useful for questions
 * like "what execution path leads from this API endpoint to a background worker?"
 *
 * Strategy: query-time text scan (same as get_call_hierarchy) — no pre-built
 * call edges required. Scans symbol source text for `identifier(` patterns and
 * matches them against all indexed symbols in the repo.
 *
 * Cycle detection: back-edges are included as leaf nodes with `cyclic: true`
 * so the traversal terminates and the caller can see the cycle.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolsByRepo } from '../../core/db/symbol-store.js';
import { getFileContent } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolRecord } from '../../core/types.js';

export const name = 'trace_invocation_chain';

export const description =
  'Trace all call chains from a start symbol forward through its callees, ' +
  'returning each discovered path as an ordered list of symbols. ' +
  'Use endHint to truncate chains at a symbol matching a glob pattern ' +
  '(e.g. "*Worker", "*Service"). ' +
  'Cycles are detected and annotated with cyclic=true rather than looping. ' +
  'Useful for multi-hop traces like "route handler → service → background worker". ' +
  'Use search_symbols to find the symbolId or name of the start symbol first.';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  startSymbol: z
    .string()
    .min(1)
    .describe(
      'Name (or symbolId) of the entry point symbol to start tracing from. ' +
      'If multiple symbols share the name, all are used as starting points.',
    ),
  endHint: z
    .string()
    .optional()
    .describe(
      'Glob-style pattern for terminal symbols (e.g. "*Worker", "*Job", "Background*"). ' +
      'Chains stop when a symbol matching this pattern is found, even before maxDepth. ' +
      'Supports * as wildcard. When omitted, chains end at leaves (no further callees).',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum chain depth (default 6)'),
  maxChains: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of chains to return (default 50)'),
  includeDynamicCalls: z
    .boolean()
    .optional()
    .describe(
      'When true, include symbols tagged with frameworkMeta.dynamicDispatch=true ' +
      '(e.g. method_missing handlers) as potential callees. Default false.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChainNode {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  signature: string;
  /** True when this node closes a cycle (i.e. already appears earlier in the chain). */
  cyclic?: boolean;
}

export interface SymbolChain {
  nodes: ChainNode[];
  /** True when truncated by maxDepth, not by endHint or leaf. */
  truncatedByDepth: boolean;
  /** True when chain ends at an endHint match. */
  endedAtHint: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Keywords that match `\bword(` but are not function calls.
const CALL_SKIP = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch',
  'finally', 'try', 'new', 'return', 'throw', 'typeof', 'instanceof',
  'function', 'class', 'import', 'export', 'const', 'let', 'var',
  'async', 'await', 'yield', 'delete', 'void', 'in', 'of', 'super',
  'this', 'true', 'false', 'null', 'undefined',
]);

/** Callable symbol kinds — only these are expanded as callee targets. */
const CALLABLE_KINDS = new Set([
  'function', 'method', 'hook', 'composable', 'route', 'middleware',
]);

function extractCallNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = m[1]!;
    if (!CALL_SKIP.has(n)) names.add(n);
  }
  return names;
}

/** Glob-style match: only * as wildcard, anchored to full string. */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[$()+.?[\\\]^{|}]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  startSymbol: string;
  endHint?: string;
  maxDepth?: number;
  maxChains?: number;
  includeDynamicCalls?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    startSymbol,
    endHint,
    maxDepth = 6,
    maxChains = 50,
    includeDynamicCalls = false,
  } = args;

  const db = openDatabase(repoId);
  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Repository not found: ${repoId}` }),
          },
        ],
        isError: true,
      };
    }

    // ── Load all symbols ─────────────────────────────────────────────────────
    const allSymbols = getSymbolsByRepo(db, repoId, 1_000_000);

    // Build name → SymbolRecord[] index (both full name and short name for methods)
    const byName = new Map<string, SymbolRecord[]>();
    const byId = new Map<string, SymbolRecord>();
    for (const sym of allSymbols) {
      byId.set(sym.id, sym);
      const names = [sym.name];
      if (sym.name.includes('.')) names.push(sym.name.split('.').pop()!);
      for (const n of names) {
        const list = byName.get(n) ?? [];
        list.push(sym);
        byName.set(n, list);
      }
    }

    // ── Resolve start symbol(s) ──────────────────────────────────────────────
    // Support both name lookup and direct symbolId
    let startSymbols: SymbolRecord[];
    if (byId.has(startSymbol)) {
      startSymbols = [byId.get(startSymbol)!];
    } else {
      startSymbols = byName.get(startSymbol) ?? [];
    }

    if (startSymbols.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chains: [],
              truncated: false,
              error: `Symbol not found: ${startSymbol}`,
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            }),
          },
        ],
      };
    }

    // ── File content cache ───────────────────────────────────────────────────
    const fileCache = new Map<string, Buffer | null>();
    function getContent(filePath: string): Buffer | null {
      if (!fileCache.has(filePath)) {
        fileCache.set(filePath, getFileContent(db, repoId, filePath));
      }
      return fileCache.get(filePath) ?? null;
    }

    function symbolText(sym: SymbolRecord): string {
      const buf = getContent(sym.filePath);
      if (!buf) return '';
      return buf.slice(sym.startByte, Math.min(sym.endByte, buf.length)).toString('utf8');
    }

    /** Direct callees of a symbol (by text scan). */
    function calleesOf(sym: SymbolRecord): SymbolRecord[] {
      const text = symbolText(sym);
      const callNames = extractCallNames(text);
      const seen = new Set<string>();
      const result: SymbolRecord[] = [];

      for (const cname of callNames) {
        const candidates = byName.get(cname) ?? [];
        for (const cand of candidates) {
          if (cand.id === sym.id) continue;
          if (!CALLABLE_KINDS.has(cand.kind)) continue;
          if (!includeDynamicCalls) {
            // Skip dynamic dispatch symbols unless explicitly included
            const meta = cand.frameworkMeta as Record<string, unknown> | undefined;
            if (meta?.['dynamicDispatch'] === true) continue;
          }
          if (!seen.has(cand.id)) {
            seen.add(cand.id);
            result.push(cand);
          }
        }
      }

      return result;
    }

    // ── DFS to collect chains ────────────────────────────────────────────────
    const chains: SymbolChain[] = [];
    let overallTruncated = false;

    function toChainNode(sym: SymbolRecord, cyclic = false): ChainNode {
      return {
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind,
        filePath: sym.filePath,
        signature: sym.signature,
        ...(cyclic ? { cyclic: true } : {}),
      };
    }

    function dfs(
      sym: SymbolRecord,
      currentPath: SymbolRecord[],
      visitedInPath: Set<string>,
      depth: number,
    ): void {
      if (chains.length >= maxChains) {
        overallTruncated = true;
        return;
      }

      // Check if this symbol matches endHint
      const matchesEnd = endHint ? globMatch(endHint, sym.name) : false;

      if (matchesEnd) {
        // Terminal: endHint matched
        const nodes = [...currentPath.map((s) => toChainNode(s)), toChainNode(sym)];
        chains.push({ nodes, truncatedByDepth: false, endedAtHint: true });
        return;
      }

      if (depth >= maxDepth) {
        // Truncated by depth
        const nodes = [...currentPath, sym].map((s) => toChainNode(s));
        chains.push({ nodes, truncatedByDepth: true, endedAtHint: false });
        return;
      }

      const callees = calleesOf(sym);

      if (callees.length === 0) {
        // Leaf node — emit chain
        const nodes = [...currentPath, sym].map((s) => toChainNode(s));
        chains.push({ nodes, truncatedByDepth: false, endedAtHint: false });
        return;
      }

      // Expand callees
      for (const callee of callees) {
        if (chains.length >= maxChains) {
          overallTruncated = true;
          break;
        }

        if (visitedInPath.has(callee.id)) {
          // Cycle detected — emit current path with cyclic leaf
          const nodes = [
            ...currentPath.map((s) => toChainNode(s)),
            toChainNode(sym),
            toChainNode(callee, true),
          ];
          chains.push({ nodes, truncatedByDepth: false, endedAtHint: false });
          continue;
        }

        const nextPath = [...currentPath, sym];
        const nextVisited = new Set(visitedInPath);
        nextVisited.add(sym.id);
        dfs(callee, nextPath, nextVisited, depth + 1);
      }
    }

    for (const start of startSymbols) {
      if (chains.length >= maxChains) {
        overallTruncated = true;
        break;
      }
      dfs(start, [], new Set([start.id]), 0);
    }

    const tokenEstimate = Math.ceil(
      chains.reduce(
        (sum, c) =>
          sum + c.nodes.reduce((s, n) => s + n.name.length + n.filePath.length + 40, 0),
        0,
      ) / 4,
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              chains,
              totalChains: chains.length,
              truncated: overallTruncated,
              startSymbol,
              _tokenEstimate: tokenEstimate,
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            },
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    db.close();
  }
}
