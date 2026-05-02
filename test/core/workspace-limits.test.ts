/**
 * Task 128 — Workspace plan limit enforcement tests.
 */
import { describe, it, expect } from 'vitest';
import { WorkspaceLimitError } from '../../src/core/errors.js';

// ─── Mock indexFolder to test plan limits without real file I/O ───────────────

async function simulateIndex(options: {
  workspacePlan?: 'free' | 'team' | 'enterprise';
  workspaceRepoCount?: number;
  totalFilesFound?: number;
}): Promise<void> {
  const FREE_REPO_LIMIT = 3;
  const FREE_FILE_LIMIT = 10_000;

  // Workspace plan limit checks (mirroring index-manager.ts logic)
  if (options.workspacePlan === 'free') {
    if (options.workspaceRepoCount !== undefined && options.workspaceRepoCount >= FREE_REPO_LIMIT) {
      throw new WorkspaceLimitError('repos', FREE_REPO_LIMIT, options.workspaceRepoCount);
    }
    if (options.totalFilesFound !== undefined && options.totalFilesFound > FREE_FILE_LIMIT) {
      throw new WorkspaceLimitError('files', FREE_FILE_LIMIT, options.totalFilesFound);
    }
  }
}

describe('Workspace plan limits', () => {
  describe('free plan — repo count limit', () => {
    it('allows indexing when repo count is below limit', async () => {
      await expect(simulateIndex({
        workspacePlan: 'free',
        workspaceRepoCount: 2,
      })).resolves.toBeUndefined();
    });

    it('throws WorkspaceLimitError when repo count reaches limit', async () => {
      await expect(simulateIndex({
        workspacePlan: 'free',
        workspaceRepoCount: 3,
      })).rejects.toThrow(WorkspaceLimitError);
    });

    it('error message mentions upgrade path', async () => {
      try {
        await simulateIndex({ workspacePlan: 'free', workspaceRepoCount: 4 });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceLimitError);
        const limitErr = err as WorkspaceLimitError;
        expect(limitErr.userMessage).toContain('Free plan');
        expect(limitErr.userMessage).toContain('3 repos');
      }
    });
  });

  describe('free plan — file count limit', () => {
    it('allows indexing when file count is within limit', async () => {
      await expect(simulateIndex({
        workspacePlan: 'free',
        workspaceRepoCount: 0,
        totalFilesFound: 10_000,
      })).resolves.toBeUndefined();
    });

    it('throws WorkspaceLimitError when file count exceeds limit', async () => {
      await expect(simulateIndex({
        workspacePlan: 'free',
        workspaceRepoCount: 0,
        totalFilesFound: 10_001,
      })).rejects.toThrow(WorkspaceLimitError);
    });

    it('throws with limitType=files for file limit errors', async () => {
      try {
        await simulateIndex({ workspacePlan: 'free', totalFilesFound: 15_000 });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceLimitError);
        expect((err as WorkspaceLimitError).limitType).toBe('files');
      }
    });
  });

  describe('team plan — no limits', () => {
    it('allows indexing with many repos', async () => {
      for (let i = 0; i < 10; i++) {
        await expect(simulateIndex({
          workspacePlan: 'team',
          workspaceRepoCount: i,
          totalFilesFound: 50_000,
        })).resolves.toBeUndefined();
      }
    });
  });

  describe('enterprise plan — no limits', () => {
    it('allows large repos', async () => {
      await expect(simulateIndex({
        workspacePlan: 'enterprise',
        workspaceRepoCount: 100,
        totalFilesFound: 100_000,
      })).resolves.toBeUndefined();
    });
  });

  describe('no plan specified — no limits', () => {
    it('defaults to unlimited (local mode)', async () => {
      await expect(simulateIndex({
        workspaceRepoCount: 100,
        totalFilesFound: 100_000,
      })).resolves.toBeUndefined();
    });
  });
});

describe('WorkspaceLimitError', () => {
  it('repos limit error has correct limitType and limit', () => {
    const err = new WorkspaceLimitError('repos', 3, 4);
    expect(err.limitType).toBe('repos');
    expect(err.limit).toBe(3);
    expect(err.current).toBe(4);
    expect(err).toBeInstanceOf(WorkspaceLimitError);
    expect(err.userMessage).toContain('purecontext.dev/pricing');
  });

  it('files limit error has correct limitType', () => {
    const err = new WorkspaceLimitError('files', 10_000, 15_000);
    expect(err.limitType).toBe('files');
    expect(err.limit).toBe(10_000);
    expect(err.current).toBe(15_000);
  });
});
