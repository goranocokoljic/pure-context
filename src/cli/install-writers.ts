/**
 * Per-IDE writer functions for `purecontext-mcp install <tool>`.
 *
 * Each exported `install*` function is idempotent: calling it twice produces
 * the same result without duplicating content.  Marker comments
 * (`<!-- purecontext-mcp-start/end -->`) delimit the managed block so that
 * updates replace rather than append.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { cmdHooksInstall, injectClaudeMd } from './hooks.js';
import { getClaudeDesktopConfigPath } from './install-detect.js';
import { resolveServerLaunch, nodeMajor } from './resolve-node.js';

export type Scope = 'local' | 'global' | 'both';

// ─── Shared markers ───────────────────────────────────────────────────────────

export const START_MARKER = '<!-- purecontext-mcp-start -->';
export const END_MARKER = '<!-- purecontext-mcp-end -->';

// ─── Shared instruction content ───────────────────────────────────────────────

// Single source of truth for the compact always-on agent rules. It lives as
// plain markdown at the package root (`assets/agent-rules.md`) — edited there,
// read here. Both src/cli/ (dev + tests) and dist/cli/ (published package) sit
// exactly two levels under the package root, so the same relative path resolves
// in either layout. `assets/` is listed in package.json `files`, so it ships.
function agentRulesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'assets', 'agent-rules.md');
}

let cachedMarkdownContent: string | null = null;

function getMarkdownContent(): string {
  if (cachedMarkdownContent !== null) return cachedMarkdownContent;
  const path = agentRulesPath();
  if (!existsSync(path)) {
    throw new Error(
      `PureContext: agent rules file not found at ${path}. ` +
        'This file ships with the package — reinstall purecontext-mcp if it is missing.',
    );
  }
  cachedMarkdownContent = readFileSync(path, 'utf-8').trimEnd();
  return cachedMarkdownContent;
}

export function getPureContextInstructions(format: 'markdown' | 'mdc' | 'json-system'): string {
  const content = getMarkdownContent();
  if (format === 'mdc') {
    return `---\ndescription: PureContext MCP code navigation rules\nalwaysApply: true\n---\n\n${content}`;
  }
  return content;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function replaceMarkerBlock(existing: string, newBlock: string): string {
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + newBlock + existing.slice(endIdx + END_MARKER.length);
  }
  // No existing block — append
  if (!existing.endsWith('\n')) existing += '\n';
  return existing + '\n' + newBlock + '\n';
}

function markedBlock(content: string): string {
  return `${START_MARKER}\n${content}\n${END_MARKER}`;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeIdempotent(filePath: string, content: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, content, 'utf-8');
}

// ─── Per-IDE installers ───────────────────────────────────────────────────────

/**
 * Install for Claude Code.
 * local  → writes instruction block to <project>/CLAUDE.md
 * global → writes ~/.claude/CLAUDE.md instruction block (hooks only with
 *          opts.withHooks — Phase 91 safe-by-default installer)
 * both   → both of the above
 *
 * Hooks are NO LONGER installed by default: `install claude --with-hooks`
 * opts in, and `hooks --install` remains the explicit path.
 */
export async function installClaude(
  projectRoot: string,
  scope: Scope,
  opts: { withHooks?: boolean; withReminders?: boolean } = {},
): Promise<void> {
  if (scope === 'local' || scope === 'both') {
    const filePath = join(projectRoot, 'CLAUDE.md');
    const block = markedBlock(getPureContextInstructions('markdown'));
    console.log(`  Will write instruction block: ${filePath}`);
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
    } else {
      writeIdempotent(filePath, block + '\n');
    }
  }
  if (scope === 'global' || scope === 'both') {
    if (opts.withHooks) {
      cmdHooksInstall({ withReminders: opts.withReminders ?? false });
    } else {
      injectClaudeMd();
      console.log('  Hooks NOT installed (safe default). Opt in with: install claude --with-hooks');
      console.log('  or: npx purecontext-mcp hooks --install');
    }
  }
  registerClaudeCodeMcpServer(scope);
}

