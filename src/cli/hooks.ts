/**
 * `purecontext-mcp hooks --install` / `hooks --list`
 * `purecontext-mcp hook-pretooluse|hook-posttooluse|hook-precompact|hook-worktree-create|hook-worktree-remove`
 *
 * Merges hook entries into ~/.claude/settings.json using direct node invocation
 * (node "<cliPath>" hook-*) so hooks never trigger npm registry SSL checks.
 * Also injects PureContext agent instructions into ~/.claude/CLAUDE.md.
 */

import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { getSqliteFactory, type SqliteDatabase } from '../core/db/sqlite-loader.js';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD_PATH = join(CLAUDE_DIR, 'CLAUDE.md');

// ─── Hook command builder ─────────────────────────────────────────────────────

// Builds a direct `node "<script>" <subcommand>` invocation that bypasses npx
// and avoids npm registry SSL checks entirely (important on corporate proxies).
function makeHookCmd(subcommand: string): string {
  const cliScript = resolve(__dirname, '..', 'index.js');
  const q = (p: string) => `"${p}"`;
  return `${q(process.execPath)} ${q(cliScript)} ${subcommand}`;
}

// ─── CLAUDE.md block ──────────────────────────────────────────────────────────

const CLAUDE_MD_BLOCK = `<!-- purecontext-mcp-start -->
# PureContext MCP — AI Agent Instructions

Full tool reference, navigation patterns, and known limitations: \`AGENT_REFERENCE.md\` in the project root (added by \`npx purecontext-mcp hooks --install\`).

## Mandatory workflow — always follow this order

**Step 1 — Check if the project is indexed**

\`\`\`
list_repos()
\`\`\`

If the project is missing: \`index_folder({ path: "/absolute/path/to/project" })\`. All other tools require a \`repoId\` — never skip this step.

**Step 2 — Navigate by symbol, not by file**

Do not read entire files to find code.

| Goal | Tool |
|------|------|
| Find a function/class/method by name | \`search_symbols\` |
| Find code by what it does | \`search_semantic\` |
| Find a literal string, comment, or config value | \`search_text\` |
| See all symbols in one file | \`get_file_outline\` |
| See the whole project structure | \`get_repo_outline\` |
| Understand a function's dependencies | \`get_context_bundle\` |
| Know what breaks if I change a symbol | \`get_blast_radius\` |
| Find all call sites for a symbol | \`find_references\` |
| Survey a file before editing | \`get_file_outline\` |
| Non-symbol file content (imports, config blocks) | \`get_file_content\` with startLine/endLine |
| All implementations of an interface | \`find_implementations\` |
| Callers/callees tree | \`get_call_hierarchy\` |
| Class inheritance structure | \`get_class_hierarchy\` |
| Circular dependencies | \`find_cycles\` |
| Rename / delete / move safety check | \`check_rename_safe\` / \`check_delete_safe\` / \`check_move_safe\` |
| Codebase health score | \`health_radar\` |
| Detailed debt report | \`get_debt_report\` |
| All TODOs and FIXMEs | \`get_todos\` |
| Untested exported symbols | \`find_untested_symbols\` |
| AST node type occurrences | \`search_ast\` |
| Symbols by decorator | \`search_by_decorator\` |
| Most complex functions | \`get_complexity_hotspots\` |

**Step 3 — Read summaries before fetching source**

\`search_symbols\` returns signatures and summaries — no source code. Read the \`summary\` field first. Fetch source only for symbols you will actually work with:

\`\`\`
get_symbol_source({ repoId, symbolId })
\`\`\`

Summaries describe intent, not contract. For modification tasks, always read the source after using the summary to navigate.

## Anti-patterns — what NOT to do

Do not read whole files to find a function. Use \`search_symbols\` + \`get_symbol_source\`.

Do not call \`get_symbol_source\` for every search result. Read \`signature\` and \`summary\` first. Fetch source only for symbols you will work with.

Do not skip \`list_repos\` at the start of a session. You need a \`repoId\` for every tool call.

Do not use \`search_text\` for symbol lookups. It greps raw file content — slower and less precise than \`search_symbols\` for named code entities.

Do not use \`get_file_content\` as a fallback for reading whole files. If a symbol exists in the index, use \`get_symbol_source\`.

Do not ignore \`_tokenEstimate\` fields. Use them to decide whether to fetch more context or stop.

Do not re-search when \`search_symbols\` returns \`negative_evidence\`. If the response includes \`verdict: "no_match"\`, the symbol does not exist — report the gap rather than trying five more query variants.
<!-- purecontext-mcp-end -->`;

