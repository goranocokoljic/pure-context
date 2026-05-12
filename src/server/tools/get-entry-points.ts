/**
 * get-entry-points.ts
 *
 * MCP tool: get_entry_points
 *
 * Identifies the runnable entry points of a repository: main functions, CLI
 * handlers, HTTP server startups, Lambda/serverless handlers, test suites, and
 * standalone scripts. Detection is heuristic-based — it combines symbol names,
 * file names, and signature patterns to classify candidates by kind and assign a
 * confidence score.
 *
 * Designed for:
 *   - Onboarding: "where does this application start?"
 *   - Dependency mapping: trace execution from the root
 *   - CI/CD: enumerate all runnable targets
 *   - Security: identify all public-facing handlers (Lambda, HTTP)
 *
 * Use get_context_bundle to follow the full dependency chain from an entry point.
 * Use find_dead_code to discover unreachable code from the entry points.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_entry_points';

export const description =
  'Identify the runnable entry points of a repository: main functions, CLI handlers, ' +
  'HTTP server startups, Lambda/serverless handlers, test suites, and standalone scripts. ' +
  'Detection combines symbol name heuristics, file name patterns, and signature analysis. ' +
  'Each result includes a kind (main_function, cli_handler, server_startup, lambda_handler, ' +
  'test_suite, script), a confidence level (high/medium/low), and the reason for classification. ' +
  'Use this to answer "where does this application start?", enumerate all runnable targets, ' +
  'or trace execution paths from the root.' +
  '\n\nRelated tools:' +
  '\n  get_context_bundle — full dependency chain from an entry point' +
  '\n  find_dead_code     — unreachable code relative to entry points' +
  '\n  get_call_hierarchy — callee tree rooted at an entry point';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  kind: z
    .enum(['main_function', 'cli_handler', 'server_startup', 'lambda_handler', 'test_suite', 'script'])
    .optional()
    .describe('Filter results to a specific entry-point kind'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Restrict to a specific file path or directory prefix ' +
      '(e.g. "src/cmd/" returns entry points from that subtree only)',
    ),
  minConfidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe(
      'Minimum confidence level to include. ' +
      '"high" returns only strong matches; "low" returns all candidates (default "low").',
    ),
  limit: z
    .number().int().positive().optional()
    .describe('Maximum number of entry points to return (default 100)'),
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

export type EntryKind =
  | 'main_function'
  | 'cli_handler'
  | 'server_startup'
  | 'lambda_handler'
  | 'test_suite'
  | 'script';

export type Confidence = 'high' | 'medium' | 'low';

export interface EntryPoint {
  symbolId: string;
  name: string;
  kind: EntryKind;
  confidence: Confidence;
  reason: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
}

// ─── Detection rules ──────────────────────────────────────────────────────────
//
// Rules are evaluated in order. The first matching rule wins.
// Each rule returns { kind, confidence, reason } or null.
//

interface Rule {
  match(sym: SymbolRow): { kind: EntryKind; confidence: Confidence; reason: string } | null;
}

/** Entry-file names that strongly suggest a runnable script. */
const ENTRY_FILE_NAMES = new Set([
  'main', 'index', 'app', 'server', 'cli', 'run', 'start',
  'bootstrap', 'entry', 'bin', 'cmd', 'program',
]);

