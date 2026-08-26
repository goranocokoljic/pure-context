import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { getConfigPath, validateConfig, DEFAULT_CONFIG } from './config-schema.js';
import { loadConfig } from './config-loader.js';
import { GRAMMARS_DIR } from '../core/grammar-paths.js';
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
export async function cmdCheck(): Promise<boolean> {
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

  // ── SQLite sanity check + active tier (Phase 91) ──────────────────────────
  // Report WHICH engine actually backs this install: native better-sqlite3,
  // or the WASM fallback (a Node version without a matching prebuild lands
  // there silently at runtime — make it visible here).
  try {
    const { initSqliteBackend } = await import('../core/db/sqlite-loader.js');
    const factory = await initSqliteBackend();
    const db = factory.open(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    passing.push(
      factory.backend === 'wasm'
        ? 'SQLite working — tier: WASM (@sqlite.org/sqlite-wasm; native better-sqlite3 unavailable on this Node, slower but functional)'
        : 'SQLite working — tier: native better-sqlite3',
    );
  } catch (err) {
    issues.push(`SQLite error (both native and WASM tiers failed): ${err}`);
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

/**
 * `purecontext-mcp export --repo <path> --out <bundle.pcx>`
 * Export a repo's index to a portable .pcx bundle.
 */
export async function cmdExport(cliArgs: string[]): Promise<void> {
  const repoIdx = cliArgs.indexOf('--repo');
  const outIdx = cliArgs.indexOf('--out');
  const autoFlag = cliArgs.includes('--auto');

  if (autoFlag) {
    // --auto: export current working directory with auto-named output file
    const cwd = process.cwd();
    const { handler } = await import('../server/tools/export-index.js');
    const { computeRepoId } = await import('../core/db/schema.js');
    const repoId = computeRepoId(cwd);
    const { execSync } = await import('child_process');
    let sha = 'local';
    try {
      sha = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf8' }).trim();
    } catch {
      // Not a git repo or no commits — use 'local'
    }
    const repoName = cwd.split(/[/\\]/).pop() ?? 'repo';
    const outputPath = resolvePath(cwd, `${repoName}-${sha}.pcx`);
    const result = await handler({ repoId, outputPath });
    const text = result.content[0];
    if (text.type === 'text') console.log(text.text);
    return;
  }

  if (repoIdx < 0 || outIdx < 0) {
    console.error('Usage: purecontext-mcp export --repo <path> --out <bundle.pcx>');
    console.error('       purecontext-mcp export --auto  (exports cwd with git-sha name)');
    process.exit(1);
  }

  const repoPath = resolvePath(cliArgs[repoIdx + 1]);
  const outputPath = resolvePath(cliArgs[outIdx + 1]);

  const { handler } = await import('../server/tools/export-index.js');
  const { computeRepoId } = await import('../core/db/schema.js');
  const repoId = computeRepoId(repoPath);

  const result = await handler({ repoId, outputPath });
  const text = result.content[0];
  if (text.type === 'text') console.log(text.text);
}

/**
 * `purecontext-mcp import --bundle <bundle.pcx> [--repo <path>]`
 * Import a .pcx bundle into the local index store.
 */
export async function cmdImport(cliArgs: string[]): Promise<void> {
  const bundleIdx = cliArgs.indexOf('--bundle');
  const repoIdx = cliArgs.indexOf('--repo');

  if (bundleIdx < 0) {
    console.error('Usage: purecontext-mcp import --bundle <bundle.pcx> [--repo <override-path>]');
    process.exit(1);
  }

  const bundlePath = resolvePath(cliArgs[bundleIdx + 1]);
  const repoPath = repoIdx >= 0 ? resolvePath(cliArgs[repoIdx + 1]) : undefined;

  const { handler } = await import('../server/tools/import-index.js');
  const result = await handler({ bundlePath, repoPath });
  const text = result.content[0];
  if (text.type === 'text') console.log(text.text);
}

/**
 * `purecontext-mcp fetch <owner/repo> [--version <tag>] [--force]`
 * Download and import a pre-built index from the public registry.
 */
export async function cmdFetch(cliArgs: string[]): Promise<void> {
  const repo = cliArgs[0];

  if (!repo || repo.startsWith('--')) {
    console.error('Usage: purecontext-mcp fetch <owner/repo> [--version <tag>] [--force]');
    console.error('Example: purecontext-mcp fetch expressjs/express');
    process.exit(1);
  }

  const versionIdx = cliArgs.indexOf('--version');
  const version = versionIdx >= 0 ? cliArgs[versionIdx + 1] : undefined;
  const force = cliArgs.includes('--force');

  const { handler } = await import('../server/tools/fetch-public-index.js');
  const result = await handler({ repo, version, force });
  const text = result.content[0];
  if (text.type === 'text') console.log(text.text);
}

/**
 * `purecontext-mcp index-folder --path <dir>`
 * Index a local project folder (used by CI pipelines and the GitHub Actions action).
 */
export async function cmdIndexFolder(cliArgs: string[]): Promise<void> {
  const pathIdx = cliArgs.indexOf('--path');
  const repoPath = pathIdx >= 0 ? resolvePath(cliArgs[pathIdx + 1]) : process.cwd();

  const { handler } = await import('../server/tools/index-folder.js');
  const result = await handler({ path: repoPath });
  const text = result.content[0];
  if (text.type === 'text') console.log(text.text);
}

/**
 * `purecontext-mcp index-file --repo <dir> <file...>`
 * Targeted re-index of specific files WITHOUT a full-tree discovery pass — the
 * cheap freshness path used by the PostToolUse hook after an Edit/Write. Falls
 * back to a one-time full index_folder when the repo has not been indexed yet
 * (first-edit bootstrap), so the hook stays "just works".
 */
export async function cmdIndexFile(cliArgs: string[]): Promise<void> {
  const repoIdx = cliArgs.indexOf('--repo');
  const repoPath = repoIdx >= 0 ? resolvePath(cliArgs[repoIdx + 1]) : process.cwd();

  // Every non-flag argument (excluding the --repo value) is a file path.
  const filePaths = cliArgs.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (repoIdx >= 0 && i === repoIdx + 1) return false;
    return true;
  });

  if (filePaths.length === 0) {
    console.error('Usage: purecontext-mcp index-file --repo <dir> <file...>');
    process.exit(1);
  }

  const { computeRepoId } = await import('../core/db/schema.js');
  const repoId = computeRepoId(repoPath);

  const { handler } = await import('../server/tools/index-file.js');
  const result = await handler({ repoId, filePaths });

  if (result.isError) {
    // Repo not indexed yet — bootstrap once with a full index.
    await cmdIndexFolder(['--path', repoPath]);
    return;
  }
  const text = result.content[0];
  if (text.type === 'text') console.log(text.text);
}

/**
 * `purecontext-mcp analyze-diff --diff <patch> [--diff-file <path>] [--repo <path>]`
 * Parse a unified git diff and print an impact analysis as JSON.
 * Exits non-zero when reviewPriority is "critical".
 */
export async function cmdAnalyzeDiff(cliArgs: string[]): Promise<void> {
  const diffIdx = cliArgs.indexOf('--diff');
  const diffFileIdx = cliArgs.indexOf('--diff-file');
  const repoIdx = cliArgs.indexOf('--repo');

  if (diffIdx < 0 && diffFileIdx < 0) {
    console.error('Usage: purecontext-mcp analyze-diff --diff <patch> [--repo <path>]');
    console.error('       purecontext-mcp analyze-diff --diff-file <path> [--repo <path>]');
    process.exit(1);
  }

  let diff: string;
  if (diffFileIdx >= 0) {
    const { readFileSync } = await import('fs');
    diff = readFileSync(resolvePath(cliArgs[diffFileIdx + 1]), 'utf8');
  } else {
    diff = cliArgs[diffIdx + 1] ?? '';
  }

  const repoPath = repoIdx >= 0 ? resolvePath(cliArgs[repoIdx + 1]) : process.cwd();

  const { computeRepoId } = await import('../core/db/schema.js');
  const repoId = computeRepoId(repoPath);

  const { handler } = await import('../server/tools/analyze-diff.js');
  const result = await handler({ repoId, diff });
  const text = result.content[0];
  if (text.type === 'text') {
    console.log(text.text);
    try {
      const output = JSON.parse(text.text) as { reviewPriority?: string };
      if (output.reviewPriority === 'critical') {
        process.exit(1);
      }
    } catch {
      // Non-fatal: if parse fails, exit 0
    }
  }
}

/**
 * `purecontext-mcp detect-antipatterns [--repo <path>] [--fail-on-critical]`
 * Scan an indexed repo for structural anti-patterns and print findings as JSON.
 * With --fail-on-critical: exits non-zero if any error-severity findings exist.
 */
export async function cmdDetectAntipatterns(cliArgs: string[]): Promise<void> {
  const repoIdx = cliArgs.indexOf('--repo');
  const failOnCritical = cliArgs.includes('--fail-on-critical');

  const repoPath = repoIdx >= 0 ? resolvePath(cliArgs[repoIdx + 1]) : process.cwd();

  const { computeRepoId } = await import('../core/db/schema.js');
  const repoId = computeRepoId(repoPath);

  const { handler } = await import('../server/tools/detect-antipatterns.js');
  const result = await handler({ repoId });
  const text = result.content[0];
  if (text.type === 'text') {
    console.log(text.text);
    if (failOnCritical) {
      try {
        const output = JSON.parse(text.text) as { errorCount?: number };
        if ((output.errorCount ?? 0) > 0) {
          process.exit(1);
        }
      } catch {
        // Non-fatal: if parse fails, exit 0
      }
    }
  }
}

/**
 * `purecontext-mcp list-public`
 * List all pre-built indexes available in the public registry.
 */
export async function cmdListPublic(): Promise<void> {
  const { fetchManifest } = await import('../server/tools/fetch-public-index.js');

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    console.error(`Failed to fetch registry manifest: ${String(err)}`);
    process.exit(1);
  }

  if (manifest.repos.length === 0) {
    console.log('No pre-built indexes available yet.');
    return;
  }

  console.log(`PureContext Public Registry — ${manifest.repos.length} repos available\n`);

  for (const entry of manifest.repos) {
    const latest = entry.versions.find((v) => v.version === entry.latest);
    const sizeStr = latest
      ? ` (${(latest.bundleSize / 1_000_000).toFixed(1)} MB, ${latest.symbolCount.toLocaleString()} symbols)`
      : '';
    console.log(`  ${entry.repo}  @${entry.latest}${sizeStr}`);
  }

  console.log(`\nFetch a repo: purecontext-mcp fetch <owner/repo>`);
  console.log(`Registry updated: ${manifest.updatedAt}`);
}