// ─── Public install/list commands ─────────────────────────────────────────────

export function cmdHooksInstall(): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });

  mergeSettings();
  injectClaudeMd();

  console.log('\nHooks installed. Reopen Claude Code to activate them.\n');
  console.log('Hooks registered (via npx purecontext-mcp hook-*):');
  console.log('  PostToolUse  (hook-posttooluse):       re-indexes edited files automatically');
  console.log('  PreCompact   (hook-precompact):        injects repo state before context compaction');
  console.log('  PreToolUse   (hook-pretooluse):        suggests PureContext read tools before editing');
  console.log('  WorktreeCreate  (hook-worktree-create):  auto-indexes new agent worktrees');
  console.log('  WorktreeRemove  (hook-worktree-remove):  fires when an agent worktree is removed');
  console.log('  TaskCompleted   (hook-taskcompleted):    post-task diagnostics and repo summary');
  console.log('  SubagentStart   (hook-subagentstart):    injects repo orientation for spawned agents');
}

export function cmdHooksList(): void {
  console.log('\nPureContext Claude Code hooks:\n');

  const settingsStatus = areSettingsMerged() ? 'registered' : 'not configured';
  console.log(`  settings.json hooks: ${settingsStatus}`);
  console.log(`  CLAUDE.md block:     ${isClaudeMdInjected() ? 'present' : 'not present'}\n`);

  if (areSettingsMerged()) {
    console.log('  Active hooks (invoked via direct node, no npx):');
    console.log('    PostToolUse    → hook-posttooluse');
    console.log('    PreCompact     → hook-precompact');
    console.log('    PreToolUse     → hook-pretooluse');
    console.log('    WorktreeCreate → hook-worktree-create');
    console.log('    WorktreeRemove → hook-worktree-remove');
  }
}

// ─── Settings merge ───────────────────────────────────────────────────────────

