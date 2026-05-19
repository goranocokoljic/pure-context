/**
 * PureContext PostToolUse index hook.
 *
 * Re-indexes the affected repo after Edit, Write, or MultiEdit so the
 * PureContext symbol index stays in sync with in-session edits.
 *
 * Claude Code settings.json entry:
 *   "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit",
 *                     "hooks": [{ "type": "command",
 *                                 "command": "node ~/.claude/hooks/purecontext-index-hook.mjs" }] }]
 */

import { spawnSync } from 'child_process';
import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const ROOT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml'];

export function findRepoRoot(filePath) {
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

export function extractPaths(toolName, toolInput) {
  if (toolName === 'Edit' || toolName === 'Write') {
    const fp = toolInput?.file_path;
    return fp ? [fp] : [];
  }
  if (toolName === 'MultiEdit') {
    return (toolInput?.edits ?? []).map((e) => e?.file_path).filter(Boolean);
  }
  return [];
}

export function shouldIndex(toolName) {
  return toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
}

function debugLog(msg) {
  try {
    const logDir = join(homedir(), '.claude', 'hooks');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'purecontext-index-hook.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* never block */ }
}

export function reindexRepo(repoRoot) {
  spawnSync('npx', ['purecontext-mcp', 'index-folder', '--path', repoRoot], {
    stdio: 'ignore',
    timeout: 60_000,
    shell: process.platform === 'win32',
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const toolName = input.tool_name ?? '';
    const toolInput = input.tool_input ?? {};

    if (!shouldIndex(toolName)) {
      process.exit(0);
    }

    const debug = process.env.PURECONTEXT_DEBUG === '1';
    const paths = extractPaths(toolName, toolInput);
    const roots = new Set();

    for (const filePath of paths) {
      const root = findRepoRoot(filePath);
      if (root) roots.add(root);
    }

    for (const root of roots) {
      if (debug) debugLog(`Reindexing ${root} after ${toolName}`);
      reindexRepo(root);
    }
  } catch { /* never block the edit */ }

  process.exit(0);
}

if (process.argv[1] === __filename) main();