/** Extract the stem (basename without extension) of a file path. */
function fileStem(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** True when the file lives at the project root (no directory component). */
function isRootFile(filePath: string): boolean {
  return !filePath.includes('/');
}

/** True when the file is inside a bin/, cmd/, or cli/ directory (not scripts/). */
function isBinDir(filePath: string): boolean {
  return /(?:^|\/)(?:bin|cmd|cli)\//i.test(filePath);
}

const RULES: Rule[] = [
  // ── Lambda / serverless handler ──────────────────────────────────────────────
  {
    match(sym) {
      // export const handler = async (event, context) => ...
      // exports.handler = ...
      if (
        sym.name === 'handler' &&
        (sym.kind === 'function' || sym.kind === 'const' || sym.kind === 'method') &&
        /\b(event|context|callback)\b/.test(sym.signature)
      ) {
        return { kind: 'lambda_handler', confidence: 'high', reason: 'symbol named "handler" with event/context parameter' };
      }
      // Any exported symbol named "handler" in a lambda-style file
      if (
        sym.name === 'handler' &&
        (sym.kind === 'function' || sym.kind === 'const') &&
        /(?:lambda|handler|serverless|function)/i.test(sym.file_path)
      ) {
        return { kind: 'lambda_handler', confidence: 'medium', reason: 'symbol named "handler" in a lambda/serverless file' };
      }
      return null;
    },
  },

  // ── Main function ─────────────────────────────────────────────────────────────
  {
    match(sym) {
      if (sym.name !== 'main') return null;
      if (sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'const') return null;
      // High confidence: file is named "main" or the function is explicitly exported
      if (
        fileStem(sym.file_path) === 'main' ||
        sym.signature.startsWith('export') ||
        isRootFile(sym.file_path)
      ) {
        return { kind: 'main_function', confidence: 'high', reason: 'function named "main"' };
      }
      return { kind: 'main_function', confidence: 'medium', reason: 'function named "main" (non-root file)' };
    },
  },

  // ── CLI handler ───────────────────────────────────────────────────────────────
  {
    match(sym) {
      if (sym.kind !== 'function' && sym.kind !== 'const' && sym.kind !== 'class') return null;
      const stem = fileStem(sym.file_path);

      // High: file is in bin/cmd/cli dir and symbol is main/run/execute/cli
      if (isBinDir(sym.file_path) && /^(main|run|execute|cli|command|program)$/.test(sym.name.toLowerCase())) {
        return { kind: 'cli_handler', confidence: 'high', reason: 'entry function in bin/cmd/cli directory' };
      }
      // Medium: file named cli/cmd/bin AND function is exported
      if (
        ['cli', 'cmd', 'bin', 'command'].includes(stem) &&
        sym.kind === 'function' &&
        sym.signature.startsWith('export')
      ) {
        return { kind: 'cli_handler', confidence: 'medium', reason: `exported function in file named "${stem}"` };
      }
      // Low: symbol name strongly implies CLI
      if (/^(parseArgs?|parseArguments|runCli|executeCli|cliMain)$/.test(sym.name) && sym.kind === 'function') {
        return { kind: 'cli_handler', confidence: 'low', reason: 'function name suggests CLI argument parsing' };
      }
      return null;
    },
  },

  // ── HTTP server startup ───────────────────────────────────────────────────────
  {
    match(sym) {
      if (sym.kind !== 'function' && sym.kind !== 'const' && sym.kind !== 'class') return null;
      const stem = fileStem(sym.file_path);

      // High: symbol name is bootstrap/startServer/listen with "listen" or "listen(" in signature
      if (/^(bootstrap|startServer|startApp|listenOn|serve|createServer)$/.test(sym.name) && sym.kind === 'function') {
        return { kind: 'server_startup', confidence: 'high', reason: `server bootstrap function named "${sym.name}"` };
      }
      // High: file named "server" or "app" at root, symbol is main/start/run
      if (
        ['server', 'app'].includes(stem) &&
        isRootFile(sym.file_path) &&
        /^(main|start|run|init|boot|bootstrap)$/.test(sym.name.toLowerCase())
      ) {
        return { kind: 'server_startup', confidence: 'high', reason: `server startup function in root "${stem}" file` };
      }
      // Medium: file named "server" or "app", non-root
      if (['server', 'app'].includes(stem) && sym.name.toLowerCase() === 'main') {
        return { kind: 'server_startup', confidence: 'medium', reason: `main function in "${stem}" file` };
      }
      // Low: symbol name suggests server start
      if (/^(startListening|runServer|initServer|bootServer)$/.test(sym.name) && sym.kind === 'function') {
        return { kind: 'server_startup', confidence: 'low', reason: `function name "${sym.name}" suggests server startup` };
      }
      return null;
    },
  },

  // ── Test suite ────────────────────────────────────────────────────────────────
  {
    match(sym) {
      // File is clearly a test file
      if (!/(?:\.test\.|\.spec\.|_test\.|_spec\.|\/test\/|\/spec\/|\/tests\/|\/specs\/)/.test(sym.file_path)) {
        return null;
      }
      if (sym.kind !== 'function') return null;
      // High: describe/it/test/suite at top level
      if (/^(describe|suite|context)$/.test(sym.name)) {
        return { kind: 'test_suite', confidence: 'high', reason: 'top-level describe/suite in test file' };
      }
      return null;
    },
  },

  // ── Standalone script (entry file with a runnable shape) ──────────────────────
  {
    match(sym) {
      if (sym.kind !== 'function' && sym.kind !== 'const') return null;
      const stem = fileStem(sym.file_path);

      // High: the entry file is named "index"/"main"/"app"/"server" AND symbol is a
      //       clearly-named top-level exported runner
      if (
        ENTRY_FILE_NAMES.has(stem) &&
        /^(run|start|boot|init|execute|launch|setup)$/.test(sym.name.toLowerCase()) &&
        sym.signature.startsWith('export')
      ) {
        return { kind: 'script', confidence: 'high', reason: `exported "${sym.name}" function in entry file "${stem}"` };
      }

      // Medium: file is in scripts/ dir, symbol is top-level function
      if (/(?:^|\/)scripts?\//i.test(sym.file_path) && sym.kind === 'function') {
        return { kind: 'script', confidence: 'medium', reason: 'function in scripts/ directory' };
      }

      return null;
    },
  },

  // ── Default export from a known entry file (catch-all for exotic frameworks) ──
  {
    match(sym) {
      if (!sym.signature.includes('export default')) return null;
      if (sym.kind !== 'function' && sym.kind !== 'const' && sym.kind !== 'class') return null;
      const stem = fileStem(sym.file_path);
      if (ENTRY_FILE_NAMES.has(stem) && isRootFile(sym.file_path)) {
        return { kind: 'script', confidence: 'medium', reason: `default export from root "${stem}" file` };
      }
      return null;
    },
  },
];

/** Run all rules against a symbol row and return the first match. */
export function detectEntryPoint(
  sym: SymbolRow,
): { kind: EntryKind; confidence: Confidence; reason: string } | null {
  for (const rule of RULES) {
    const result = rule.match(sym);
    if (result) return result;
  }
  return null;
}

// ─── Confidence ordering ──────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

function meetsMinConfidence(c: Confidence, min: Confidence): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  kind?: EntryKind;
  filePath?: string;
  minConfidence?: Confidence;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    minConfidence = 'low',
    limit = 100,
  } = args;

  const db = openDatabase(repoId);
  try {
    // ── Validate repo exists ────────────────────────────────────────────────────
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

    // ── Fetch candidate symbols ─────────────────────────────────────────────────
    // We only need callable/instantiable kinds — no need to scan consts or types
    // that could never be runnable. But we do include 'const' because many
    // Lambda handlers are `export const handler = ...`.
    const candidateKinds = ['function', 'class', 'method', 'const', 'component', 'hook'];
    const kindPlaceholders = candidateKinds.map((_, i) => `@k${i}`).join(', ');
    const kindParams: Record<string, unknown> = { repoId };
    candidateKinds.forEach((k, i) => { kindParams[`k${i}`] = k; });

    let sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary
      FROM symbols
      WHERE repo_id = @repoId
        AND kind IN (${kindPlaceholders})
    `;

    if (args.filePath) {
      sql += ' AND (file_path = @filePath OR file_path LIKE @filePathPrefix)';
      kindParams['filePath'] = args.filePath;
      kindParams['filePathPrefix'] = `${args.filePath}%`;
    }

    sql += ' ORDER BY file_path ASC, start_byte ASC';

    const rows: SymbolRow[] = db
      .prepare<Record<string, unknown>, SymbolRow>(sql)
      .all(kindParams);

    // ── Apply detection rules ───────────────────────────────────────────────────
    let rawBytes = 0;
    const entryPoints: EntryPoint[] = [];

    // Deduplicate: one entry point per symbol id
    const seen = new Set<string>();

    for (const row of rows) {
      const detection = detectEntryPoint(row);
      if (!detection) continue;
      if (seen.has(row.id)) continue;
      if (!meetsMinConfidence(detection.confidence, minConfidence)) continue;
      if (args.kind && detection.kind !== args.kind) continue;

      seen.add(row.id);

      // Estimate line number from start_byte
      rawBytes += row.signature.length + row.summary.length;

      entryPoints.push({
        symbolId: row.id,
        name: row.name,
        kind: detection.kind,
        confidence: detection.confidence,
        reason: detection.reason,
        filePath: row.file_path,
        startLine: 0, // filled in below
        signature: row.signature,
        summary: row.summary,
      });
    }

    // ── Sort: high confidence first, then by file path ─────────────────────────
    entryPoints.sort((a, b) => {
      const cd = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
      if (cd !== 0) return cd;
      return a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);
    });

    // ── Apply limit ────────────────────────────────────────────────────────────
    const truncated = entryPoints.length > limit;
    const limited = entryPoints.slice(0, limit);

    // ── Compute startLine from stored file content ────────────────────────────
    const fileToSymbols = new Map<string, { ep: EntryPoint; row: SymbolRow }[]>();
    for (const ep of limited) {
      const row = rows.find((r) => r.id === ep.symbolId);
      if (!row) continue;
      const list = fileToSymbols.get(ep.filePath) ?? [];
      list.push({ ep, row });
      fileToSymbols.set(ep.filePath, list);
    }

    for (const [filePath, items] of fileToSymbols) {
      const fileRow = db
        .prepare<[string, string], { raw_content: Buffer | null }>(
          'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
        )
        .get(repoId, filePath);

      if (fileRow?.raw_content) {
        rawBytes += fileRow.raw_content.length;
        const content = fileRow.raw_content;
        for (const { ep, row } of items) {
          const slice = content.slice(0, Math.min(row.start_byte, content.length));
          let line = 1;
          for (let i = 0; i < slice.length; i++) {
            if (slice[i] === 0x0a) line++;
          }
          ep.startLine = line;
        }
      } else {
        for (const { ep, row } of items) {
          ep.startLine = Math.max(1, Math.floor(row.start_byte / 80) + 1);
        }
      }
    }

    // ── Build kind summary ────────────────────────────────────────────────────
    const kindCounts: Partial<Record<EntryKind, number>> = {};
    for (const ep of limited) {
      kindCounts[ep.kind] = (kindCounts[ep.kind] ?? 0) + 1;
    }

    const responseBytes = limited.reduce(
      (sum, ep) =>
        sum + ep.signature.length + ep.summary.length + ep.filePath.length + ep.reason.length + 100,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    const output = {
      totalFound: limited.length,
      truncated,
      kindCounts,
      entryPoints: limited,
      _tokenEstimate: tokenEstimate,
      _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
