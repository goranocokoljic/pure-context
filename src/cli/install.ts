/**
 * `purecontext-mcp install <tool|all>  [--dry-run]  [--list]`
 *
 * Installs PureContext agent instructions into the conventions file of the
 * specified AI coding IDE.  `install all` auto-detects installed tools and
 * installs each in sequence.  `install --list` shows detection state without
 * writing anything.
 */

import { join } from 'path';
import { detectInstalledIDEs } from './install-detect.js';
import { INSTALL_WRITERS } from './install-writers.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOWN_TOOLS = [
  'claude',
  'cursor',
  'windsurf',
  'continue',
  'cline',
  'roo-code',
  'vscode',
  'claude-desktop',
] as const;

type KnownTool = typeof KNOWN_TOOLS[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isKnownTool(tool: string): tool is KnownTool {
  return (KNOWN_TOOLS as readonly string[]).includes(tool);
}

async function runInstall(tool: string, projectRoot: string, dryRun: boolean): Promise<boolean> {
  const writer = INSTALL_WRITERS[tool];
  if (!writer) return false;

  if (dryRun) {
    console.log(`  [dry-run] Would install: ${tool}`);
    return true;
  }

  try {
    await writer(projectRoot);
    return true;
  } catch (err) {
    process.stderr.write(`  Error installing ${tool}: ${(err as Error).message}\n`);
    return false;
  }
}

// ─── Sub-commands ─────────────────────────────────────────────────────────────

async function cmdInstallOne(tool: string, projectRoot: string, dryRun: boolean): Promise<void> {
  if (!isKnownTool(tool)) {
    process.stderr.write(
      `Unknown tool: "${tool}"\nValid tools: ${KNOWN_TOOLS.join(', ')}\n`,
    );
    process.exit(1);
  }

  const ok = await runInstall(tool, projectRoot, dryRun);
  if (ok && !dryRun) {
    console.log(`\nInstalled for ${tool}.`);
  }
}

async function cmdInstallAll(projectRoot: string, dryRun: boolean): Promise<void> {
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
    const ok = await runInstall(tool, projectRoot, dryRun);
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
  const toolArg = args.find((a) => !a.startsWith('--'));

  if (listFlag) {
    await cmdInstallList(projectRoot);
    return;
  }

  if (!toolArg) {
    process.stderr.write('Usage: purecontext-mcp install <tool|all>  [--dry-run]  [--list]\n');
    process.stderr.write(`Supported tools: ${KNOWN_TOOLS.join(', ')}\n`);
    process.exit(1);
  }

  if (toolArg === 'all') {
    await cmdInstallAll(projectRoot, dryRun);
  } else {
    await cmdInstallOne(toolArg, projectRoot, dryRun);
  }
}
