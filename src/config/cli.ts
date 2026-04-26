import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { getConfigPath, validateConfig, DEFAULT_CONFIG } from './config-schema.js';
import { loadConfig } from './config-loader.js';
import { GRAMMARS_DIR } from '../core/parse-dispatcher.js';
import { openInMemoryDatabase } from '../core/db/schema.js';
import { VERSION } from '../version.js';

// ─── Default config template (JSON with explanatory comments) ─────────────────

const defaultIndexDir = join(homedir(), '.purecontext', 'indexes').replace(/\\/g, '/');

const CONFIG_TEMPLATE = `{
  // Directory where SQLite index files are stored.
  // Default: ~/.purecontext/indexes/
  "indexDir": "${defaultIndexDir}",

  // Maximum number of source files to index per project.
  // Set to 0 for unlimited. Raise for large monorepos (e.g. 50000).
  "fileLimit": 10000,

  // Worker threads for parallel file parsing.
  // Default: number of CPU cores, up to 8. Set to 1 to disable parallelism.
  "concurrency": 4,

  // Maximum file size in bytes to index. Files larger than this are skipped silently.
  // Default: 524288 (512 KB). Raise if you have large generated files you want indexed.
  "maxFileSizeBytes": 524288,

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
 * Prompts the user to opt in to anonymous telemetry.
 */
export async function cmdInit(): Promise<void> {
  const path = getConfigPath();

  if (existsSync(path)) {
    console.log(`Config already exists at ${path}`);
    console.log('Delete it first if you want to regenerate defaults.');
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
  console.log(`Created config at ${path}`);

  // ── Telemetry opt-in prompt ────────────────────────────────────────────────
  const telemetryEnabled = await promptTelemetryOptIn();

  // Append the telemetry section to the written config
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    existing.telemetry = { enabled: telemetryEnabled };
    writeFileSync(path, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal: if the append fails, telemetry defaults to disabled
  }

  if (telemetryEnabled) {
    console.log('Telemetry enabled. Thank you! You can disable it anytime by setting telemetry.enabled to false.');
  } else {
    console.log('Telemetry disabled. You can enable it anytime by setting telemetry.enabled to true in the config.');
  }
}

/**
 * Prompt the user to opt in to anonymous telemetry.
 * Returns true if user answered 'y', false otherwise.
 * Only shown interactively (stdin is a TTY).
 */
async function promptTelemetryOptIn(): Promise<boolean> {
  // Skip prompt when running non-interactively (e.g. in CI or piped input)
  if (!process.stdin.isTTY) return false;

  process.stdout.write(
    '\nHelp improve PureContext by sharing anonymous usage stats?\n' +
    'This sends only aggregate counts (languages used, file counts, timing).\n' +
    'No code, file names, or personal data is ever collected.\n' +
    'See docs/TELEMETRY.md for the full list of what is sent.\n\n' +
    'Enable telemetry? (y/N): ',
  );

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
    // If stdin closes without input, default to false
    rl.once('close', () => resolve(false));
  });
}

/**
 * `purecontext-mcp --health`
 * Quick self-check: Node.js version, SQLite, grammar files, config, index dir.
 * All output goes to stdout so it is easy to grep/capture.
 * Returns true if all checks passed (exit 0), false if any failed (exit 1).
 */
export function cmdHealth(write: (line: string) => void = (l) => process.stdout.write(l + '\n')): boolean {
  const failures: string[] = [];

  // ── Version header ───────────────────────────────────────────────────────
  write(`purecontext-mcp v${VERSION}`);

  // ── Node.js version ──────────────────────────────────────────────────────
  const nodeVersion = process.version.replace(/^v/, '');
  const [nodeMajor] = nodeVersion.split('.').map(Number);
  if (nodeMajor >= 18) {
    write(`✓ Node.js ${nodeVersion} (supported)`);
  } else {
    write(`✗ Node.js ${nodeVersion} (unsupported — requires >= 18.0.0)`);
    failures.push('node');
  }

  // ── SQLite / better-sqlite3 ──────────────────────────────────────────────
  try {
    const db = openInMemoryDatabase();
    db.prepare('SELECT 1').get();
    db.close();
    write('✓ better-sqlite3 loaded (prebuilt binary)');
  } catch {
    write('✗ better-sqlite3 failed to load — try: npm rebuild better-sqlite3');
    failures.push('sqlite');
  }

  // ── Grammar WASM files ────────────────────────────────────────────────────
  try {
    const wasmFiles = readdirSync(GRAMMARS_DIR).filter((f) => f.endsWith('.wasm'));
    if (wasmFiles.length > 0) {
      write(`✓ Grammars: ${wasmFiles.length} languages available`);
    } else {
      write('✗ Grammars: no grammar files found — try: npm install -g purecontext-mcp@latest');
      failures.push('grammars');
    }
  } catch {
    write('✗ Grammars: grammar directory not found — try: npm install -g purecontext-mcp@latest');
    failures.push('grammars');
  }

  // ── Config file ──────────────────────────────────────────────────────────
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    write('✓ Config: defaults in use (no config.json found)');
  } else {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      const { valid, errors } = validateConfig(raw);
      if (valid) {
        write(`✓ Config: ${configPath} (valid)`);
      } else {
        write(`✗ Config: ${configPath} (${errors.length} error(s) — run 'purecontext-mcp config --check')`);
        failures.push('config');
      }
    } catch {
      write(`✗ Config: ${configPath} (parse error — run 'purecontext-mcp config --check')`);
      failures.push('config');
    }
  }

  // ── Index directory ───────────────────────────────────────────────────────
  const cfg = loadConfig();
  const indexDir = cfg.indexDir;
  if (!existsSync(indexDir)) {
    write(`✓ Index dir: ${indexDir} (not yet created — will be on first index)`);
  } else {
    try {
      const dbFiles = readdirSync(indexDir).filter((f) => f.endsWith('.db'));
      const repoCount = dbFiles.length;
      write(`✓ Index dir: ${indexDir} (exists, ${repoCount} repo${repoCount === 1 ? '' : 's'} indexed)`);
    } catch {
      write(`✗ Index dir: ${indexDir} (read error)`);
      failures.push('index-dir');
    }
  }

  return failures.length === 0;
}

/**
 * `purecontext-mcp config --check`
 * Validate the current config and verify prerequisites (grammars, SQLite).
 * Returns true if all checks pass.
 */
export function cmdCheck(): boolean {
  // Show the quick health summary as a preamble
  const healthOk = cmdHealth();
  process.stdout.write('\n');

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

  if (issues.length === 0 && healthOk) {
    console.log('\nAll checks passed.');
  } else {
    console.error(`\n${issues.length + (healthOk ? 0 : 1)} check(s) failed.`);
  }

  return issues.length === 0 && healthOk;
}

/**
 * `purecontext-mcp config`
 * Print the effective configuration (defaults merged with config.json) as JSON.
 */
export function cmdShow(): void {
  const cfg = loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
}
