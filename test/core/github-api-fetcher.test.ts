import { describe, it, expect, vi, type Mock } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { EventEmitter } from 'node:events';
import {
  parseGitHubUrl,
  isGitHubUrl,
  GitHubApiFetcher,
  type HttpRequestFn,
} from '../../src/core/github-api-fetcher.js';

// ─── Mock HTTP helpers ────────────────────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

/**
 * Build a mock `https.request` function that returns canned responses.
 * Each call to the returned mock consumes the next response in `responses`.
 */
function buildMockRequest(responses: MockResponse[]): HttpRequestFn {
  let callIndex = 0;

  return vi.fn((
    _options: unknown,
    callback?: (res: IncomingMessage) => void,
  ) => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];

    // Build a minimal EventEmitter that looks like IncomingMessage
    const mockRes = {
      statusCode: response.statusCode,
      headers: response.headers ?? {},
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          const chunk =
            typeof response.body === 'string'
              ? Buffer.from(response.body, 'utf8')
              : response.body;
          // Emit data asynchronously so the callback chain runs naturally
          setImmediate(() => listener(chunk));
        }
        if (event === 'end') {
          setImmediate(() => setImmediate(() => listener()));
        }
        return mockRes as unknown as EventEmitter;
      },
    } as unknown as IncomingMessage;

    if (callback) setImmediate(() => callback(mockRes));

    return {
      on: (_event: string, _listener: unknown) => ({ on: () => {} }),
      end: () => {},
    } as unknown as ReturnType<HttpRequestFn>;
  }) as unknown as HttpRequestFn;
}

// ─── parseGitHubUrl ───────────────────────────────────────────────────────────

describe('parseGitHubUrl', () => {
  it('parses https URL', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses https URL with .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/expressjs/express.git')).toEqual({
      owner: 'expressjs',
      repo: 'express',
    });
  });

  it('parses https URL with trailing path (branch)', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses SSH URL', () => {
    expect(parseGitHubUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for non-GitHub URL', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for plain git clone URL (non-github.com)', () => {
    expect(parseGitHubUrl('https://bitbucket.org/owner/repo.git')).toBeNull();
  });
});

// ─── isGitHubUrl ─────────────────────────────────────────────────────────────

describe('isGitHubUrl', () => {
  it('returns true for github.com https URL', () => {
    expect(isGitHubUrl('https://github.com/expressjs/express')).toBe(true);
  });

  it('returns true for git@ SSH URL', () => {
    expect(isGitHubUrl('git@github.com:anthropics/anthropic-sdk-python.git')).toBe(true);
  });

  it('returns false for non-GitHub URLs', () => {
    expect(isGitHubUrl('https://gitlab.com/user/project')).toBe(false);
  });
});

// ─── GitHubApiFetcher ─────────────────────────────────────────────────────────

