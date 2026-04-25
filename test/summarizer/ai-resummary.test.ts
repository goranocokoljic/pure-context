/**
 * AI re-summarization on incremental re-index.
 *
 * Tests that reindexFiles() calls the AI summarizer only for changed symbols
 * that still have signature-fallback summaries, and not for unchanged files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import type { AISummarizer } from '../../src/summarizer/ai-summarizer.js';
import type { SymbolRecord } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
}, 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(): string {
  const dir = join(tmpdir(), `purecontext-ai-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), 'export function greet(name: string): string { return `Hello ${name}`; }\n');
  return dir;
}

function makeMockSummarizer(): { summarizer: AISummarizer; calls: SymbolRecord[][] } {
  const calls: SymbolRecord[][] = [];
  const summarizer: AISummarizer = {
    async summarizeBatch(symbols: SymbolRecord[]): Promise<Map<string, string>> {
      calls.push([...symbols]);
      const map = new Map<string, string>();
      for (const s of symbols) map.set(s.id, `AI summary for ${s.name}`);
      return map;
    },
  };
  return { summarizer, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reindexFiles — AI re-summarization', () => {
  let dir: string;
  let repoId: string;

  beforeAll(async () => {
    dir = makeTempProject();
    const result = await indexFolder(dir, { fileLimit: 10 });
    repoId = result.repoId;
  });

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(dir, { recursive: true });
  });

  it('calls AI summarizer for changed files with signature-fallback symbols', async () => {
    // Modify the file so it needs re-indexing
    writeFileSync(join(dir, 'index.ts'), 'export function greet(name: string): string { return `Hi ${name}`; }\n');

    const { summarizer, calls } = makeMockSummarizer();
    await reindexFiles(repoId, ['index.ts'], [], { aiSummarizer: summarizer });

    // AI should have been called for the changed file's symbols
    expect(calls.length).toBeGreaterThan(0);
    const summarizedNames = calls.flat().map((s) => s.name);
    expect(summarizedNames).toContain('greet');
  });

  it('does not call AI summarizer when no files changed', async () => {
    const { summarizer, calls } = makeMockSummarizer();
    await reindexFiles(repoId, [], [], { aiSummarizer: summarizer });

    expect(calls.length).toBe(0);
  });

  it('skips AI for symbols that already have a non-signature summary', async () => {
    // Index fresh with a file that has a docstring — those symbols get summaries in Stage 1/2
    const dir2 = join(tmpdir(), `purecontext-ai-test2-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir2, 'util.ts'),
      '/** Validates the user input. */\nexport function validate(x: string): boolean { return x.length > 0; }\n',
    );

    const result2 = await indexFolder(dir2, { fileLimit: 10 });
    const repoId2 = result2.repoId;

    // Modify the file
    writeFileSync(
      join(dir2, 'util.ts'),
      '/** Validates the user input. */\nexport function validate(x: string): boolean { return x.length > 1; }\n',
    );

    const { summarizer, calls } = makeMockSummarizer();
    await reindexFiles(repoId2, ['util.ts'], [], { aiSummarizer: summarizer });

    // The symbol has a docstring summary so it shouldn't be in the AI batch
    const summarizedNames = calls.flat().map((s) => s.name);
    expect(summarizedNames).not.toContain('validate');

    deleteIndex(repoId2);
    rmSync(dir2, { recursive: true });
  });
});

// ─── API key env var resolution ───────────────────────────────────────────────

describe('resolveEnvVar', () => {
  it('resolves ${ENV_VAR} notation from process.env', async () => {
    const { resolveEnvVar } = await import('../../src/config/config-loader.js');
    process.env['TEST_AI_KEY_XYZ'] = 'my-secret-key';
    try {
      expect(resolveEnvVar('${TEST_AI_KEY_XYZ}')).toBe('my-secret-key');
    } finally {
      delete process.env['TEST_AI_KEY_XYZ'];
    }
  });

  it('returns the literal value if not in ${} notation', async () => {
    const { resolveEnvVar } = await import('../../src/config/config-loader.js');
    expect(resolveEnvVar('sk-literal-key')).toBe('sk-literal-key');
  });

  it('returns empty string when referenced env var is not set', async () => {
    const { resolveEnvVar } = await import('../../src/config/config-loader.js');
    delete process.env['MISSING_VAR_XYZ'];
    expect(resolveEnvVar('${MISSING_VAR_XYZ}')).toBe('');
  });
});
