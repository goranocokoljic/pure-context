/**
 * Tests for global-Node resolution used by the install command. Everything is
 * dependency-injected (fake Volta home, platform, execPath) so no global env
 * is mutated and both Windows/Unix layouts are covered deterministically.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveServerLaunch,
  detectVoltaDefaultNode,
  nodeMajor,
} from '../../src/cli/resolve-node.js';

let voltaHome: string;

function seedVolta(home: string, version: string, platform: 'win32' | 'linux'): string {
  mkdirSync(join(home, 'tools', 'user'), { recursive: true });
  writeFileSync(
    join(home, 'tools', 'user', 'platform.json'),
    JSON.stringify({ node: { runtime: version, npm: null } }),
  );
  const verDir = join(home, 'tools', 'image', 'node', version);
  const nodeBin = platform === 'win32' ? join(verDir, 'node.exe') : join(verDir, 'bin', 'node');
  mkdirSync(join(nodeBin, '..'), { recursive: true });
  writeFileSync(nodeBin, '');
  return nodeBin;
}

beforeAll(() => {
  voltaHome = mkdtempSync(join(tmpdir(), 'pctx-volta-'));
});
afterAll(() => {
  rmSync(voltaHome, { recursive: true, force: true });
});

describe('detectVoltaDefaultNode', () => {
  it('resolves the default node binary (win32 layout: node.exe under version dir)', () => {
    const home = mkdtempSync(join(tmpdir(), 'volta-win-'));
    const bin = seedVolta(home, '22.15.0', 'win32');
    const result = detectVoltaDefaultNode(home, 'win32');
    expect(result).toEqual({ path: bin, version: '22.15.0' });
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves the default node binary (unix layout: bin/node)', () => {
    const home = mkdtempSync(join(tmpdir(), 'volta-nix-'));
    const bin = seedVolta(home, '20.9.0', 'linux');
    const result = detectVoltaDefaultNode(home, 'linux');
    expect(result).toEqual({ path: bin, version: '20.9.0' });
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when Volta is not installed', () => {
    expect(detectVoltaDefaultNode(join(voltaHome, 'does-not-exist'), 'linux')).toBeNull();
  });

  it('returns null when the binary named in platform.json is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'volta-missing-'));
    mkdirSync(join(home, 'tools', 'user'), { recursive: true });
    writeFileSync(
      join(home, 'tools', 'user', 'platform.json'),
      JSON.stringify({ node: { runtime: '99.0.0' } }),
    );
    expect(detectVoltaDefaultNode(home, 'linux')).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('resolveServerLaunch', () => {
  it('pins to Volta default node when available', () => {
    const home = mkdtempSync(join(tmpdir(), 'volta-pin-'));
    const bin = seedVolta(home, '22.15.0', process.platform === 'win32' ? 'win32' : 'linux');
    const launch = resolveServerLaunch({ voltaHomeDir: home, entryPath: '/pkg/dist/bin.js' });
    expect(launch.usedVolta).toBe(true);
    expect(launch.command).toBe(bin);
    expect(launch.args).toEqual(['/pkg/dist/bin.js']);
    expect(launch.nodeVersion).toBe('22.15.0');
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to the running Node when Volta is absent', () => {
    const launch = resolveServerLaunch({
      voltaHomeDir: join(voltaHome, 'nope'),
      entryPath: '/pkg/dist/bin.js',
      execPath: '/usr/bin/node',
      nodeVersion: 'v20.11.0',
    });
    expect(launch.usedVolta).toBe(false);
    expect(launch.command).toBe('/usr/bin/node');
    expect(launch.args).toEqual(['/pkg/dist/bin.js']);
    expect(launch.nodeVersion).toBe('v20.11.0');
  });
});

describe('nodeMajor', () => {
  it('parses major version from common formats', () => {
    expect(nodeMajor('v22.15.0')).toBe(22);
    expect(nodeMajor('18.19.1')).toBe(18);
    expect(nodeMajor(null)).toBeNull();
    expect(nodeMajor('garbage')).toBeNull();
  });
});
