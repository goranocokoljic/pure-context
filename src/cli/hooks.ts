/**
 * `purecontext-mcp hooks --install` / `hooks --list`
 * `purecontext-mcp hook-pretooluse|hook-posttooluse|hook-precompact|hook-worktree-create|hook-worktree-remove`
 *
 * Merges hook entries into ~/.claude/settings.json using direct node invocation
 * (node "<cliPath>" hook-*) so hooks never trigger npm registry SSL checks.
 * Also injects PureContext agent instructions into ~/.claude/CLAUDE.md.
 */

import { spawn, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { getSqliteFactory, type SqliteDatabase } from '../core/db/sqlite-loader.js';
import { resolveServerLaunch } from './resolve-node.js';
import { installGitHooks, uninstallGitHooks, gitHooksStatus, GIT_HOOK_NAMES } from './git-hooks.js';
import { getPureContextInstructions } from './install-writers.js';
import { readHeadDrift, formatDriftLine } from '../core/git-head.js';
import { computeRepoId, getJobsDir } from '../core/db/schema.js';
import { takeTaskCalls, formatCallsLine } from '../core/db/usage-ledger.js';
import { blobFileBytes, getBlobDbPath } from '../core/db/blob-store.js';
import { loadConfig } from '../config/config-loader.js';
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
//
// The Node binary is the user's *global/default* Node (Volta default, else the
// system Node) — NOT process.execPath, which would pin hooks to whatever Node
// happened to run `install` (e.g. a project-pinned version under Volta). Hooks
// are global tools and must be independent of the project they're installed from.
function makeHookCmd(subcommand: string): string {
  const cliScript = resolve(__dirname, '..', 'index.js');
  const nodeBin = resolveServerLaunch().command;
  const q = (p: string) => `"${p}"`;
  return `${q(nodeBin)} ${q(cliScript)} ${subcommand}`;
}

// ─── CLAUDE.md block ──────────────────────────────────────────────────────────
// Single-sourced from assets/agent-rules.md (Phase 97): `hooks --install` used
// to carry its own, older copy of the rules — the absolutist "Mandatory
// workflow" text Phase 91 had already replaced for `install` — so the two
// installers wrote different instructions. One source, one block.
function claudeMdBlock(): string {
  return `<!-- purecontext-mcp-start -->\n${getPureContextInstructions('markdown')}\n<!-- purecontext-mcp-end -->`;
}

// ─── Public install/list commands ─────────────────────────────────────────────

export interface HooksInstallOptions {
  /**
   * Install the PreToolUse edit-reminder hook (a stderr line on EVERY edit).
   * Off by default since Phase 91 — a per-edit reminder trains users to
   * ignore output. Opt in with `hooks --install --with-reminders`.
   */
  withReminders?: boolean;
}

export function cmdHooksInstall(opts: HooksInstallOptions = {}): void {
  const withReminders = opts.withReminders ?? false;

  // Print exactly what will be written, where, BEFORE writing (Phase 91 —
  // the install-runbook complaint was surprise, not capability).
  console.log('\nAbout to write:');
  console.log(`  ${SETTINGS_PATH}`);
  console.log('    hook entries: PostToolUse, PreCompact, WorktreeCreate, WorktreeRemove,');
  console.log(`    TaskCompleted, SubagentStart${withReminders ? ', PreToolUse (edit reminder)' : ''}`);
  if (!withReminders) {
    console.log('    (PreToolUse edit reminder NOT installed — opt in with --with-reminders)');
  }
  console.log(`  ${CLAUDE_MD_PATH}`);
  console.log('    PureContext instruction block (marker-delimited, idempotent)\n');

  mkdirSync(CLAUDE_DIR, { recursive: true });

  mergeSettings({ withReminders });
  injectClaudeMd();

  console.log('\nHooks installed. Reopen Claude Code to activate them.\n');
  console.log('Hooks registered (invoked directly via your global Node, no npx):');
  console.log('  PostToolUse  (hook-posttooluse):       re-indexes edited files automatically');
  console.log('  PreCompact   (hook-precompact):        injects repo state before context compaction');
  if (withReminders) {
    console.log('  PreToolUse   (hook-pretooluse):        suggests PureContext read tools before editing');
  }
  console.log('  WorktreeCreate  (hook-worktree-create):  auto-indexes new agent worktrees');
  console.log('  WorktreeRemove  (hook-worktree-remove):  fires when an agent worktree is removed');
  console.log('  TaskCompleted   (hook-taskcompleted):    post-task diagnostics and repo summary');
  console.log('  SubagentStart   (hook-subagentstart):    injects repo orientation for spawned agents');

  // These are Claude Code hooks (global). Branch changes are a GIT concern —
  // point at the per-repository git hooks so the two are not confused.
  const st = gitHooksStatus(process.cwd());
  if (st.hooksDir && !GIT_HOOK_NAMES.every((h) => st.installed[h])) {
    console.log('\nNot yet installed for this repository: git hooks (post-checkout / post-merge / post-rewrite).');
    console.log('They keep the index fresh after checkout, pull, merge and rebase, in every worktree:');
    console.log('  npx purecontext-mcp hooks --install --git');
  }
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
    try {
      if (readFileSync(SETTINGS_PATH, 'utf-8').includes('hook-pretooluse')) {
        console.log('    PreToolUse     → hook-pretooluse (edit reminder, opt-in)');
      }
    } catch {
      /* unreadable settings — skip the optional line */
    }
    console.log('    WorktreeCreate → hook-worktree-create');
    console.log('    WorktreeRemove → hook-worktree-remove');
    console.log('    TaskCompleted  → hook-taskcompleted');
    console.log('    SubagentStart  → hook-subagentstart');
  }

  // Git hooks (Phase 97) — per repository, so report the current one.
  const st = gitHooksStatus(process.cwd());
  console.log('');
  if (!st.hooksDir) {
    console.log('  git hooks: (current directory is not a git repository)');
  } else {
    const on = GIT_HOOK_NAMES.filter((h) => st.installed[h]);
    console.log(`  git hooks in ${st.hooksDir}:`);
    console.log(
      on.length === GIT_HOOK_NAMES.length
        ? `    installed (${on.join(', ')}) — checkout/merge/rebase re-index automatically`
        : on.length === 0
          ? '    not installed — run: purecontext-mcp hooks --install --git'
          : `    partial (${on.join(', ')}) — re-run: purecontext-mcp hooks --install --git`,
    );
  }
}

