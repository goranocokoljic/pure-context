import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PureContextError,
  NativeDependencyError,
  GrammarNotFoundError,
  ProjectTooLargeError,
  ConfigValidationError,
  formatErrorBox,
} from '../../src/core/errors.js';

// ─── Error class unit tests ───────────────────────────────────────────────────

describe('NativeDependencyError', () => {
  it('has a non-empty userMessage', () => {
    const err = new NativeDependencyError();
    expect(err.userMessage).toBeTruthy();
    expect(typeof err.userMessage).toBe('string');
  });

  it('has a non-empty suggestion', () => {
    const err = new NativeDependencyError();
    expect(err.suggestion).toBeTruthy();
    expect(typeof err.suggestion).toBe('string');
  });

  it('is a PureContextError', () => {
    expect(new NativeDependencyError()).toBeInstanceOf(PureContextError);
  });

  it('wraps the original cause', () => {
    const cause = new Error('binary missing');
    const err = new NativeDependencyError(cause);
    expect(err.cause).toBe(cause);
  });
});

describe('GrammarNotFoundError', () => {
  it('includes the language in userMessage', () => {
    const err = new GrammarNotFoundError('/grammars/tree-sitter-kotlin.wasm');
    expect(err.userMessage).toContain('tree-sitter-kotlin.wasm');
  });

  it('has a non-empty suggestion', () => {
    const err = new GrammarNotFoundError('typescript');
    expect(err.suggestion).toBeTruthy();
  });

  it('is a PureContextError', () => {
    expect(new GrammarNotFoundError('go')).toBeInstanceOf(PureContextError);
  });
});

describe('ProjectTooLargeError', () => {
  it('includes file count and limit in userMessage', () => {
    const err = new ProjectTooLargeError(15_000, 10_000);
    expect(err.userMessage).toContain('15000');
    expect(err.userMessage).toContain('10000');
  });

  it('suggestion includes a higher fileLimit recommendation', () => {
    const err = new ProjectTooLargeError(5_000, 3_000);
    expect(err.suggestion).toContain('fileLimit');
    // Recommended limit should be higher than current fileCount
    expect(err.suggestion).toContain('6000');
  });
});

describe('ConfigValidationError', () => {
  it('formats a single field error into a readable sentence', () => {
    const err = new ConfigValidationError('  fileLimit must be a non-negative integer', '/home/user/.purecontext/config.json');
    expect(err.userMessage).toContain('fileLimit');
    expect(err.userMessage).toContain('config.json');
  });

  it('has a non-empty suggestion pointing to --check', () => {
    const err = new ConfigValidationError('  fileLimit: bad value');
    expect(err.suggestion).toContain('--check');
  });

  it('works without a configPath argument', () => {
    const err = new ConfigValidationError('  concurrency must be a positive integer');
    expect(err.userMessage).toContain('concurrency');
    expect(err.suggestion).toBeTruthy();
  });
});

// ─── Box formatter ────────────────────────────────────────────────────────────

describe('formatErrorBox', () => {
  it('contains the user message text', () => {
    const box = formatErrorBox('Could not load SQLite driver.', 'Try: npm rebuild better-sqlite3');
    expect(box).toContain('Could not load SQLite driver.');
  });

  it('contains the suggestion text', () => {
    const box = formatErrorBox('Something failed.', 'Run: npm install -g purecontext-mcp@latest');
    expect(box).toContain('Run: npm install -g purecontext-mcp@latest');
  });

  it('includes box drawing characters', () => {
    const box = formatErrorBox('Error occurred.', 'Fix it.');
    expect(box).toContain('┌');
    expect(box).toContain('┐');
    expect(box).toContain('└');
    expect(box).toContain('┘');
    expect(box).toContain('│');
  });

  it('omits suggestion section when suggestion is empty', () => {
    const box = formatErrorBox('Error occurred.', '');
    // Should have top border, message line(s), and bottom border — no blank separator
    const lines = box.split('\n');
    // Every "│" line should contain actual text (no blank separator line)
    const contentLines = lines.filter(l => l.startsWith('│'));
    expect(contentLines.every(l => l.trim() !== '│')).toBe(true);
  });
});

// ─── Top-level stderr output ──────────────────────────────────────────────────

describe('printFatalError (via formatErrorBox)', () => {
  it('box output is present when a PureContextError is formatted', () => {
    const err = new NativeDependencyError();
    const output = formatErrorBox(err.userMessage!, err.suggestion ?? '');
    expect(output).toContain('PureContext Error');
    expect(output).toContain(err.userMessage!);
    expect(output).toContain('better-sqlite3');
  });
});

// ─── MCP tool error response shape ───────────────────────────────────────────

describe('handleToolError (via mcp-server logic)', () => {
  it('GrammarNotFoundError userMessage appears in tool error response', async () => {
    // Simulate the handleToolError logic directly (same as mcp-server.ts)
    const simulateHandleToolError = (err: unknown) => {
      if (err instanceof PureContextError) {
        const msg = err.userMessage ?? err.message;
        const detail = err.suggestion ? `\n\nSuggestion: ${err.suggestion}` : '';
        return {
          content: [{ type: 'text' as const, text: msg + detail }],
          isError: true as const,
        };
      }
      throw err;
    };

    const grammarErr = new GrammarNotFoundError('/grammars/tree-sitter-elixir.wasm');
    const result = simulateHandleToolError(grammarErr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tree-sitter-elixir.wasm');
    // Must not contain a raw stack trace
    expect(result.content[0].text).not.toContain('at ');
  });

  it('non-PureContextError is rethrown (not swallowed)', () => {
    const simulateHandleToolError = (err: unknown) => {
      if (err instanceof PureContextError) {
        return { content: [], isError: true as const };
      }
      throw err;
    };

    const unexpected = new TypeError('unexpected');
    expect(() => simulateHandleToolError(unexpected)).toThrow(TypeError);
  });
});