export function mergeSettings(): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  hooks.PostToolUse = mergeHookEntry(
    hooks.PostToolUse ?? [],
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: makeHookCmd('hook-posttooluse') }] },
    ['purecontext-index-hook.mjs', 'hook-posttooluse'],
  );
  hooks.PreCompact = mergeHookEntry(
    hooks.PreCompact ?? [],
    { matcher: '', hooks: [{ type: 'command', command: makeHookCmd('hook-precompact') }] },
    ['purecontext-precompact-hook.mjs', 'hook-precompact'],
  );
  hooks.PreToolUse = mergeHookEntry(
    hooks.PreToolUse ?? [],
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: makeHookCmd('hook-pretooluse') }] },
    ['purecontext-edit-guard.mjs', 'hook-pretooluse'],
  );
  hooks.WorktreeCreate = mergeHookEntry(
    (hooks.WorktreeCreate ?? []) as unknown[],
    { matcher: '', hooks: [{ type: 'command', command: makeHookCmd('hook-worktree-create') }] },
    ['hook-worktree-create'],
  );
  hooks.WorktreeRemove = mergeHookEntry(
    (hooks.WorktreeRemove ?? []) as unknown[],
    { matcher: '', hooks: [{ type: 'command', command: makeHookCmd('hook-worktree-remove') }] },
    ['hook-worktree-remove'],
  );
  hooks.TaskCompleted = mergeHookEntry(
    (hooks.TaskCompleted ?? []) as unknown[],
    { matcher: '', hooks: [{ type: 'command', command: makeHookCmd('hook-taskcompleted') }] },
    ['hook-taskcompleted'],
  );
  hooks.SubagentStart = mergeHookEntry(
    (hooks.SubagentStart ?? []) as unknown[],
    { matcher: '', hooks: [{ type: 'command', command: makeHookCmd('hook-subagentstart') }] },
    ['hook-subagentstart'],
  );

  settings.hooks = hooks;
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  Updated: ${SETTINGS_PATH}`);
}

function mergeHookEntry(
  existing: unknown[],
  entry: Record<string, unknown>,
  matchStrings: string[],
): unknown[] {
  // Remove any existing purecontext entry for this hook type (idempotent).
  // Matches both old .mjs script paths and current CLI command forms.
  const filtered = existing.filter((e) => {
    const hooks = (e as Record<string, unknown[]>).hooks ?? [];
    return !hooks.some((h) => {
      const cmd = (h as Record<string, string>).command ?? '';
      return matchStrings.some((s) => cmd.includes(s));
    });
  });
  return [...filtered, entry];
}

function areSettingsMerged(): boolean {
  if (!existsSync(SETTINGS_PATH)) return false;
  try {
    const text = readFileSync(SETTINGS_PATH, 'utf-8');
    return text.includes('hook-posttooluse') || text.includes('purecontext-index-hook.mjs');
  } catch { return false; }
}

// ─── CLAUDE.md injection ──────────────────────────────────────────────────────

export function injectClaudeMd(): void {
  const START_MARKER = '<!-- purecontext-mcp-start -->';
  const END_MARKER = '<!-- purecontext-mcp-end -->';

  if (!existsSync(CLAUDE_MD_PATH)) {
    writeFileSync(CLAUDE_MD_PATH, CLAUDE_MD_BLOCK + '\n');
    console.log(`  Created: ${CLAUDE_MD_PATH}`);
    return;
  }

  let content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    content = content.slice(0, startIdx) + CLAUDE_MD_BLOCK + content.slice(endIdx + END_MARKER.length);
  } else {
    if (!content.endsWith('\n')) content += '\n';
    content += '\n' + CLAUDE_MD_BLOCK + '\n';
  }

  writeFileSync(CLAUDE_MD_PATH, content);
  console.log(`  Updated: ${CLAUDE_MD_PATH}`);
}

function isClaudeMdInjected(): boolean {
  if (!existsSync(CLAUDE_MD_PATH)) return false;
  try {
    return readFileSync(CLAUDE_MD_PATH, 'utf-8').includes('<!-- purecontext-mcp-start -->');
  } catch { return false; }
}

// ─── Hook command implementations ─────────────────────────────────────────────

const ROOT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml'];

function findRepoRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function reindexRepo(repoRoot: string): void {
  const selfScript = process.argv[1];
  if (!selfScript) return;
  spawnSync(process.execPath, [selfScript, 'index-folder', '--path', repoRoot], {
    stdio: 'ignore',
    timeout: 60_000,
  });
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

/** PreToolUse: warn before Edit/Write/MultiEdit. */
export async function cmdHookPreToolUse(): Promise<void> {
  if (process.env.PURECONTEXT_ALLOW_RAW_WRITE === '1') process.exit(0);

  try {
    const input = await readStdin();
    const toolName = (input.tool_name ?? '') as string;

    if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);

    const filePath = ((input.tool_input as Record<string, unknown>)?.file_path ?? '') as string;
    const target = filePath ? ` ${filePath}` : '';
    process.stderr.write(
      `PureContext: before editing${target}, consider:\n` +
      '  get_symbol_source   → confirm you are editing the right implementation\n' +
      '  get_blast_radius    → understand what breaks if you change this\n' +
      '  find_references     → find all call sites that may need updating\n',
    );
  } catch { /* never block */ }

  process.exit(0);
}

/** PostToolUse: re-index the repo after Edit/Write/MultiEdit. */
export async function cmdHookPostToolUse(): Promise<void> {
  try {
    const input = await readStdin();
    const toolName = (input.tool_name ?? '') as string;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);

    const paths: string[] = [];
    if (toolName === 'Edit' || toolName === 'Write') {
      const fp = toolInput.file_path as string | undefined;
      if (fp) paths.push(fp);
    } else {
      const edits = (toolInput.edits ?? []) as Array<Record<string, unknown>>;
      for (const edit of edits) {
        const fp = edit.file_path as string | undefined;
        if (fp) paths.push(fp);
      }
    }

    const roots = new Set<string>();
    for (const fp of paths) {
      const root = findRepoRoot(fp);
      if (root) roots.add(root);
    }

    for (const root of roots) reindexRepo(root);
  } catch { /* never block the edit */ }

  process.exit(0);
}

interface RepoRow {
  id: string;
  root_path: string;
  file_count: number | null;
  indexed_at: string | null;
}

function readIndexedRepos(): RepoRow[] {
  const base = process.env.PCTX_DATA_DIR ?? join(homedir(), '.purecontext');
  const indexDir = join(base, 'indexes');
  if (!existsSync(indexDir)) return [];

  // Hooks run as short-lived processes without bootstrap, so only the sync
  // (native) backend is reachable here. On a WASM-only Node this returns [] —
  // the snapshot hint is advisory; the index DBs remain fully usable via the
  // server, which initialises the WASM backend properly.
  let factory;
  try {
    factory = getSqliteFactory();
  } catch { return []; }

  const repos: RepoRow[] = [];
  let files: string[];
  try {
    files = readdirSync(indexDir).filter((f) => f.endsWith('.db'));
  } catch { return []; }

  for (const file of files) {
    let db: SqliteDatabase | undefined;
    try {
      db = factory.open(join(indexDir, file), { readonly: true });
      const rows = db.prepare('SELECT id, root_path, file_count, indexed_at FROM repos LIMIT 50').all() as RepoRow[];
      repos.push(...rows);
    } catch { /* skip unreadable db */ } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return repos;
}

function buildSessionSnapshot(repos: RepoRow[]): string {
  if (repos.length === 0) {
    return [
      'PureContext session snapshot:',
      '- No repos currently indexed.',
      '- Run index_folder({ path: "/absolute/path/to/project" }) to index a repo.',
      '- Use list_repos() to check status after indexing.',
    ].join('\n');
  }

  const lines = ['PureContext session snapshot:'];
  for (const r of repos) {
    const indexed = r.indexed_at
      ? new Date(r.indexed_at).toISOString().slice(0, 19).replace('T', ' ')
      : 'unknown';
    lines.push(`- ${r.id} at ${r.root_path} (${r.file_count ?? '?'} files, last indexed ${indexed})`);
  }
  lines.push('- Use list_repos() to re-orient if needed.');
  return lines.join('\n');
}

/** PreCompact: inject session snapshot before context compaction. */
export async function cmdHookPreCompact(): Promise<void> {
  try {
    await readStdin(); // consume stdin even if unused
  } catch { /* ignore */ }

  try {
    const repos = readIndexedRepos();
    const message = buildSessionSnapshot(repos);
    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({
      systemMessage: 'PureContext session snapshot unavailable. Use list_repos() to check indexed repos.',
    }) + '\n');
  }

  process.exit(0);
}

/** WorktreeCreate: auto-index a new agent worktree. */
export async function cmdHookWorktreeCreate(): Promise<void> {
  try {
    const input = await readStdin();
    const worktreePath = (input.worktreePath ?? input.worktree_path) as string | undefined;
    const cwd = (input.cwd ?? '') as string;
    const name = (input.name ?? '') as string;

    const targetPath = worktreePath ?? (cwd && name ? join(cwd, '.claude', 'worktrees', name) : null);
    if (!targetPath) process.exit(0);

    const selfScript = process.argv[1];
    if (selfScript) {
      spawnSync(process.execPath, [selfScript, 'index-folder', '--path', targetPath], {
        stdio: 'ignore',
        timeout: 120_000,
      });
    }
  } catch { /* never block */ }

  process.exit(0);
}

/** WorktreeRemove: fires when an agent worktree is removed. No-op for now. */
export async function cmdHookWorktreeRemove(): Promise<void> {
  try { await readStdin(); } catch { /* ignore */ }
  process.exit(0);
}

// ─── Repo stats (for TaskCompleted / SubagentStart) ───────────────────────────

interface RepoStats {
  repoId: string;
  rootPath: string;
  fileCount: number | null;
  symbolCount: number | null;
  indexedAt: string | null;
  highComplexityCount: number;
  todoCount: number;
}

function readRepoStats(): RepoStats[] {
  const base = process.env.PCTX_DATA_DIR ?? join(homedir(), '.purecontext');
  const indexDir = join(base, 'indexes');
  if (!existsSync(indexDir)) return [];

  let factory;
  try {
    factory = getSqliteFactory();
  } catch { return []; }

  let files: string[];
  try {
    files = readdirSync(indexDir).filter((f) => f.endsWith('.db'));
  } catch { return []; }

  const stats: RepoStats[] = [];

  for (const file of files) {
    let db: SqliteDatabase | undefined;
    try {
      db = factory.open(join(indexDir, file), { readonly: true });

      const repo = db.prepare(
        'SELECT id, root_path, file_count, indexed_at FROM repos LIMIT 1',
      ).get() as { id: string; root_path: string; file_count: number | null; indexed_at: string | null } | undefined;
      if (!repo) continue;

      const symRow = db.prepare(
        'SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ?',
      ).get(repo.id) as { cnt: number };

      const highRow = db.prepare(
        'SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ? AND cyclomatic_complexity > 5',
      ).get(repo.id) as { cnt: number };

      // Count TODO/FIXME occurrences across all file summaries stored in symbols
      const todoRow = db.prepare(
        "SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ? AND (UPPER(summary) LIKE '%TODO%' OR UPPER(summary) LIKE '%FIXME%' OR UPPER(summary) LIKE '%HACK%')",
      ).get(repo.id) as { cnt: number };

      stats.push({
        repoId: repo.id,
        rootPath: repo.root_path,
        fileCount: repo.file_count,
        symbolCount: symRow.cnt,
        indexedAt: repo.indexed_at,
        highComplexityCount: highRow.cnt,
        todoCount: todoRow.cnt,
      });
    } catch { /* skip unreadable db */ } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  return stats;
}

/** TaskCompleted: surface post-task diagnostics and remind about available tools. */
export async function cmdHookTaskCompleted(): Promise<void> {
  try { await readStdin(); } catch { /* ignore */ }

  try {
    const repos = readRepoStats();
    if (repos.length === 0) {
      process.exit(0);
    }

    const lines: string[] = ['## PureContext Post-Task Summary\n'];

    lines.push('**Indexed repos:**');
    for (const r of repos) {
      const indexed = r.indexedAt
        ? new Date(r.indexedAt).toISOString().slice(0, 19).replace('T', ' ')
        : 'unknown';
      lines.push(`- \`${r.repoId}\` → \`${r.rootPath}\``);
      lines.push(`  ${r.fileCount ?? '?'} files · ${r.symbolCount ?? '?'} symbols · indexed ${indexed}`);
      if (r.highComplexityCount > 0) {
        lines.push(`  ⚠ ${r.highComplexityCount} high-complexity symbols (cyclomatic > 5)`);
      }
      if (r.todoCount > 0) {
        lines.push(`  📝 ${r.todoCount} symbols with TODO/FIXME/HACK in their summary`);
      }
    }

    lines.push('');
    lines.push('**Post-task diagnostic tools:**');
    lines.push('- `find_dead_code`          → orphaned exports with no importers');
    lines.push('- `find_untested_symbols`   → exported symbols with no test coverage');
    lines.push('- `get_todos`               → all TODO/FIXME/HACK comments in the codebase');
    lines.push('- `get_complexity_hotspots` → most complex functions to review');
    lines.push('- `health_radar`            → overall codebase health score');

    process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }) + '\n');
  } catch {
    // Never block task completion
  }

  process.exit(0);
}

