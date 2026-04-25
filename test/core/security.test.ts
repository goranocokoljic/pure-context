import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SecurityError,
  validatePath,
  checkSymlinkEscape,
  isSecretFile,
  isBinaryFile,
  checkFileSize,
  DEFAULT_MAX_FILE_BYTES,
} from '../../src/core/security.js';

// ─── validatePath ─────────────────────────────────────────────────────────────

describe('validatePath', () => {
  const root = '/project/root';

  it('returns resolved absolute path for a valid relative path', () => {
    const result = validatePath('src/index.ts', root);
    expect(result).toBe(resolve(root, 'src/index.ts'));
  });

  it('accepts a file directly in root', () => {
    expect(() => validatePath('package.json', root)).not.toThrow();
  });

  it('throws SecurityError for path traversal with ../', () => {
    expect(() => validatePath('../../etc/passwd', root)).toThrow(SecurityError);
  });

  it('throws SecurityError when resolved path equals root but tries to escape via ../sibling', () => {
    // /project/root/../other resolves to /project/other — outside root
    expect(() => validatePath('../other', root)).toThrow(SecurityError);
  });

  it('throws SecurityError for deeply nested traversal', () => {
    expect(() => validatePath('src/../../../../etc/shadow', root)).toThrow(SecurityError);
  });

  it('SecurityError code is path_traversal', () => {
    try {
      validatePath('../escape', root);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityError);
      expect((err as SecurityError).code).toBe('path_traversal');
    }
  });

  it('accepts a deeply nested valid path', () => {
    expect(() => validatePath('a/b/c/d/e.ts', root)).not.toThrow();
  });

  it('accepts an absolute path that starts with root', () => {
    const absValid = resolve(root, 'src/file.ts');
    expect(() => validatePath(absValid, root)).not.toThrow();
  });
});

// ─── checkSymlinkEscape ───────────────────────────────────────────────────────