/** `hooks --install --git [--repo <path>]` */
export function cmdGitHooksInstall(repoPath: string): void {
  const res = installGitHooks(repoPath);
  console.log(`\nGit hooks installed in ${res.hooksDir}:`);
  for (const f of res.written) console.log(`  ${f}${res.chained.includes(f) ? '  (chained into existing hook)' : ''}`);
  console.log('\nEvery checkout / merge / rebase in this repository (all worktrees) now');
  console.log('re-indexes what changed. A new `git worktree add` clones the sibling index.');
  console.log('Remove with: purecontext-mcp hooks --uninstall --git');
  console.log('Index of a removed worktree: purecontext-mcp delete-index <path>\n');
}

/** `hooks --uninstall --git [--repo <path>]` */
export function cmdGitHooksUninstall(repoPath: string): void {
  const res = uninstallGitHooks(repoPath);
  if (res.removed.length === 0) {
    console.log(`\nNo PureContext git hooks found in ${res.hooksDir}.\n`);
    return;
  }
  console.log(`\nGit hooks removed from ${res.hooksDir}:`);
  for (const f of res.removed) console.log(`  ${f}`);
  console.log('');
}

// ─── Settings merge ───────────────────────────────────────────────────────────

export function mergeSettings(opts: HooksInstallOptions = {}): void {
  const withReminders = opts.withReminders ?? false;
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
  // PreToolUse edit reminder is opt-in (Phase 91): without --with-reminders,
  // an existing purecontext entry is REMOVED so re-running the installer
  // converges on the default-quiet configuration.
  if (withReminders) {
    hooks.PreToolUse = mergeHookEntry(
      hooks.PreToolUse ?? [],
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: makeHookCmd('hook-pretooluse') }] },
      ['purecontext-edit-guard.mjs', 'hook-pretooluse'],
    );
  } else {
    hooks.PreToolUse = removeHookEntry(hooks.PreToolUse ?? [], [
      'purecontext-edit-guard.mjs',
      'hook-pretooluse',
    ]);
    if (hooks.PreToolUse.length === 0) delete (hooks as Record<string, unknown>).PreToolUse;
  }
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