/** SubagentStart: inject condensed repo orientation for spawned subagents. */
export async function cmdHookSubagentStart(): Promise<void> {
  try { await readStdin(); } catch { /* ignore */ }

  try {
    const repos = readRepoStats();

    const lines: string[] = ['## PureContext Repo Orientation\n'];

    if (repos.length === 0) {
      lines.push('No repos indexed yet.');
      lines.push('Run `index_folder({ path: "/absolute/path" })` before navigating code.');
    } else {
      lines.push('**Indexed repos (use these repoIds with all tools):**');
      for (const r of repos) {
        const indexed = r.indexedAt
          ? new Date(r.indexedAt).toISOString().slice(0, 19).replace('T', ' ')
          : 'unknown';
        lines.push(`- repoId \`${r.repoId}\` → \`${r.rootPath}\``);
        lines.push(`  ${r.fileCount ?? '?'} files · ${r.symbolCount ?? '?'} symbols · indexed ${indexed}`);
      }
    }

    lines.push('');
    lines.push('**Mandatory workflow — follow this order:**');
    lines.push('1. `list_repos()` — always run first to confirm repoId');
    lines.push('2. Navigate by symbol, not by file:');
    lines.push('   | Goal | Tool |');
    lines.push('   |------|------|');
    lines.push('   | Find function/class by name | `search_symbols` |');
    lines.push('   | Find code by what it does | `search_semantic` |');
    lines.push('   | See all symbols in a file | `get_file_outline` |');
    lines.push('   | Read a specific symbol | `get_symbol_source` |');
    lines.push('   | Understand dependencies | `get_context_bundle` |');
    lines.push('   | Know what breaks if I change X | `get_blast_radius` |');
    lines.push('   | Find all call sites | `find_references` |');
    lines.push('   | Non-symbol content (imports, config) | `get_file_content` with startLine/endLine |');
    lines.push('3. Read `summary` and `signature` before fetching source — only fetch what you will edit.');
    lines.push('');
    lines.push('**Never:** read whole files · use `search_text` for symbol lookups · skip `list_repos()`');

    process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }) + '\n');
  } catch {
    // Never block the subagent from starting
  }

  process.exit(0);
}

// ─── CLI dispatcher ───────────────────────────────────────────────────────────

export function runHooksCommand(args: string[]): void {
  const flag = args[0];
  if (flag === '--install') {
    cmdHooksInstall();
  } else if (flag === '--list') {
    cmdHooksList();
  } else {
    process.stderr.write('Usage: purecontext-mcp hooks --install | --list\n');
    process.exit(1);
  }
}
