/**
 * Per-IDE writer functions for `purecontext-mcp install <tool>`.
 *
 * Each exported `install*` function is idempotent: calling it twice produces
 * the same result without duplicating content.  Marker comments
 * (`<!-- purecontext-mcp-start/end -->`) delimit the managed block so that
 * updates replace rather than append.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { cmdHooksInstall } from './hooks.js';
import { getClaudeDesktopConfigPath } from './install-detect.js';

// ─── Shared markers ───────────────────────────────────────────────────────────

export const START_MARKER = '<!-- purecontext-mcp-start -->';
export const END_MARKER = '<!-- purecontext-mcp-end -->';

// ─── Shared instruction content ───────────────────────────────────────────────

const MARKDOWN_CONTENT = `## PureContext MCP — Code Navigation

Always use PureContext MCP tools for code navigation. Never read entire files to find code.

### Mandatory workflow

1. **Start every session**: \`list_repos()\` → get \`repoId\` (required for all tools)
2. **Find code by name**: \`search_symbols\` → read \`summary\` and \`signature\` → only call \`get_symbol_source\` for symbols you will actually edit
3. **Find code by behaviour**: \`search_semantic\` for conceptual queries; \`search_text\` for literals/comments

### Key tools

| Goal | Tool |
|------|------|
| Find function/class by name | \`search_symbols\` |
| Find by what it does | \`search_semantic\` |
| Find literal string or comment | \`search_text\` |
| All symbols in a file | \`get_file_outline\` |
| What breaks if I change this | \`get_blast_radius\` |
| All callers of a function | \`find_references\` |
| Callers/callees tree | \`get_call_hierarchy\` |

### Anti-patterns — never do these

- Do not read whole files to find a function — use \`search_symbols\` + \`get_symbol_source\`
- Do not call \`get_symbol_source\` for every result — read \`summary\` first
- Do not skip \`list_repos\` — every tool needs a \`repoId\`
- Do not re-search after \`verdict: "no_match"\` — the symbol does not exist`;

export function getPureContextInstructions(format: 'markdown' | 'mdc' | 'json-system'): string {
  if (format === 'mdc') {
    return `---\ndescription: PureContext MCP code navigation rules\nalwaysApply: true\n---\n\n${MARKDOWN_CONTENT}`;
  }
  if (format === 'json-system') {
    return MARKDOWN_CONTENT;
  }
  return MARKDOWN_CONTENT;
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
 * Install for Claude Code — delegates to the existing hooks installer which
 * handles CLAUDE.md injection and hook registration.
 */
export async function installClaude(_projectRoot: string): Promise<void> {
  cmdHooksInstall();
}

/**
 * Write `.cursor/rules/purecontext.mdc` with MDC frontmatter.
 * Creates `.cursor/rules/` if missing.
 */
export async function installCursor(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.cursor', 'rules', 'purecontext.mdc');
  ensureDir(filePath);

  const mdcContent = getPureContextInstructions('mdc');

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing.includes(START_MARKER)) {
      // Replace just the instruction block inside the file
      writeFileSync(filePath, replaceMarkerBlock(existing, markedBlock(MARKDOWN_CONTENT)), 'utf-8');
      return;
    }
  }

  writeIdempotent(filePath, mdcContent + '\n');
}

/**
 * Append/update a marked block in `.windsurfrules`.
 * Creates the file if missing.
 */
export async function installWindsurf(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.windsurfrules');
  const block = markedBlock(getPureContextInstructions('markdown'));

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeIdempotent(filePath, block + '\n');
  }
}

/**
 * Merge a `systemMessage` field into `.continue/config.json`.
 * Creates a minimal config if the file does not exist.
 * Never overwrites other config fields.
 */
export async function installContinue(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.continue', 'config.json');
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
}

/**
 * Write `.clinerules` with a marked block.
 * Idempotent via markers.
 */
export async function installCline(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.clinerules');
  const block = markedBlock(getPureContextInstructions('markdown'));

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeIdempotent(filePath, block + '\n');
  }
}

/**
 * Write `.roo/rules-code.md` with a marked block.
 * Creates `.roo/` if missing.
 */
export async function installRooCode(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.roo', 'rules-code.md');
  const block = markedBlock(getPureContextInstructions('markdown'));
  ensureDir(filePath);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeFileSync(filePath, block + '\n', 'utf-8');
  }
}

/**
 * Write `.github/copilot-instructions.md` with a marked block.
 * Creates `.github/` if missing.
 */
export async function installVSCode(projectRoot: string): Promise<void> {
  const filePath = join(projectRoot, '.github', 'copilot-instructions.md');
  const block = markedBlock(getPureContextInstructions('markdown'));
  ensureDir(filePath);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
  } else {
    writeFileSync(filePath, block + '\n', 'utf-8');
  }
}

/**
 * Merge the PureContext MCP server entry into the Claude Desktop config JSON.
 * Reads from the platform-specific config path; skips if already present.
 */
export async function installClaudeDesktop(_projectRoot: string): Promise<void> {
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
  const existing = mcpServers['purecontext-mcp'] as Record<string, unknown> | undefined;

  if (existing?.['command'] === 'npx') {
    // Already present with same command — skip
    return;
  }

  mcpServers['purecontext-mcp'] = {
    command: 'npx',
    args: ['purecontext-mcp'],
  };
  config['mcpServers'] = mcpServers;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

export const INSTALL_WRITERS: Record<string, (projectRoot: string) => Promise<void>> = {
  'claude': installClaude,
  'cursor': installCursor,
  'windsurf': installWindsurf,
  'continue': installContinue,
  'cline': installCline,
  'roo-code': installRooCode,
  'vscode': installVSCode,
  'claude-desktop': installClaudeDesktop,
};
