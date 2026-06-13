/**
 * Resolve how to launch the MCP server under a *globally available* Node,
 * independent of any project's per-directory Node pin.
 *
 * Why: an MCP server is a long-lived global tool, not project code. If its
 * launch command resolves Node by the current directory (as `npx`/a Volta
 * shim does), it inherits whatever Node a project pins — which may be the
 * wrong version. We instead pin the server to the user's *default* Node:
 *   - Volta present → Volta's default `node` (from tools/user/platform.json),
 *     resolved to an absolute binary path so Volta's per-dir logic is bypassed.
 *   - otherwise     → the Node currently running `install` (the global one;
 *     without Volta there is no per-directory switching).
 *
 * The absolute node path is machine-specific, so the result is only suitable
 * for USER-scope configs (Claude Desktop, `claude mcp add --scope user`) —
 * never a project-committed `.mcp.json`, which must stay portable.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export interface ServerLaunch {
  /** Executable to spawn (absolute Node path, or 'npx' as a last resort). */
  command: string;
  /** Arguments — typically the absolute path to this package's launcher. */
  args: string[];
  /** True when the command was resolved from Volta's default toolchain. */
  usedVolta: boolean;
  /** The resolved Node version string, when known. */
  nodeVersion: string | null;
}

export interface ResolveOptions {
  /** Override the server entry path (defaults to this package's dist/bin.js). */
  entryPath?: string;
  /** Override Volta home (defaults to VOLTA_HOME or the platform default). */
  voltaHomeDir?: string;
  /** Override the running Node path (defaults to process.execPath). */
  execPath?: string;
  /** Override the running Node version (defaults to process.version). */
  nodeVersion?: string;
  /** Override the platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

/** Volta's home directory: $VOLTA_HOME, else the per-platform default. */
export function defaultVoltaHome(platform: NodeJS.Platform = process.platform): string {
  if (process.env['VOLTA_HOME']) return process.env['VOLTA_HOME'];
  if (platform === 'win32' && process.env['LOCALAPPDATA']) {
    return join(process.env['LOCALAPPDATA'], 'Volta');
  }
  return join(homedir(), '.volta');
}

/**
 * Resolve Volta's *default* Node (not a project pin) to an absolute binary
 * path. Returns null when Volta isn't installed or the binary is missing.
 */
export function detectVoltaDefaultNode(
  voltaHomeDir: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; version: string } | null {
  const platformJson = join(voltaHomeDir, 'tools', 'user', 'platform.json');
  if (!existsSync(platformJson)) return null;
  try {
    const parsed = JSON.parse(readFileSync(platformJson, 'utf8')) as {
      node?: { runtime?: string };
    };
    const version = parsed.node?.runtime;
    if (!version) return null;
    const nodePath =
      platform === 'win32'
        ? join(voltaHomeDir, 'tools', 'image', 'node', version, 'node.exe')
        : join(voltaHomeDir, 'tools', 'image', 'node', version, 'bin', 'node');
    if (existsSync(nodePath)) return { path: nodePath, version };
  } catch {
    // Malformed platform.json — fall through.
  }
  return null;
}

/** Absolute path to this package's launcher (dist/bin.js). */
function defaultEntryPath(): string {
  // This module compiles to dist/cli/resolve-node.js; the launcher is dist/bin.js.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'bin.js');
}

export function resolveServerLaunch(opts: ResolveOptions = {}): ServerLaunch {
  const platform = opts.platform ?? process.platform;
  const entry = opts.entryPath ?? defaultEntryPath();
  const voltaHomeDir = opts.voltaHomeDir ?? defaultVoltaHome(platform);

  const volta = detectVoltaDefaultNode(voltaHomeDir, platform);
  if (volta) {
    return { command: volta.path, args: [entry], usedVolta: true, nodeVersion: volta.version };
  }

  // No Volta: the Node running `install` is the global one.
  return {
    command: opts.execPath ?? process.execPath,
    args: [entry],
    usedVolta: false,
    nodeVersion: opts.nodeVersion ?? process.version,
  };
}

/** Major version number from a "vX.Y.Z" / "X.Y.Z" string, or null. */
export function nodeMajor(version: string | null): number | null {
  if (!version) return null;
  const m = /v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}