const MCP_SERVER_NAME = 'purecontext-mcp';

// install scope -> Claude Code MCP scope. A global/both install registers the
// server for every project (user scope); a local install registers it just for
// this project (local scope, still private to the user — never committed).
function mcpScopeFor(scope: Scope): 'user' | 'local' {
  return scope === 'local' ? 'local' : 'user';
}

function shellQuote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Is the `claude` CLI available on PATH? */
function hasClaudeCli(): boolean {
  const res = spawnSync('claude --version', { shell: true, stdio: 'ignore' });
  return !res.error && res.status === 0;
}

/**
 * Register the MCP server with Claude Code, pinned to the user's global Node.
 *
 * Prefers actually running `claude mcp add` (so the server is live, not just
 * documented). Re-runs are idempotent: any existing entry is removed first so
 * the command always reflects the freshly-resolved Node. If the `claude` CLI
 * isn't on PATH, or the call fails, we fall back to printing the exact command.
 *
 * Note: MCP registration is intentionally done via the Claude CLI / user store,
 * never by writing a machine-specific absolute Node path into a project file.
 */
function registerClaudeCodeMcpServer(scope: Scope): void {
  const launch = resolveServerLaunch();
  warnIfNodeTooOld(launch.nodeVersion);
  const mcpScope = mcpScopeFor(scope);
  const tail = [launch.command, ...launch.args].map(shellQuote).join(' ');
  const addCommand = `claude mcp add ${MCP_SERVER_NAME} --scope ${mcpScope} -- ${tail}`;

  // Never shell out under the test runner, or when explicitly opted out (CI /
  // scripted installs) — just print the command so the run has no side effects.
  if (process.env['VITEST'] || process.env['PCTX_SKIP_MCP_REGISTER']) {
    console.log(`\nRegister the MCP server (pinned to your global Node) with:\n  ${addCommand}\n`);
    return;
  }

  if (!hasClaudeCli()) {
    console.log(
      '\nThe `claude` CLI was not found on PATH, so the MCP server was not auto-registered.\n' +
        'Register it (pinned to your global Node) with:\n' +
        `  ${addCommand}\n`,
    );
    return;
  }

  // Idempotent refresh: drop any existing entry (ignore failure), then add.
  spawnSync(`claude mcp remove ${MCP_SERVER_NAME} --scope ${mcpScope}`, { shell: true, stdio: 'ignore' });
  const res = spawnSync(addCommand, { shell: true, encoding: 'utf-8' });

  if (res.status === 0) {
    console.log(
      `\nRegistered MCP server "${MCP_SERVER_NAME}" (${mcpScope} scope, pinned to your global Node).`,
    );
  } else {
    console.log(
      '\nCould not auto-register the MCP server via `claude mcp add`. Register it manually:\n' +
        `  ${addCommand}\n` +
        (res.stderr ? `(${String(res.stderr).trim().split('\n').slice(-1)[0]})\n` : ''),
    );
  }
}

// ─── MCP server registration for `mcpServers`-format agents ───────────────────
// Cursor, Windsurf, Cline, and Roo Code all consume the same JSON shape:
//   { "mcpServers": { "<name>": { "command", "args" } } }
// so one helper registers the server (pinned to the global Node) into each
// agent's per-user MCP config. These are machine-local files, so the absolute
// Node path is appropriate (same rationale as Claude Desktop).

function cursorMcpConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

function windsurfMcpConfigPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
}

