/**
 * PureContext PreCompact session snapshot hook.
 *
 * Injects a brief session snapshot as a systemMessage before Claude Code
 * compacts the conversation, so the next turn re-orients without extra reads.
 *
 * Output (stdout): JSON { "systemMessage": "..." }
 *
 * Claude Code settings.json entry:
 *   "PreCompact": [{ "matcher": "",
 *                    "hooks": [{ "type": "command",
 *                                "command": "node ~/.claude/hooks/purecontext-precompact-hook.mjs" }] }]
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

function getIndexDir() {
  const base = process.env.PCTX_DATA_DIR ?? join(homedir(), '.purecontext');
  return join(base, 'indexes');
}

function loadBetterSqlite3() {
  // 1. Try from the purecontext-mcp config written by the installer
  try {
    const configPath = join(homedir(), '.claude', 'hooks', 'purecontext-config.json');
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cfg.packageRoot) {
        const req = createRequire(join(cfg.packageRoot, 'package.json'));
        return req('better-sqlite3');
      }
    }
  } catch { /* fall through */ }

  // 2. Try from the hook file's own location (works in dev/test from project root)
  try {
    const req = createRequire(__filename);
    return req('better-sqlite3');
  } catch { /* fall through */ }

  return null;
}

export function buildSnapshot(repos) {
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

export function readRepos() {
  const indexDir = getIndexDir();
  if (!existsSync(indexDir)) return [];

  const Database = loadBetterSqlite3();
  if (!Database) return [];

  const repos = [];
  let files;
  try {
    files = readdirSync(indexDir).filter((f) => f.endsWith('.db'));
  } catch { return []; }

  for (const file of files) {
    let db;
    try {
      db = new Database(join(indexDir, file), { readonly: true });
      const rows = db.prepare('SELECT id, root_path, file_count, indexed_at FROM repos LIMIT 50').all();
      repos.push(...rows);
    } catch { /* skip unreadable db */ } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return repos;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  try {
    const repos = readRepos();
    const message = buildSnapshot(repos);
    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({
      systemMessage: 'PureContext session snapshot unavailable. Use list_repos() to check indexed repos.',
    }) + '\n');
  }

  process.exit(0);
}

if (process.argv[1] === __filename) main();
