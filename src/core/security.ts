import { resolve, sep, basename } from 'path';
import { realpathSync, openSync, readSync, closeSync } from 'fs';
import { PureContextError } from './errors.js';

// ─── SecurityError ────────────────────────────────────────────────────────────

export class SecurityError extends PureContextError {
  constructor(
    public readonly code: 'path_traversal' | 'symlink_escape' | 'file_too_large',
    message: string,
  ) {
    super(message);
  }
}

// ─── Path validation ──────────────────────────────────────────────────────────

/**
 * Resolve `filePath` relative to `projectRoot` and verify it stays within the
 * project root.  Throws `SecurityError('path_traversal')` on escape attempts.
 * Returns the absolute resolved path.
 */
export function validatePath(filePath: string, projectRoot: string): string {
  const resolvedRoot = resolve(projectRoot);
  const resolvedFile = resolve(projectRoot, filePath);
  if (
    resolvedFile !== resolvedRoot &&
    !resolvedFile.startsWith(resolvedRoot + sep)
  ) {
    throw new SecurityError(
      'path_traversal',
      `Path traversal detected: "${filePath}"`,
    );
  }
  return resolvedFile;
}

// ─── Symlink check ────────────────────────────────────────────────────────────

/**
 * Verify that `resolvedPath` does not escape `projectRoot` after all symlinks
 * are resolved.  Throws `SecurityError('symlink_escape')` if it does.
 * No-ops when the path does not exist (not yet created files are not a threat).
 */
export function checkSymlinkEscape(resolvedPath: string, projectRoot: string): void {
  // Resolve symlinks in the root itself (e.g. macOS /tmp → /private/tmp)
  let realRoot: string;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    realRoot = resolve(projectRoot);
  }

  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    return; // File doesn't exist — nothing to check
  }

  if (
    realPath !== realRoot &&
    !realPath.startsWith(realRoot + sep)
  ) {
    throw new SecurityError(
      'symlink_escape',
      `Symlink resolves outside project root: "${resolvedPath}"`,
    );
  }
}

// ─── Secret-file detection ────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\./i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /^id_rsa(\.pub)?$/i,
  /^id_ed25519(\.pub)?$/i,
  /^id_ecdsa(\.pub)?$/i,
  /^id_dsa(\.pub)?$/i,
  /^credentials\.(json|yaml|yml)$/i,
  /^secrets\.(json|yaml|yml)$/i,
  /^serviceaccountkey.*\.json$/i,
  /.*-service-account\.json$/i,
  /\.token$/i,
  /\.secret$/i,
];

/**
 * Returns `true` when the file name matches a known credential/secret pattern
 * and should be excluded from indexing.  Case-insensitive.
 */
export function isSecretFile(filePath: string): boolean {
  const name = basename(filePath);
  return SECRET_PATTERNS.some((re) => re.test(name));
}

// ─── Binary detection ─────────────────────────────────────────────────────────

const BINARY_PEEK_BYTES = 8192;

/**
 * Returns `true` when the content buffer contains a null byte, which is a
 * reliable indicator of binary (non-text) content.  Only the first 8192 bytes
 * are examined.
 */
export function isBinaryFile(content: Buffer): boolean {
  const len = Math.min(content.length, BINARY_PEEK_BYTES);
  for (let i = 0; i < len; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

/**
 * Read up to `BINARY_PEEK_BYTES` from the beginning of a file for binary
 * detection without loading the whole file into memory.
 * Returns an empty buffer on read failure.
 */
export function peekFileContent(absPath: string): Buffer {
  const buf = Buffer.allocUnsafe(BINARY_PEEK_BYTES);
  let fd = -1;
  try {
    fd = openSync(absPath, 'r');
    const bytesRead = readSync(fd, buf, 0, BINARY_PEEK_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ─── File-size check ──────────────────────────────────────────────────────────

export const DEFAULT_MAX_FILE_BYTES = 1_048_576; // 1 MB

/**
 * Throws `SecurityError('file_too_large')` when `size` exceeds `maxBytes`.
 */
export function checkFileSize(
  size: number,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): void {
  if (size > maxBytes) {
    throw new SecurityError(
      'file_too_large',
      `File size ${size} bytes exceeds limit of ${maxBytes} bytes`,
    );
  }
}