function vscodeUserDir(): string {
  const p = platform();
  if (p === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return join(homedir(), '.config', 'Code', 'User');
}

function clineMcpConfigPath(): string {
  return join(vscodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
}

function rooMcpConfigPath(): string {
  return join(vscodeUserDir(), 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
}

function mcpRegistrationDisabled(): boolean {
  return Boolean(process.env['VITEST'] || process.env['PCTX_SKIP_MCP_REGISTER']);
}

/**
 * Merge a global-Node-pinned `purecontext-mcp` entry into a JSON config using
 * the shared `mcpServers` shape. Idempotent (preserves other servers).
 *
 * @param createIfMissing  When false (Cline/Roo, whose VS Code globalStorage
 *   paths vary by install), only write if the config's directory already
 *   exists; otherwise print the entry to add manually rather than guess a path.
 */
function registerAgentMcpServer(
  label: string,
  configPath: string,
  opts: { createIfMissing: boolean },
): void {
  const launch = resolveServerLaunch();
  const manualEntry =
    `{ "command": ${JSON.stringify(launch.command)}, "args": ${JSON.stringify(launch.args)} }`;

  if (mcpRegistrationDisabled()) {
    console.log(`  ${label}: MCP registration skipped (test/CI). Entry: "${MCP_SERVER_NAME}": ${manualEntry}`);
    return;
  }
  warnIfNodeTooOld(launch.nodeVersion);

  if (!opts.createIfMissing && !existsSync(dirname(configPath))) {
    console.log(
      `  ${label}: MCP config dir not found — add this to your ${label} MCP config manually:\n` +
        `    "${MCP_SERVER_NAME}": ${manualEntry}`,
    );
    return;
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  } else {
    ensureDir(configPath);
  }

  const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
  servers[MCP_SERVER_NAME] = { command: launch.command, args: launch.args };
  config['mcpServers'] = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  ${label}: registered MCP server (pinned to your global Node) → ${configPath}`);
}

// ─── Continue (YAML `mcpServers` list) ────────────────────────────────────────

function continueConfigYamlPath(): string {
  return join(homedir(), '.continue', 'config.yaml');
}

/**
 * Register the server in Continue's `~/.continue/config.yaml` `mcpServers` list
 * (a YAML array of `{ name, command, args }`). We only MERGE into an existing
 * config.yaml — never create one — because a valid Continue assistant config
 * requires top-level fields (name/version) we shouldn't invent. If there's no
 * config.yaml, we print the entry to add by hand.
 */
function registerContinueMcpServer(): void {
  const launch = resolveServerLaunch();
  const manualYaml =
    `  - name: ${MCP_SERVER_NAME}\n    command: ${launch.command}\n    args:\n      - ${launch.args[0] ?? ''}`;

  if (mcpRegistrationDisabled()) {
    console.log(`  continue: MCP registration skipped (test/CI).`);
    return;
  }
  warnIfNodeTooOld(launch.nodeVersion);

  const path = continueConfigYamlPath();
  if (!existsSync(path)) {
    console.log(
      `  continue: no config.yaml found — add to ~/.continue/config.yaml under mcpServers:\n${manualYaml}`,
    );
    return;
  }

  let doc: Record<string, unknown> = {};
  try {
    doc = (yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {};
  } catch {
    console.log(`  continue: could not parse config.yaml — add under mcpServers:\n${manualYaml}`);
    return;
  }
  const existing = Array.isArray(doc['mcpServers'])
    ? (doc['mcpServers'] as Array<Record<string, unknown>>)
    : [];
  const merged = existing.filter((s) => s?.['name'] !== MCP_SERVER_NAME);
  merged.push({ name: MCP_SERVER_NAME, command: launch.command, args: launch.args });
  doc['mcpServers'] = merged;
  writeFileSync(path, yaml.dump(doc), 'utf-8');
  console.log(`  continue: registered MCP server (pinned to your global Node) → ${path}`);
}

// ─── Copilot / VS Code (`servers` map, stdio type) ────────────────────────────

function vscodeUserMcpJsonPath(): string {
  return join(vscodeUserDir(), 'mcp.json');
}

/**
 * Register the server in VS Code's user MCP config (`<user>/mcp.json`), which
 * GitHub Copilot reads. Schema differs from the other agents: a `servers` map
 * whose entries carry `"type": "stdio"`. Only written when the VS Code user dir
 * exists; otherwise the entry is printed.
 */
function registerCopilotMcpServer(): void {
  const launch = resolveServerLaunch();
  const entry = { type: 'stdio', command: launch.command, args: launch.args };

  if (mcpRegistrationDisabled()) {
    console.log(`  copilot: MCP registration skipped (test/CI).`);
    return;
  }
  warnIfNodeTooOld(launch.nodeVersion);

  if (!existsSync(vscodeUserDir())) {
    console.log(
      `  copilot: VS Code user dir not found — add "${MCP_SERVER_NAME}" to VS Code MCP config ` +
        `(servers map, "type":"stdio") manually: ${JSON.stringify(entry)}`,
    );
    return;
  }

  const path = vscodeUserMcpJsonPath();
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  } else {
    ensureDir(path);
  }
  const servers = (config['servers'] ?? {}) as Record<string, unknown>;
  servers[MCP_SERVER_NAME] = entry;
  config['servers'] = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  copilot: registered MCP server (pinned to your global Node) → ${path}`);
}

/**
 * Write `purecontext.mdc` with MDC frontmatter.
 * local  → <project>/.cursor/rules/
 * global → ~/.cursor/rules/
 */
export async function installCursor(projectRoot: string, scope: Scope): Promise<void> {
  registerAgentMcpServer('cursor', cursorMcpConfigPath(), { createIfMissing: true });

  const writeMdc = (filePath: string) => {
    ensureDir(filePath);
    const mdcContent = getPureContextInstructions('mdc');
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing.includes(START_MARKER)) {
        writeFileSync(filePath, replaceMarkerBlock(existing, markedBlock(getMarkdownContent())), 'utf-8');
        return;
      }
    }
    writeIdempotent(filePath, mdcContent + '\n');
  };

  if (scope === 'local' || scope === 'both') {
    writeMdc(join(projectRoot, '.cursor', 'rules', 'purecontext.mdc'));
  }
  if (scope === 'global' || scope === 'both') {
    writeMdc(join(homedir(), '.cursor', 'rules', 'purecontext.mdc'));
  }
}

