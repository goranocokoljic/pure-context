/**
 * Local usage ledger (Phase 97, Task 603).
 *
 * Append-only JSONL at `<dataDir>/usage.jsonl`, one line per MCP tool call:
 * `{ ts, tool, repoId?, sessionId, ms }`. That is ALL it holds — no query
 * text, no paths, no results (P4). It never leaves the machine; it exists so
 * a human can answer "did the agent actually use PureContext on this task?"
 * without asking the agent (the reporter's chat fragment), via:
 *
 * - `get_savings_stats.calls` — this server session + last 24 h, by tool;
 * - the TaskCompleted hook's first line: `PureContext this task: N calls (…)`
 *   — "this task" = entries since the previous TaskCompleted (a cursor file).
 *
 * Off switch: `telemetry.usageLedger: false` → zero writes (the in-memory
 * session counters still work for `get_savings_stats`). Rotation: at 5 MB the
 * file becomes `usage.jsonl.1` (one generation kept).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from './schema.js';

export interface UsageEntry {
  ts: number;
  tool: string;
  repoId?: string;
  sessionId: string;
  ms: number;
}

export interface CallCounts {
  total: number;
  byTool: Record<string, number>;
}

export const LEDGER_ROTATE_BYTES = 5 * 1024 * 1024;

/** One id per server process — the MCP client exposes no session id to tools. */
const SESSION_ID = `${process.pid}-${Date.now().toString(36)}`;

let _pathOverride: string | null = null;
const session: CallCounts = { total: 0, byTool: {} };

export function _setLedgerPathForTesting(path: string | null): void {
  _pathOverride = path;
  session.total = 0;
  session.byTool = {};
}

export function getLedgerPath(): string {
  return _pathOverride ?? join(getDataDir(), 'usage.jsonl');
}

function cursorPath(): string {
  return getLedgerPath().replace(/\.jsonl$/, '') + '.cursor';
}

export function getSessionId(): string {
  return SESSION_ID;
}

/**
 * Record one tool call. In-memory session counters always; the file only
 * when `enabled` (the caller passes config `telemetry.usageLedger`). Never
 * throws — a full disk must not fail a tool call.
 */
export function recordToolCall(
  entry: { tool: string; repoId?: string; ms: number },
  enabled = true,
): void {
  session.total++;
  session.byTool[entry.tool] = (session.byTool[entry.tool] ?? 0) + 1;
  if (!enabled) return;
  try {
    const path = getLedgerPath();
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    const line: UsageEntry = {
      ts: Date.now(),
      tool: entry.tool,
      ...(entry.repoId ? { repoId: entry.repoId } : {}),
      sessionId: SESSION_ID,
      ms: Math.max(0, Math.round(entry.ms)),
    };
    appendFileSync(path, JSON.stringify(line) + '\n');
  } catch {
    /* ledger is best-effort */
  }
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size < LEDGER_ROTATE_BYTES) return;
    renameSync(path, `${path}.1`); // overwrites the previous .1
  } catch {
    /* ignore */
  }
}

/** Counters for this server process. */
export function getSessionCalls(): CallCounts {
  return { total: session.total, byTool: { ...session.byTool } };
}

/** Entries with `ts >= sinceTs`, reading the current file and (if needed) `.1`. */
export function readLedger(sinceTs = 0): UsageEntry[] {
  const path = getLedgerPath();
  const out: UsageEntry[] = [];
  for (const file of [`${path}.1`, path]) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as UsageEntry;
        if (typeof e.ts === 'number' && typeof e.tool === 'string' && e.ts >= sinceTs) out.push(e);
      } catch {
        /* skip a torn line */
      }
    }
  }
  return out;
}

export function aggregate(entries: UsageEntry[]): CallCounts {
  const byTool: Record<string, number> = {};
  for (const e of entries) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  return { total: entries.length, byTool };
}

/** Calls in the last 24 hours across all sessions (from the file). */
export function getLast24hCalls(now = Date.now()): CallCounts {
  return aggregate(readLedger(now - 24 * 60 * 60 * 1000));
}

// ─── "This task" cursor (TaskCompleted hook) ─────────────────────────────────

export function readTaskCursor(): number {
  try {
    const p = cursorPath();
    if (!existsSync(p)) return 0;
    const n = Number(readFileSync(p, 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeTaskCursor(ts = Date.now()): void {
  try {
    const p = cursorPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(ts));
  } catch {
    /* ignore */
  }
}

/**
 * Calls since the previous TaskCompleted, then advance the cursor. The
 * line is the reporter's "Did you use list_repos?" answered every task.
 */
export function takeTaskCalls(now = Date.now()): CallCounts {
  const since = readTaskCursor();
  const counts = aggregate(readLedger(since));
  writeTaskCursor(now);
  return counts;
}

/** `PureContext this task: 12 calls (search_symbols 5, get_symbol_source 4, …)` */
export function formatCallsLine(counts: CallCounts, label = 'this task', maxTools = 6): string {
  if (counts.total === 0) return `PureContext ${label}: 0 calls`;
  const parts = Object.entries(counts.byTool)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTools)
    .map(([tool, n]) => `${tool} ${n}`);
  const more = Object.keys(counts.byTool).length - parts.length;
  return `PureContext ${label}: ${counts.total} call${counts.total === 1 ? '' : 's'} (${parts.join(', ')}${
    more > 0 ? `, +${more} more` : ''
  })`;
}
