/**
 * `purecontext-mcp install <tool|all>  [--scope=local|global|both]  [--with-git-hooks]  [--dry-run]  [--list]`
 *
 * Installs PureContext agent instructions into the conventions file of the
 * specified AI coding IDE.  `install all` auto-detects installed tools and
 * installs each in sequence.  `install --list` shows detection state without
 * writing anything.
 *
 * If `--scope` is omitted the user is prompted interactively.  In
 * non-interactive environments (piped stdin) the prompt is skipped and
 * `local` is used as a safe default.
 */

import { createInterface } from 'readline';
import { join } from 'path';
import { detectInstalledIDEs } from './install-detect.js';
import { INSTALL_WRITERS, type Scope, type InstallWriterOptions } from './install-writers.js';
import { gitHooksStatus, installGitHooks, GIT_HOOK_NAMES } from './git-hooks.js';

// ─── Scope helpers ────────────────────────────────────────────────────────────

const VALID_SCOPES = ['local', 'global', 'both'] as const;

function parseScope(args: string[]): Scope | undefined {
  // --scope=local  or  --scope local
  const eqForm = args.find((a) => a.startsWith('--scope='))?.split('=')[1];
  if (eqForm) return VALID_SCOPES.includes(eqForm as Scope) ? (eqForm as Scope) : undefined;
  const idx = args.indexOf('--scope');
  if (idx !== -1 && args[idx + 1]) {
    const val = args[idx + 1];
    return VALID_SCOPES.includes(val as Scope) ? (val as Scope) : undefined;
  }
  return undefined;
}

async function promptScope(): Promise<Scope> {
  if (!process.stdin.isTTY) return 'local';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log('\nWhere should PureContext be installed?');
    console.log('  1) Local  — this project only');
    console.log('  2) Global — all projects (user-level config)');
    console.log('  3) Both\n');
    rl.question('Choice [1/2/3]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '2') resolve('global');
      else if (trimmed === '3') resolve('both');
      else resolve('local');
    });
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOWN_TOOLS = [
  'claude',
  'cursor',
  'windsurf',
  'continue',
  'cline',
  'roo-code',
  'copilot',
  'claude-desktop',
] as const;