/**
 * Write `purecontext.md` into the Windsurf rules directory.
 * local  → <project>/.windsurf/rules/purecontext.md
 * global → ~/.windsurf/rules/purecontext.md
 */
export async function installWindsurf(projectRoot: string, scope: Scope): Promise<void> {
  registerAgentMcpServer('windsurf', windsurfMcpConfigPath(), { createIfMissing: true });
  const writeLocal = (filePath: string) => {
    ensureDir(filePath);
    writeFileSync(filePath, getPureContextInstructions('markdown') + '\n', 'utf-8');
  };

  const writeGlobal = (filePath: string) => {
    const block = markedBlock(getPureContextInstructions('markdown'));
    ensureDir(filePath);
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
    } else {
      writeFileSync(filePath, block + '\n', 'utf-8');
    }
  };

  if (scope === 'local' || scope === 'both') {
    writeLocal(join(projectRoot, '.windsurf', 'rules', 'purecontext.md'));
  }
  if (scope === 'global' || scope === 'both') {
    writeGlobal(join(homedir(), '.windsurf', 'rules', 'purecontext.md'));
  }
}

/**
 * Merge a `systemMessage` field into a Continue `config.json`.
 * local  → <project>/.continue/config.json
 * global → ~/.continue/config.json
 */
export async function installContinue(projectRoot: string, scope: Scope): Promise<void> {
  registerContinueMcpServer();
  const writeConfig = (filePath: string) => {
    ensureDir(filePath);
    const instructions = getPureContextInstructions('json-system');
    let config: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        config = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    config['systemMessage'] = instructions;
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  };

  if (scope === 'local' || scope === 'both') {
    writeConfig(join(projectRoot, '.continue', 'config.json'));
  }
  if (scope === 'global' || scope === 'both') {
    writeConfig(join(homedir(), '.continue', 'config.json'));
  }
}

/**
 * Write `.clinerules` with a marked block.
 * local only — Cline has no known global config path.
 */
