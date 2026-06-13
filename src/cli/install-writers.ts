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

export type Scope = 'local' | 'global' | 'both';

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

### Pick the right tool

| I need to… | Use |
|------------|-----|
| Find a function/class/method by name | \`search_symbols\` |
| Find code by what it does (meaning) | \`search_semantic\` |
| Find a literal string, comment, or config value | \`search_text\` |
| Read a symbol's implementation | \`get_symbol_source\` |
| Read a non-symbol file region (imports, config) | \`get_file_content\` |
| Survey one file / the whole project | \`get_file_outline\` / \`get_repo_outline\` |
| Know what breaks if I change a symbol | \`get_blast_radius\` |
| Find every call site of a symbol | \`find_references\` |
| See the callers/callees tree | \`get_call_hierarchy\` |
| Judge how risky a symbol is to change | \`get_symbol_risk\` |
| Find files that change together with this one | \`get_co_change\` |
| Pre-flight a rename / delete / move | \`check_rename_safe\` / \`check_delete_safe\` / \`check_move_safe\` |
| Find exported symbols with no tests | \`find_untested_symbols\` |
| Codebase health score / debt report | \`health_radar\` / \`get_debt_report\` |

### Before editing risky code

Before broad or automated edits to an unfamiliar symbol, check \`get_symbol_risk\` (composite churn + centrality + complexity + test-gap + co-change, banded \`low\`/\`review\`/\`high\`). For a \`high\` symbol, inspect its callers (\`get_blast_radius\`) and its historical co-changers (\`get_co_change\`) first — co-changing files are the second-order edits the import graph can't show you. \`search_symbols\` and \`get_symbol_source\` accept \`includeRisk: true\` to attach a compact \`{ band, riskScore }\` inline.

### Anti-patterns — never do these

- Do not read whole files to find a function — use \`search_symbols\` + \`get_symbol_source\`
- Do not call \`get_symbol_source\` for every result — read \`summary\` first
- Do not skip \`list_repos\` — every tool needs a \`repoId\`
- Do not use \`search_text\` for symbol lookups — it greps raw text; use \`search_symbols\`
- Do not re-search after \`verdict: "no_match"\` — the symbol does not exist

Full tool reference (every parameter), navigation patterns, and known limitations: **\`AGENT_REFERENCE.md\`**.`;

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
 * Install for Claude Code.
 * local  → writes instruction block to <project>/CLAUDE.md
 * global → writes hooks + ~/.claude/CLAUDE.md (existing behaviour)
 * both   → both of the above
 */
export async function installClaude(projectRoot: string, scope: Scope): Promise<void> {
  if (scope === 'local' || scope === 'both') {
    const filePath = join(projectRoot, 'CLAUDE.md');
    const block = markedBlock(getPureContextInstructions('markdown'));
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      writeFileSync(filePath, replaceMarkerBlock(existing, block), 'utf-8');
    } else {
      writeIdempotent(filePath, block + '\n');
    }
  }
  if (scope === 'global' || scope === 'both') {
    cmdHooksInstall();
  }
}

/**
 * Write `purecontext.mdc` with MDC frontmatter.
 * local  → <project>/.cursor/rules/
 * global → ~/.cursor/rules/
 */
export async function installCursor(projectRoot: string, scope: Scope): Promise<void> {
  const writeMdc = (filePath: string) => {
    ensureDir(filePath);
    const mdcContent = getPureContextInstructions('mdc');
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing.includes(START_MARKER)) {
        writeFileSync(filePath, replaceMarkerBlock(existing, markedBlock(MARKDOWN_CONTENT)), 'utf-8');
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

export const INSTALL_WRITERS: Record<string, (projectRoot: string, scope: Scope) => Promise<void>> = {
  'claude': installClaude,
  'cursor': installCursor,
  'windsurf': installWindsurf,
  'continue': installContinue,
  'cline': installCline,
  'roo-code': installRooCode,
  'copilot': installCopilot,
  'claude-desktop': installClaudeDesktop,
};
