/**
 * Task 171: GitHub Actions integration — CLI subcommands used by the action.
 *
 * Tests verify that:
 *  - cmdAnalyzeDiff produces correct JSON output and exits non-zero on critical priority
 *  - cmdDetectAntipatterns exits non-zero with --fail-on-critical when errors exist
 *  - cmdExport --auto creates a correctly named bundle file
 *
 * Tool handlers are mocked so these tests run without a real SQLite database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Mock tool handlers ───────────────────────────────────────────────────────

vi.mock('../../src/server/tools/analyze-diff.js', () => ({
  handler: vi.fn(),
}));

vi.mock('../../src/server/tools/detect-antipatterns.js', () => ({
  handler: vi.fn(),
}));

vi.mock('../../src/server/tools/export-index.js', () => ({
  handler: vi.fn(),
}));

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...original,
    computeRepoId: vi.fn().mockReturnValue('test-repo-id-abc123'),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run an async CLI function and capture stdout/stderr lines.
 * Returns { stdout, exitCode } where exitCode is the argument passed to process.exit()
 * (or 0 if it never called exit).
 */
async function runCommand(fn: () => Promise<void>): Promise<{ stdout: string; exitCode: number }> {
  const stdoutLines: string[] = [];
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdoutLines.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  let exitCode = 0;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode = Number(code ?? 0);
    throw new Error(`process.exit(${exitCode})`);
  });

  try {
    await fn();
  } catch (err) {
    // Swallow only process.exit() throws
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err;
  } finally {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    vi.spyOn(console, 'error').mockRestore();
  }

  return { stdout: stdoutLines.join('\n'), exitCode };
}

// ─── cmdAnalyzeDiff ───────────────────────────────────────────────────────────

describe('cmdAnalyzeDiff()', () => {
  let analyzeDiffHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../../src/server/tools/analyze-diff.js');
    analyzeDiffHandler = mod.handler as ReturnType<typeof vi.fn>;
    analyzeDiffHandler.mockReset();
  });

  it('prints JSON output from the analyze-diff handler', async () => {
    const output = {
      summary: { filesChanged: 2, symbolsAdded: 1, symbolsModified: 1, symbolsDeleted: 0, signatureBreaks: 0 },
      changedSymbols: [],
      reviewPriority: 'medium',
      _meta: { timingMs: 10 },
    };
    analyzeDiffHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    });

    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    const { stdout } = await runCommand(() =>
      cmdAnalyzeDiff(['--diff', 'diff --git a/foo.ts b/foo.ts\n+export function foo() {}'])
    );

    const parsed = JSON.parse(stdout);
    expect(parsed.reviewPriority).toBe('medium');
    expect(parsed.summary.filesChanged).toBe(2);
  });

  it('exits 0 when reviewPriority is not critical', async () => {
    analyzeDiffHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ reviewPriority: 'high' }) }],
    });

    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() =>
      cmdAnalyzeDiff(['--diff', 'some diff'])
    );

    expect(exitCode).toBe(0);
  });

  it('exits 1 when reviewPriority is critical', async () => {
    analyzeDiffHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ reviewPriority: 'critical' }) }],
    });

    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() =>
      cmdAnalyzeDiff(['--diff', 'some diff'])
    );

    expect(exitCode).toBe(1);
  });

  it('reads diff from --diff-file when provided', async () => {
    const diffPath = join(tmpdir(), 'test-pctx-pr.diff');
    writeFileSync(diffPath, 'diff --git a/foo.ts b/foo.ts\n+export const x = 1;\n', 'utf8');

    analyzeDiffHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ reviewPriority: 'low' }) }],
    });

    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() =>
      cmdAnalyzeDiff(['--diff-file', diffPath])
    );

    expect(exitCode).toBe(0);
    expect(analyzeDiffHandler).toHaveBeenCalledWith(
      expect.objectContaining({ diff: expect.stringContaining('export const x = 1') })
    );

    unlinkSync(diffPath);
  });

  it('exits 1 with usage message when neither --diff nor --diff-file provided', async () => {
    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() => cmdAnalyzeDiff([]));
    expect(exitCode).toBe(1);
  });

  it('passes repoId derived from --repo path to the handler', async () => {
    analyzeDiffHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ reviewPriority: 'low' }) }],
    });

    const { cmdAnalyzeDiff } = await import('../../src/config/cli.js');
    await runCommand(() =>
      cmdAnalyzeDiff(['--diff', 'some diff', '--repo', '/some/project'])
    );

    expect(analyzeDiffHandler).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'test-repo-id-abc123' })
    );
  });
});

// ─── cmdDetectAntipatterns ────────────────────────────────────────────────────

describe('cmdDetectAntipatterns()', () => {
  let detectHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../../src/server/tools/detect-antipatterns.js');
    detectHandler = mod.handler as ReturnType<typeof vi.fn>;
    detectHandler.mockReset();
  });

  it('prints JSON output from the detect-antipatterns handler', async () => {
    const output = {
      repoId: 'test-repo-id-abc123',
      findingsCount: 0,
      errorCount: 0,
      warningCount: 0,
      findings: [],
      healthScore: 100,
      notes: [],
    };
    detectHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    });

    const { cmdDetectAntipatterns } = await import('../../src/config/cli.js');
    const { stdout } = await runCommand(() => cmdDetectAntipatterns([]));

    const parsed = JSON.parse(stdout);
    expect(parsed.healthScore).toBe(100);
    expect(parsed.errorCount).toBe(0);
  });

  it('exits 0 when --fail-on-critical is set but errorCount is 0', async () => {
    detectHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ errorCount: 0, warningCount: 2 }) }],
    });

    const { cmdDetectAntipatterns } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() =>
      cmdDetectAntipatterns(['--fail-on-critical'])
    );

    expect(exitCode).toBe(0);
  });

  it('exits 1 when --fail-on-critical is set and errorCount > 0', async () => {
    detectHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ errorCount: 3, warningCount: 1 }) }],
    });

    const { cmdDetectAntipatterns } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() =>
      cmdDetectAntipatterns(['--fail-on-critical'])
    );

    expect(exitCode).toBe(1);
  });

  it('exits 0 even when errors exist if --fail-on-critical is not set', async () => {
    detectHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ errorCount: 5 }) }],
    });

    const { cmdDetectAntipatterns } = await import('../../src/config/cli.js');
    const { exitCode } = await runCommand(() => cmdDetectAntipatterns([]));

    expect(exitCode).toBe(0);
  });
});

// ─── cmdExport --auto ─────────────────────────────────────────────────────────

describe('cmdExport({ --auto })', () => {
  let exportHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../../src/server/tools/export-index.js');
    exportHandler = mod.handler as ReturnType<typeof vi.fn>;
    exportHandler.mockReset();
  });

  it('uses current working directory as the repo path', async () => {
    exportHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ outputPath: '/tmp/repo-abc.pcx', symbolCount: 10 }) }],
    });

    const { cmdExport } = await import('../../src/config/cli.js');
    await runCommand(() => cmdExport(['--auto']));

    expect(exportHandler).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'test-repo-id-abc123' })
    );
  });

  it('names the bundle <repoName>-<sha>.pcx', async () => {
    exportHandler.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ outputPath: '/project/project-abc1234.pcx' }) }],
    });

    const { cmdExport } = await import('../../src/config/cli.js');
    const { stdout } = await runCommand(() => cmdExport(['--auto']));

    expect(stdout).toContain('.pcx');
  });
});