export async function installCline(projectRoot: string, scope: Scope): Promise<void> {
  // MCP registration is global (user-level) and scope-independent — do it before
  // the scope-gated rules handling below.
  registerAgentMcpServer('cline', clineMcpConfigPath(), { createIfMissing: false });
  if (scope === 'global') {
    console.log('  cline: no known global config path — skipped');
    return;
  }
  const filePath = join(projectRoot, '.clinerules');
  const block = markedBlock(getPureContextInstructions('markdown'));
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeIdempotent(filePath, block + '\n');
  }
  if (scope === 'both') {
    console.log('  cline: no known global config path — global install skipped');
  }
}

/**
 * Write `.roo/rules-code.md` with a marked block.
 * local only — Roo Code has no known global config path.
 */
export async function installRooCode(projectRoot: string, scope: Scope): Promise<void> {
  // MCP registration is global (user-level) and scope-independent.
  registerAgentMcpServer('roo-code', rooMcpConfigPath(), { createIfMissing: false });
  if (scope === 'global') {
    console.log('  roo-code: no known global config path — skipped');
    return;
  }
  const filePath = join(projectRoot, '.roo', 'rules-code.md');
  const block = markedBlock(getPureContextInstructions('markdown'));
  ensureDir(filePath);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeFileSync(filePath, block + '\n', 'utf-8');
  }
  if (scope === 'both') {
    console.log('  roo-code: no known global config path — global install skipped');
  }
}

/**
 * Write `.github/copilot-instructions.md` with a marked block.
 * local only — GitHub Copilot has no standard global instructions path.
 */
export async function installCopilot(projectRoot: string, scope: Scope): Promise<void> {
  // MCP registration is global (VS Code user config) and scope-independent.
  registerCopilotMcpServer();
  if (scope === 'global') {
    console.log('  copilot: no known global config path — skipped');
    return;
  }
  const filePath = join(projectRoot, '.github', 'copilot-instructions.md');
  const block = markedBlock(getPureContextInstructions('markdown'));
  ensureDir(filePath);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeFileSync(filePath, block + '\n', 'utf-8');
  }
  if (scope === 'both') {
    console.log('  copilot: no known global config path — global install skipped');
  }
}

/**
 * Merge the PureContext MCP server entry into the Claude Desktop config JSON.
 * Always global — scope parameter is accepted for API consistency but ignored.
 */
export async function installClaudeDesktop(_projectRoot: string, _scope: Scope): Promise<void> {
  const configPath = getClaudeDesktopConfigPath();
  if (!configPath) {
    throw new Error('Cannot determine Claude Desktop config path for this platform');
  }

  ensureDir(configPath);

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const mcpServers = (config['mcpServers'] ?? {}) as Record<string, unknown>;

  // Pin the server to a globally-available Node (Volta default / system),
  // independent of any project's Node pin. This is a user-scope config, so the
  // machine-specific absolute node path is appropriate here.
  const launch = resolveServerLaunch();
  warnIfNodeTooOld(launch.nodeVersion);

  mcpServers['purecontext-mcp'] = {
    command: launch.command,
    args: launch.args,
  };
  config['mcpServers'] = mcpServers;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Warn (don't fail) when the resolved global Node is below the supported floor. */
function warnIfNodeTooOld(version: string | null): void {
  const major = nodeMajor(version);
  if (major !== null && major < 18) {
    console.log(
      `  warning: resolved Node is ${version} (< 18). PureContext requires Node >= 18.\n` +
        '  Set your global/default Node to 18+ (Volta: `volta install node@22`).',
    );
  }
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

export interface InstallWriterOptions {
  /** Install Claude Code hooks (Phase 91: off by default; `--with-hooks` opts in). */
  withHooks?: boolean;
  /** Install the PreToolUse edit-reminder hook (implies noise on every edit). */
  withReminders?: boolean;
}

export const INSTALL_WRITERS: Record<
  string,
  (projectRoot: string, scope: Scope, opts?: InstallWriterOptions) => Promise<void>
> = {
  'claude': installClaude,
  'cursor': installCursor,
  'windsurf': installWindsurf,
  'continue': installContinue,
  'cline': installCline,
  'roo-code': installRooCode,
  'copilot': installCopilot,
  'claude-desktop': installClaudeDesktop,
};