/** Remove any purecontext-owned entry for a hook type (matches old .mjs paths + CLI forms). */
function removeHookEntry(existing: unknown[], matchStrings: string[]): unknown[] {
  return existing.filter((e) => {
    const hooks = (e as Record<string, unknown[]>).hooks ?? [];
    return !hooks.some((h) => {
      const cmd = (h as Record<string, string>).command ?? '';
      return matchStrings.some((s) => cmd.includes(s));
    });
  });
}

function mergeHookEntry(
  existing: unknown[],
  entry: Record<string, unknown>,
  matchStrings: string[],
): unknown[] {
  // Remove any existing purecontext entry for this hook type (idempotent),
  // then append the fresh one.
  return [...removeHookEntry(existing, matchStrings), entry];
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

  const CLAUDE_MD_BLOCK = claudeMdBlock();
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

/**
 * Targeted re-index of the edited files in one repo. Uses the cheap single-file
 * path (index-file) rather than a full index-folder so the PostToolUse hook runs
 * sub-second instead of stalling ~11s on every edit. index-file bootstraps a full
 * index itself when the repo has not been indexed yet.
 */
function reindexFilesInRepo(repoRoot: string, filePaths: string[]): void {
  const selfScript = process.argv[1];
  if (!selfScript || filePaths.length === 0) return;
  spawnSync(process.execPath, [selfScript, 'index-file', '--repo', repoRoot, ...filePaths], {
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

    // Group edited files by repo root, then targeted-reindex each root once
    // (batches a MultiEdit's files into a single index-file call).
    const byRoot = new Map<string, string[]>();
    for (const fp of paths) {
      const root = findRepoRoot(fp);
      if (!root) continue;
      const list = byRoot.get(root) ?? [];
      list.push(fp);
      byRoot.set(root, list);
    }

    for (const [root, files] of byRoot) reindexFilesInRepo(root, files);
  } catch { /* never block the edit */ }

  process.exit(0);
}

interface RepoRow {
  id: string;
  root_path: string;
  file_count: number | null;
  indexed_at: string | null;
  git_tree_sha?: string | null;
}

/** One freshness line per repo (Phase 97): bounded git calls, no status walk. */
function freshnessLine(repoId: string, rootPath: string, sha: string | null | undefined): string {
  try {
    const d = readHeadDrift(rootPath, sha ?? null, { skipDirty: true, jobsDir: getJobsDir(), repoId });
    return formatDriftLine(d);
  } catch {
    return 'freshness unknown';
  }
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
      const rows = db.prepare('SELECT id, root_path, file_count, indexed_at, git_tree_sha FROM repos LIMIT 50').all() as RepoRow[];
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
    lines.push(
      `- ${r.id} at ${r.root_path} (${r.file_count ?? '?'} files, last indexed ${indexed}; ` +
        `${freshnessLine(r.id, r.root_path, r.git_tree_sha)})`,
    );
  }
  lines.push('- Use list_repos() to re-orient if needed; "behind" → index_folder({ path, onlyChanged: true }).');
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

    // Phase 97: DETACHED, no timeout (the old 120 s cap died on big trees and
    // left a silent partial index). index-changed clones a sibling worktree's
    // index when one exists, else falls back to a full index; the job marker
    // makes list_repos / check_index_staleness say "re-index in progress".
    const selfScript = process.argv[1];
    if (selfScript) {
      const child = spawn(
        process.execPath,
        [selfScript, 'index-changed', '--repo', targetPath, '--job'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
    }
  } catch { /* never block */ }

  process.exit(0);
}

/**
 * WorktreeRemove: drop the index of the removed worktree.
 * - `.claude/worktrees/<name>` (created and removed by Claude Code): deleted
 *   outright — those indexes are ours.
 * - any other worktree (Phase 100): a SCOPED gc — the index goes only if its
 *   root path is already gone from disk and no re-index is running. If the
 *   hook fires before the directory is removed, the next `list_repos`
 *   reports it (`rootExists: false`) and `gc_indexes` / `index gc` removes it.
 */
export async function cmdHookWorktreeRemove(): Promise<void> {
  try {
    const input = await readStdin();
    const worktreePath = (input.worktreePath ?? input.worktree_path) as string | undefined;
    if (worktreePath && isClaudeManagedWorktree(worktreePath)) {
      const { deleteIndex } = await import('../core/index-manager.js');
      deleteIndex(computeRepoId(resolve(worktreePath)));
    } else if (worktreePath) {
      const { applyGc } = await import('../core/index-gc.js');
      applyGc({ scopeRoot: resolve(worktreePath) });
    }
  } catch { /* never block */ }
  process.exit(0);
}

/** `<root>/.claude/worktrees/<name>` (either slash style). */
export function isClaudeManagedWorktree(p: string): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(resolve(p));
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
  gitTreeSha: string | null;
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
        'SELECT id, root_path, file_count, indexed_at, git_tree_sha FROM repos LIMIT 1',
      ).get() as { id: string; root_path: string; file_count: number | null; indexed_at: string | null; git_tree_sha: string | null } | undefined;
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
        gitTreeSha: repo.git_tree_sha ?? null,
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
    // Phase 97 (Task 603): the FIRST line answers "did the agent use
    // PureContext on this task?" — counted from the local ledger since the
    // previous TaskCompleted, never asked of the agent.
    let callsLine: string;
    try {
      const ledgerOn = loadConfig().telemetry?.usageLedger ?? true;
      callsLine = ledgerOn
        ? formatCallsLine(takeTaskCalls())
        : 'PureContext this task: (usage ledger off — telemetry.usageLedger)';
    } catch {
      callsLine = 'PureContext this task: (ledger unavailable)';
    }

    const repos = readRepoStats();
    if (repos.length === 0) {
      process.stdout.write(JSON.stringify({ systemMessage: callsLine }) + '\n');
      process.exit(0);
    }

    const lines: string[] = [callsLine, '', '## PureContext Post-Task Summary\n'];

    // Phase 100 (R4): the shared blob store grows until `index gc --blobs`
    // runs; say so once it passes the configured size.
    try {
      const warnAt = loadConfig().storage?.blobWarnBytes ?? 0;
      const blobBytes = blobFileBytes(getBlobDbPath());
      if (warnAt > 0 && blobBytes > warnAt) {
        lines.push(
          `⚠ blob store is ${(blobBytes / 1_073_741_824).toFixed(2)} GB — run \`purecontext-mcp index gc --blobs\` (dry run) to see what is unreferenced.`,
        );
        lines.push('');
      }
    } catch { /* ignore */ }

    lines.push('**Indexed repos:**');
    for (const r of repos) {
      const indexed = r.indexedAt
        ? new Date(r.indexedAt).toISOString().slice(0, 19).replace('T', ' ')
        : 'unknown';
      lines.push(`- \`${r.repoId}\` → \`${r.rootPath}\``);
      lines.push(`  ${r.fileCount ?? '?'} files · ${r.symbolCount ?? '?'} symbols · indexed ${indexed}`);
      lines.push(`  freshness: ${freshnessLine(r.repoId, r.rootPath, r.gitTreeSha)}`);
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
        lines.push(`  freshness: ${freshnessLine(r.repoId, r.rootPath, r.gitTreeSha)}`);
      }
    }

    lines.push('');
    lines.push('**Mandatory workflow — follow this order:**');
    lines.push('1. `list_repos()` — always run first to confirm repoId; read its `head`/`freshness` line — "behind" → `index_folder({ path, onlyChanged: true })`');
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
  const repoIdx = args.indexOf('--repo');
  const repoPath = repoIdx >= 0 && args[repoIdx + 1] ? resolve(args[repoIdx + 1]) : process.cwd();
  const isGit = args.includes('--git');

  if (flag === '--install' && isGit) {
    try {
      cmdGitHooksInstall(repoPath);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  } else if (flag === '--uninstall' && isGit) {
    try {
      cmdGitHooksUninstall(repoPath);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  } else if (flag === '--install') {
    cmdHooksInstall({ withReminders: args.includes('--with-reminders') });
  } else if (flag === '--list') {
    cmdHooksList();
  } else {
    process.stderr.write(
      'Usage: purecontext-mcp hooks --install [--with-reminders] | --list\n' +
        '       purecontext-mcp hooks --install --git [--repo <path>]     (post-checkout/merge/rewrite)\n' +
        '       purecontext-mcp hooks --uninstall --git [--repo <path>]\n',
    );
    process.exit(1);
  }
}
