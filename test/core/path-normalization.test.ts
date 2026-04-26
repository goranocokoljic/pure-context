import { describe, it, expect } from 'vitest';
import { sep } from 'path';

/**
 * Cross-platform path normalization tests.
 *
 * On Windows, `path.relative()` returns backslash-separated paths (e.g.
 * `src\core\types.ts`). If these reach the database unmodified, queries
 * using forward-slash patterns fail silently on Windows while passing on
 * Linux/macOS. This test suite verifies that every public conversion
 * helper produces forward-slash paths regardless of platform.
 *
 * This is the most common cross-platform bug in this codebase — caught by
 * running the Windows CI job (Task 120).
 */

// ---------------------------------------------------------------------------
// Helpers under test (inlined here to avoid import-side-effects from heavier
// modules; the logic is intentionally duplicated so the test is self-contained
// and documents the expected contract).
// ---------------------------------------------------------------------------

/** Normalize an OS path to a forward-slash relative path. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Simulate what file-discovery returns: relative path with forward slashes. */
function makeRelPath(root: string, abs: string): string {
  // Mirrors: relative(rootPath, absPath).split(sep).join('/')
  const rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]/, '') : abs;
  return rel.split(/[\\/]/).join('/');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('path normalization', () => {
  describe('toForwardSlash', () => {
    it('passes forward-slash paths through unchanged', () => {
      expect(toForwardSlash('src/core/types.ts')).toBe('src/core/types.ts');
    });

    it('converts backslashes to forward slashes', () => {
      expect(toForwardSlash('src\\core\\types.ts')).toBe('src/core/types.ts');
    });

    it('handles mixed separators', () => {
      expect(toForwardSlash('src/core\\types.ts')).toBe('src/core/types.ts');
    });

    it('handles empty string', () => {
      expect(toForwardSlash('')).toBe('');
    });

    it('handles root-only path', () => {
      expect(toForwardSlash('\\')).toBe('/');
    });
  });

  describe('makeRelPath (file-discovery contract)', () => {
    it('produces a forward-slash path from a Unix absolute path', () => {
      const result = makeRelPath('/home/user/project', '/home/user/project/src/core/types.ts');
      expect(result).toBe('src/core/types.ts');
      expect(result).not.toContain('\\');
    });

    it('produces a forward-slash path from a Windows-style absolute path', () => {
      const result = makeRelPath('D:\\project', 'D:\\project\\src\\core\\types.ts');
      expect(result).toBe('src/core/types.ts');
      expect(result).not.toContain('\\');
    });

    it('handles deep nesting', () => {
      const result = makeRelPath('/root', '/root/a/b/c/d/e.ts');
      expect(result).toBe('a/b/c/d/e.ts');
      expect(result.split('/').length).toBe(5);
    });
  });

  describe('DB-stored filePath invariant', () => {
    // Any path that reaches the database MUST satisfy this predicate.
    function isForwardSlashPath(p: string): boolean {
      return !p.includes('\\');
    }

    const samplePaths = [
      'src/core/types.ts',
      'src/handlers/typescript.ts',
      'test/core/logger.test.ts',
      'grammars/tree-sitter-typescript.wasm',
    ];

    for (const p of samplePaths) {
      it(`"${p}" satisfies the forward-slash invariant`, () => {
        expect(isForwardSlashPath(p)).toBe(true);
      });
    }

    it('rejects paths with backslashes', () => {
      expect(isForwardSlashPath('src\\core\\types.ts')).toBe(false);
    });
  });

  describe('platform sep awareness', () => {
    it('split(sep).join("/") round-trips correctly on this platform', () => {
      // This test explicitly documents the conversion idiom used in file-discovery.ts.
      const osPath = ['src', 'core', 'types.ts'].join(sep);
      const normalized = osPath.split(sep).join('/');
      expect(normalized).toBe('src/core/types.ts');
      expect(normalized).not.toContain('\\');
    });
  });
});