describe('checkSymlinkEscape', () => {
  it('no-ops when the path does not exist', () => {
    expect(() =>
      checkSymlinkEscape('/nonexistent/path/file.ts', '/nonexistent/path'),
    ).not.toThrow();
  });

  it('no-ops for a regular file inside the project root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purecontext-test-'));
    try {
      const file = join(dir, 'file.ts');
      writeFileSync(file, 'content');
      expect(() => checkSymlinkEscape(file, dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // Symlink creation on Windows requires elevated privileges or Developer Mode.
  const itSymlink = process.platform === 'win32' ? it.skip : it;

  itSymlink('throws SecurityError when symlink resolves outside root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purecontext-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'purecontext-outside-'));
    try {
      // Create a file outside the project root
      const targetFile = join(outside, 'secret.txt');
      writeFileSync(targetFile, 'secret');

      // Create a symlink inside the project root pointing outside
      const link = join(dir, 'escape-link.ts');
      symlinkSync(targetFile, link);

      expect(() => checkSymlinkEscape(link, dir)).toThrow(SecurityError);
      try {
        checkSymlinkEscape(link, dir);
      } catch (err) {
        expect((err as SecurityError).code).toBe('symlink_escape');
      }
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(outside, { recursive: true });
    }
  });

  itSymlink('does not throw for a symlink that resolves inside root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purecontext-test-'));
    try {
      const target = join(dir, 'real.ts');
      writeFileSync(target, 'content');
      const link = join(dir, 'alias.ts');
      symlinkSync(target, link);
      expect(() => checkSymlinkEscape(link, dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ─── isSecretFile ─────────────────────────────────────────────────────────────

describe('isSecretFile', () => {
  it('matches .env', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('/project/.env')).toBe(true);
  });

  it('matches .env.local, .env.production', () => {
    expect(isSecretFile('.env.local')).toBe(true);
    expect(isSecretFile('.env.production')).toBe(true);
    expect(isSecretFile('.env.test')).toBe(true);
  });

  it('matches *.pem, *.key, *.p12, *.pfx, *.crt, *.cer', () => {
    for (const ext of ['pem', 'key', 'p12', 'pfx', 'crt', 'cer']) {
      expect(isSecretFile(`cert.${ext}`)).toBe(true);
    }
  });

  it('matches id_rsa, id_ed25519, id_ecdsa, id_dsa and .pub variants', () => {
    for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']) {
      expect(isSecretFile(name)).toBe(true);
      expect(isSecretFile(`${name}.pub`)).toBe(true);
    }
  });

  it('matches credentials.json, credentials.yaml, credentials.yml', () => {
    expect(isSecretFile('credentials.json')).toBe(true);
    expect(isSecretFile('credentials.yaml')).toBe(true);
    expect(isSecretFile('credentials.yml')).toBe(true);
  });

  it('matches secrets.json, secrets.yaml, secrets.yml', () => {
    expect(isSecretFile('secrets.json')).toBe(true);
    expect(isSecretFile('secrets.yaml')).toBe(true);
    expect(isSecretFile('secrets.yml')).toBe(true);
  });

  it('matches serviceAccountKey*.json', () => {
    expect(isSecretFile('serviceAccountKey.json')).toBe(true);
    expect(isSecretFile('serviceaccountkey-prod.json')).toBe(true);
  });

  it('matches *-service-account.json', () => {
    expect(isSecretFile('my-service-account.json')).toBe(true);
    expect(isSecretFile('gcp-service-account.json')).toBe(true);
  });

  it('matches *.token, *.secret', () => {
    expect(isSecretFile('github.token')).toBe(true);
    expect(isSecretFile('api.secret')).toBe(true);
  });

  it('returns false for normal source files', () => {
    expect(isSecretFile('index.ts')).toBe(false);
    expect(isSecretFile('config.ts')).toBe(false);
    expect(isSecretFile('package.json')).toBe(false);
    expect(isSecretFile('README.md')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSecretFile('ID_RSA')).toBe(true);
    expect(isSecretFile('CREDENTIALS.JSON')).toBe(true);
    expect(isSecretFile('.ENV')).toBe(true);
  });
});

// ─── isBinaryFile ─────────────────────────────────────────────────────────────

describe('isBinaryFile', () => {
  it('returns true for buffer containing a null byte', () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x00, 0x6f]); // "Hell\0o"
    expect(isBinaryFile(buf)).toBe(true);
  });

  it('returns false for plain text content', () => {
    const buf = Buffer.from('const x = 1;\nconsole.log(x);\n');
    expect(isBinaryFile(buf)).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(isBinaryFile(Buffer.alloc(0))).toBe(false);
  });

  it('returns true when null byte is at start', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    expect(isBinaryFile(buf)).toBe(true);
  });

  it('returns false for TypeScript source code', () => {
    const src = Buffer.from('export function hello(): string {\n  return "world";\n}\n');
    expect(isBinaryFile(src)).toBe(false);
  });

  it('only checks first 8192 bytes — null byte beyond that is ignored', () => {
    const buf = Buffer.alloc(9000, 0x41); // 'A' * 9000
    buf[8500] = 0x00; // null byte after the check window
    expect(isBinaryFile(buf)).toBe(false);
  });
});

// ─── checkFileSize ────────────────────────────────────────────────────────────

describe('checkFileSize', () => {
  it('does not throw for file within default limit', () => {
    expect(() => checkFileSize(1000)).not.toThrow();
    expect(() => checkFileSize(DEFAULT_MAX_FILE_BYTES)).not.toThrow();
  });

  it('throws SecurityError when size exceeds default limit', () => {
    expect(() => checkFileSize(DEFAULT_MAX_FILE_BYTES + 1)).toThrow(SecurityError);
  });

  it('SecurityError code is file_too_large', () => {
    try {
      checkFileSize(2_000_000, 1_000_000);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as SecurityError).code).toBe('file_too_large');
    }
  });

  it('respects custom maxBytes', () => {
    expect(() => checkFileSize(500, 1000)).not.toThrow();
    expect(() => checkFileSize(1001, 1000)).toThrow(SecurityError);
  });

  it('does not throw for size exactly equal to limit', () => {
    expect(() => checkFileSize(1000, 1000)).not.toThrow();
  });
});
