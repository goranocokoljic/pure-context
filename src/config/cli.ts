import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { getConfigPath, validateConfig, DEFAULT_CONFIG } from './config-schema.js';
import { loadConfig } from './config-loader.js';
import { GRAMMARS_DIR } from '../core/parse-dispatcher.js';
import { openInMemoryDatabase } from '../core/db/schema.js';

// ─── Default config template (JSON with explanatory comments) ─────────────────

const defaultIndexDir = join(homedir(), '.purecontext', 'indexes').replace(/\\/g, '/');

const CONFIG_TEMPLATE = `{
  // Directory where SQLite index files are stored.
  // Default: ~/.purecontext/indexes/
  "indexDir": "${defaultIndexDir}",

  // Maximum number of source files to index per project.
  "fileLimit": 1000,

  // Debounce window in milliseconds for the file watcher.
  "watchDebounceMs": 2000,

  // Additional glob patterns to exclude from indexing.
  // Example: ["**/*.generated.ts", "src/vendor/**"]
  "excludePatterns": [],

  // Framework adapter activation.
  // "auto"   — detect from project config files (recommended)
  // "none"   — disable all adapters
  // ["vue"]  — explicit list
  "adapters": "auto",

  // AI summarization (Phase 2 feature — keep provider "none" for Phase 1).
  "ai": {
    "provider": "none",
    "allowRemoteAI": false
  },

  // Transport mode.
  // "stdio" — stdin/stdout (default; required for Claude Code)
  // "http"  — HTTP + Streamable HTTP (for web clients)
  // "both"  — stdio AND HTTP simultaneously
  "transport": "stdio",

  // HTTP server settings (used when transport is "http" or "both").
  "http": {
    "port": 3000,
    "host": "127.0.0.1",
    "corsOrigins": ["http://localhost:*"]
  }
}
`;

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * `purecontext-mcp config --init`
 * Write a default config.json to ~/.purecontext/config.json.
 * No-op if the file already exists.
 */
export function cmdInit(): void {
  const path = getConfigPath();

  if (existsSync(path)) {
    console.log(`Config already exists at ${path}`);
    console.log('Delete it first if you want to regenerate defaults.');
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
  console.log(`Created config at ${path}`);
}

/**
 * `purecontext-mcp config --check`
 * Validate the current config and verify prerequisites (grammars, SQLite).
 * Returns true if all checks pass.
 */
export function cmdCheck(): boolean {
  const path = getConfigPath();
  const issues: string[] = [];
  const passing: string[] = [];

  // ── Config file ──────────────────────────────────────────────────────────
  if (!existsSync(path)) {
    passing.push('No config file — defaults in use');
  } else {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const { valid, errors } = validateConfig(raw);
      if (valid) {
        passing.push(`Config file valid: ${path}`);
      } else {
        for (const e of errors) issues.push(`Config: ${e}`);
      }
    } catch (err) {
      issues.push(`Config parse error: ${err}`);
    }
  }

  // ── Grammar WASM files ────────────────────────────────────────────────────
  const grammars = [
    'tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm',
    'tree-sitter-javascript.wasm',
  ];
  for (const g of grammars) {
    const gPath = join(GRAMMARS_DIR, g);
    if (existsSync(gPath)) {
      passing.push(`Grammar present: ${g}`);
    } else {
      issues.push(`Grammar missing: ${gPath}`);
    }
  }

  // ── SQLite sanity check ───────────────────────────────────────────────────
  try {
    const db = openInMemoryDatabase();
    db.prepare('SELECT 1').get();
    db.close();
    passing.push('SQLite working');
  } catch (err) {
    issues.push(`SQLite error: ${err}`);
  }

  // ── Effective settings ────────────────────────────────────────────────────
  const cfg = loadConfig();
  passing.push(`Index directory: ${cfg.indexDir}`);
  passing.push(`File limit: ${cfg.fileLimit}`);
  passing.push(`Watch debounce: ${cfg.watchDebounceMs}ms`);

  // ── Report ────────────────────────────────────────────────────────────────
  for (const msg of passing) console.log(`  ✓  ${msg}`);
  for (const msg of issues) console.error(`  ✗  ${msg}`);

  if (issues.length === 0) {
    console.log('\nAll checks passed.');
  } else {
    console.error(`\n${issues.length} check(s) failed.`);
  }

  return issues.length === 0;
}

/**
 * `purecontext-mcp config`
 * Print the effective configuration (defaults merged with config.json) as JSON.
 */
export function cmdShow(): void {
  const cfg = loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
}