describe('GitHubApiFetcher', () => {
  describe('getDefaultBranch', () => {
    it('returns the default_branch from repo metadata', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 200, body: JSON.stringify({ default_branch: 'main' }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const branch = await fetcher.getDefaultBranch('owner', 'repo');
      expect(branch).toBe('main');
    });

    it('includes Authorization header when token is provided', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 200, body: JSON.stringify({ default_branch: 'trunk' }) },
      ]) as unknown as Mock;
      const fetcher = new GitHubApiFetcher('my-token', mockFn as unknown as HttpRequestFn);
      await fetcher.getDefaultBranch('owner', 'repo');

      const calledOptions = (mockFn as Mock).mock.calls[0][0] as { headers: Record<string, string> };
      expect(calledOptions.headers['Authorization']).toBe('Bearer my-token');
    });

    it('throws GitHubApiError on 404 (private or missing repo)', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 404, body: JSON.stringify({ message: 'Not Found' }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      await expect(fetcher.getDefaultBranch('owner', 'private-repo')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('throws GitHubApiError on 401', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      await expect(fetcher.getDefaultBranch('owner', 'repo')).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe('getCommitSha', () => {
    it('returns the object sha from the ref endpoint', async () => {
      const mockFn = buildMockRequest([
        {
          statusCode: 200,
          body: JSON.stringify({ object: { sha: 'abc123def456' } }),
        },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const sha = await fetcher.getCommitSha('owner', 'repo', 'main');
      expect(sha).toBe('abc123def456');
    });
  });

  describe('listFiles', () => {
    it('returns only blob entries from the tree API', async () => {
      const tree = [
        { path: 'src/index.ts', sha: 'aaa', size: 1000, type: 'blob', url: '' },
        { path: 'src/', sha: 'bbb', size: 0, type: 'tree', url: '' },
        { path: 'README.md', sha: 'ccc', size: 500, type: 'blob', url: '' },
      ];
      const mockFn = buildMockRequest([
        { statusCode: 200, body: JSON.stringify({ tree, truncated: false }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const files = await fetcher.listFiles('owner', 'repo', 'main');

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path)).toEqual(['src/index.ts', 'README.md']);
    });

    it('filters out files exceeding 500 KB', async () => {
      const tree = [
        { path: 'small.ts', sha: 'aaa', size: 1_000, type: 'blob', url: '' },
        { path: 'huge.ts', sha: 'bbb', size: 600_000, type: 'blob', url: '' },
      ];
      const mockFn = buildMockRequest([
        { statusCode: 200, body: JSON.stringify({ tree, truncated: false }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const files = await fetcher.listFiles('owner', 'repo', 'main');

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('small.ts');
    });

    it('incremental: unchanged blob SHA skips re-fetch', async () => {
      // This test simulates the caller's responsibility to track SHAs.
      // If the stored SHA matches the tree entry SHA, the caller should not call
      // fetchFileByBlobSha. We just verify that listFiles returns consistent SHAs.
      const tree = [
        { path: 'src/utils.ts', sha: 'sha-unchanged', size: 200, type: 'blob', url: '' },
      ];
      const mockFn = buildMockRequest([
        { statusCode: 200, body: JSON.stringify({ tree, truncated: false }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const files = await fetcher.listFiles('owner', 'repo', 'main');

      // The SHA is preserved exactly — callers compare this to the stored remote_sha
      expect(files[0].sha).toBe('sha-unchanged');
    });
  });

  describe('fetchFileByBlobSha', () => {
    it('returns raw file content as a Buffer', async () => {
      const fileContent = Buffer.from('export const x = 1;\n', 'utf8');
      const mockFn = buildMockRequest([{ statusCode: 200, body: fileContent }]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);
      const content = await fetcher.fetchFileByBlobSha('owner', 'repo', 'blob-sha');

      expect(content).toBeInstanceOf(Buffer);
      expect(content.toString('utf8')).toBe('export const x = 1;\n');
    });

    it('passes the raw accept header for binary content', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 200, body: Buffer.from('content') },
      ]) as unknown as Mock;
      const fetcher = new GitHubApiFetcher(undefined, mockFn as unknown as HttpRequestFn);
      await fetcher.fetchFileByBlobSha('owner', 'repo', 'sha');

      const calledOptions = (mockFn as Mock).mock.calls[0][0] as { headers: Record<string, string> };
      expect(calledOptions.headers['Accept']).toBe('application/vnd.github.raw');
    });
  });

  describe('rate limit retry', () => {
    it('retries on 429 and succeeds on the next attempt', async () => {
      const rateLimitResponse: MockResponse = {
        statusCode: 429,
        headers: {},
        body: JSON.stringify({ message: 'rate limit exceeded' }),
      };
      const successResponse: MockResponse = {
        statusCode: 200,
        body: JSON.stringify({ default_branch: 'main' }),
      };
      const mockFn = buildMockRequest([rateLimitResponse, successResponse]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);

      // Should retry and eventually succeed
      const branch = await fetcher.getDefaultBranch('owner', 'repo');
      expect(branch).toBe('main');
    }, 10_000);

    it('throws after MAX_RETRIES rate limit responses', async () => {
      const rateLimitResponse: MockResponse = {
        statusCode: 429,
        headers: {},
        body: JSON.stringify({ message: 'rate limit exceeded' }),
      };
      // Provide 4 rate-limit responses to exceed MAX_RETRIES=3
      const mockFn = buildMockRequest([
        rateLimitResponse,
        rateLimitResponse,
        rateLimitResponse,
        rateLimitResponse,
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);

      await expect(fetcher.getDefaultBranch('owner', 'repo')).rejects.toMatchObject({
        statusCode: 429,
      });
    }, 15_000);

    it('missing token on private repo returns 404 with clear error', async () => {
      const mockFn = buildMockRequest([
        { statusCode: 404, body: JSON.stringify({ message: 'Not Found' }) },
      ]);
      const fetcher = new GitHubApiFetcher(undefined, mockFn);

      await expect(fetcher.getDefaultBranch('owner', 'private-repo')).rejects.toMatchObject({
        statusCode: 404,
        isNotFound: true,
      });
    });
  });
});
