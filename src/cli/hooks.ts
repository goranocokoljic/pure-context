/**
 * `purecontext-mcp hooks --install` / `hooks --list`
 *
 * Installs the three Claude Code hooks into ~/.claude/hooks/ and merges
 * the required entries into ~/.claude/settings.json.
 * Also injects PureContext agent instructions into ~/.claude/CLAUDE.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

// Package root is two directories up from dist/cli/ (or src/cli/ in dev)
const PACKAGE_ROOT = join(__dirname, '..', '..');
const HOOKS_SRC_DIR = join(PACKAGE_ROOT, 'scripts', 'hooks');
const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DEST_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD_PATH = join(CLAUDE_DIR, 'CLAUDE.md');
const HOOK_CONFIG_PATH = join(HOOKS_DEST_DIR, 'purecontext-config.json');

const HOOK_FILES = [
  'purecontext-index-hook.mjs',
  'purecontext-precompact-hook.mjs',
  'purecontext-edit-guard.mjs',
] as const;

// ─── Settings entries ─────────────────────────────────────────────────────────

const POST_TOOL_USE_ENTRY = {
  matcher: 'Edit|Write|MultiEdit',
  hooks: [{ type: 'command', command: `node ${join(HOOKS_DEST_DIR, 'purecontext-index-hook.mjs')}` }],
};

const PRE_COMPACT_ENTRY = {
  matcher: '',
  hooks: [{ type: 'command', command: `node ${join(HOOKS_DEST_DIR, 'purecontext-precompact-hook.mjs')}` }],
};

const PRE_TOOL_USE_ENTRY = {
  matcher: 'Edit|Write|MultiEdit',
  hooks: [{ type: 'command', command: `node ${join(HOOKS_DEST_DIR, 'purecontext-edit-guard.mjs')}` }],
};

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

// ─── Public commands ──────────────────────────────────────────────────────────

export function cmdHooksInstall(): void {
  mkdirSync(HOOKS_DEST_DIR, { recursive: true });

  // Copy hook scripts
  for (const file of HOOK_FILES) {
    const src = join(HOOKS_SRC_DIR, file);
    const dest = join(HOOKS_DEST_DIR, file);
    if (!existsSync(src)) {
      process.stderr.write(`Warning: hook script not found: ${src}\n`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`  Installed: ${dest}`);
  }

  // Write config for precompact hook (allows it to find better-sqlite3)
  writeFileSync(HOOK_CONFIG_PATH, JSON.stringify({
    packageRoot: PACKAGE_ROOT,
  }, null, 2));

  // Merge settings.json
  mergeSettings();

  // Inject CLAUDE.md block
  injectClaudeMd();

  console.log('\nHooks installed. Reopen Claude Code to activate them.\n');
  console.log('Hooks installed:');
  console.log('  PostToolUse (index): re-indexes edited files automatically');
  console.log('  PreCompact (snapshot): injects repo state before context compaction');
  console.log('  PreToolUse (guard): suggests PureContext read tools before editing');
}

export function cmdHooksList(): void {
  console.log('\nPureContext Claude Code hooks:\n');
  for (const file of HOOK_FILES) {
    const dest = join(HOOKS_DEST_DIR, file);
    const status = existsSync(dest) ? 'installed' : 'not installed';
    console.log(`  ${file}: ${status}`);
  }

  const settingsStatus = areSettingsMerged() ? 'merged' : 'not configured';
  console.log(`\n  settings.json: ${settingsStatus}`);
  console.log(`  CLAUDE.md block: ${isClaudeMdInjected() ? 'present' : 'not present'}\n`);
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
    POST_TOOL_USE_ENTRY,
    'purecontext-index-hook.mjs',
  );
  hooks.PreCompact = mergeHookEntry(
    hooks.PreCompact ?? [],
    PRE_COMPACT_ENTRY,
    'purecontext-precompact-hook.mjs',
  );
  hooks.PreToolUse = mergeHookEntry(
    hooks.PreToolUse ?? [],
    PRE_TOOL_USE_ENTRY,
    'purecontext-edit-guard.mjs',
  );

  settings.hooks = hooks;
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  Updated: ${SETTINGS_PATH}`);
}

function mergeHookEntry(
  existing: unknown[],
  entry: Record<string, unknown>,
  hookFileName: string,
): unknown[] {
  // Remove any existing purecontext entry for this hook (idempotent)
  const filtered = existing.filter((e) => {
    const hooks = (e as Record<string, unknown[]>).hooks ?? [];
    return !hooks.some((h) => {
      const cmd = (h as Record<string, string>).command ?? '';
      return cmd.includes(hookFileName);
    });
  });
  return [...filtered, entry];
}

function areSettingsMerged(): boolean {
  if (!existsSync(SETTINGS_PATH)) return false;
  try {
    const text = readFileSync(SETTINGS_PATH, 'utf-8');
    return text.includes('purecontext-index-hook.mjs');
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
    // Replace the existing block (idempotent update)
    content = content.slice(0, startIdx) + CLAUDE_MD_BLOCK + content.slice(endIdx + END_MARKER.length);
  } else {
    // Append at end
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
