/**
 * `purecontext-mcp install <tool|all>  [--scope=local|global|both]  [--dry-run]  [--list]`
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
  const toolArg = args.find((a) => !a.startsWith('--'));

  if (listFlag) {
    await cmdInstallList(projectRoot);
    return;
  }

  if (!toolArg) {
    process.stderr.write(
      'Usage: purecontext-mcp install <tool|all>  [--scope=local|global|both]  ' +
        '[--with-hooks]  [--with-reminders]  [--dry-run]  [--list]\n',
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
}