type KnownTool = typeof KNOWN_TOOLS[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isKnownTool(tool: string): tool is KnownTool {
  return (KNOWN_TOOLS as readonly string[]).includes(tool);
}

async function runInstall(
  tool: string,
  projectRoot: string,
  dryRun: boolean,
  scope: Scope,
  opts: InstallWriterOptions = {},
): Promise<boolean> {
  const writer = INSTALL_WRITERS[tool];
  if (!writer) return false;

  if (dryRun) {
    console.log(`  [dry-run] Would install: ${tool} (${scope})`);
    if (tool === 'claude') {
      console.log(
        `  [dry-run]   hooks: ${opts.withHooks ? 'YES (--with-hooks)' : 'no (default; pass --with-hooks)'}`,
      );
    }
    return true;
  }

  try {
    await writer(projectRoot, scope, opts);
    return true;
  } catch (err) {
    process.stderr.write(`  Error installing ${tool}: ${(err as Error).message}\n`);
    return false;
  }
}

// ─── Git hooks (Phase 97) ─────────────────────────────────────────────────────

export type GitHooksInstallOutcome = 'installed' | 'already' | 'not_git' | 'dry_run' | 'error';

/**
 * `--with-git-hooks`: install the post-checkout / post-merge / post-rewrite
 * shims for the repository containing `projectRoot`. Without the flag,
 * `hintGitHooks` prints the one-liner instead — freshness after a branch
 * change is the most-missed step, so the installer always mentions it.
 */
export function maybeInstallGitHooksForProject(
  projectRoot: string,
  opts: { dryRun?: boolean; log?: (line: string) => void } = {},
): GitHooksInstallOutcome {
  const log = opts.log ?? ((l: string) => console.log(l));
  const st = gitHooksStatus(projectRoot);
  if (!st.hooksDir) {
    log('  git hooks: skipped — this directory is not inside a git repository');
    return 'not_git';
  }
  if (opts.dryRun) {
    log(`  [dry-run] Would install git hooks (${GIT_HOOK_NAMES.join(', ')}) in ${st.hooksDir}`);
    return 'dry_run';
  }
  const already = GIT_HOOK_NAMES.every((h) => st.installed[h]);
  try {
    const res = installGitHooks(projectRoot);
    log(`  git hooks (${GIT_HOOK_NAMES.join(', ')}): ${already ? 'refreshed' : 'installed'} in ${res.hooksDir}`);
    for (const f of res.chained) log(`    chained into existing hook: ${f}`);
    return already ? 'already' : 'installed';
  } catch (err) {
    log(`  git hooks: error — ${(err as Error).message}`);
    return 'error';
  }
}

/** The always-printed reminder when git hooks are NOT installed for this repo. */
export function hintGitHooks(projectRoot: string, log: (line: string) => void = (l) => console.log(l)): void {
  const st = gitHooksStatus(projectRoot);
  if (!st.hooksDir) return; // not a git repo — nothing to hook
  if (GIT_HOOK_NAMES.every((h) => st.installed[h])) {
    log('\nGit hooks: installed — checkout / merge / rebase keep the index fresh automatically.');
    return;
  }
  log('\nKeep the index fresh after branch changes (recommended — one command, never blocks git):');
  log('  npx purecontext-mcp hooks --install --git');
  log('  (or re-run install with --with-git-hooks; remove with hooks --uninstall --git)');
}

// ─── Sub-commands ─────────────────────────────────────────────────────────────

async function cmdInstallOne(
  tool: string,
  projectRoot: string,
  dryRun: boolean,
  scope: Scope,
  opts: InstallWriterOptions,
): Promise<void> {
  if (!isKnownTool(tool)) {
    process.stderr.write(
      `Unknown tool: "${tool}"\nValid tools: ${KNOWN_TOOLS.join(', ')}\n`,
    );
    process.exit(1);
  }

  const ok = await runInstall(tool, projectRoot, dryRun, scope, opts);
  if (ok && !dryRun) {
    console.log(`\nInstalled for ${tool} (${scope}).`);
  }
}

async function cmdInstallAll(
  projectRoot: string,
  dryRun: boolean,
  scope: Scope,
  opts: InstallWriterOptions,
): Promise<void> {
  const detected = await detectInstalledIDEs(projectRoot);

  if (detected.length === 0) {
    console.log('No supported IDEs detected in this directory.');
    console.log(`Run \`npx purecontext-mcp install <tool>\` to install for a specific tool.`);
    console.log(`Supported tools: ${KNOWN_TOOLS.join(', ')}`);
    return;
  }

  const notDetected = KNOWN_TOOLS.filter((t) => !detected.includes(t));

  console.log(`Detected IDEs: ${detected.join(', ')}\n`);

  // Always include claude hooks when installing any tool
  const toInstall = detected.includes('claude')
    ? detected
    : ['claude', ...detected];

  for (const tool of toInstall) {
    const label = `Installing ${tool}...`.padEnd(24);
    const ok = await runInstall(tool, projectRoot, dryRun, scope, opts);
    console.log(`${label} ${ok ? '✓' : '✗'}`);
  }

  if (notDetected.length > 0) {
    console.log(`\nNot detected: ${notDetected.join(', ')}`);
    console.log(`Run \`npx purecontext-mcp install <tool>\` to install for a specific tool manually.`);
  }
}

async function cmdInstallList(projectRoot: string): Promise<void> {
  const detected = await detectInstalledIDEs(projectRoot);
  console.log('\nIDE detection results:\n');
  for (const tool of KNOWN_TOOLS) {
    const status = detected.includes(tool) ? 'detected' : 'not detected';
    console.log(`  ${tool.padEnd(16)} ${status}`);
  }
  console.log();
}

// ─── CLI dispatcher ───────────────────────────────────────────────────────────

export async function runInstallCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const dryRun = args.includes('--dry-run');
  const listFlag = args.includes('--list');
  // Phase 91 safe-by-default: hooks only on explicit request.
  const opts: InstallWriterOptions = {
    withHooks: args.includes('--with-hooks'),
    withReminders: args.includes('--with-reminders'),
  };
  const withGitHooks = args.includes('--with-git-hooks');
  const toolArg = args.find((a) => !a.startsWith('--'));

  if (listFlag) {
    await cmdInstallList(projectRoot);
    return;
  }

  if (!toolArg) {
    process.stderr.write(
      'Usage: purecontext-mcp install <tool|all>  [--scope=local|global|both]  ' +
        '[--with-git-hooks]  [--with-hooks]  [--with-reminders]  [--dry-run]  [--list]\n',
    );
    process.stderr.write(`Supported tools: ${KNOWN_TOOLS.join(', ')}\n`);
    process.exit(1);
  }

  const scope: Scope = parseScope(args) ?? (await promptScope());

  if (toolArg === 'all') {
    await cmdInstallAll(projectRoot, dryRun, scope, opts);
  } else {
    await cmdInstallOne(toolArg, projectRoot, dryRun, scope, opts);
  }

  // Phase 97: freshness after a branch change is the step people miss, so
  // the installer either does it (--with-git-hooks) or says how, every time.
  if (withGitHooks) {
    maybeInstallGitHooksForProject(projectRoot, { dryRun });
  } else if (!dryRun) {
    hintGitHooks(projectRoot);
  }
}
