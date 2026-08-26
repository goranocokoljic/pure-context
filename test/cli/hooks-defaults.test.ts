/**
 * Phase 91 (Task 564) — installer diet: PreToolUse edit reminder is opt-in.
 *
 * mergeSettings writes to ~/.claude/settings.json; homedir is mocked to a
 * temp dir so these tests exercise the real merge logic end to end.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const tmpHome = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.tmpdir(), `pc-hooks-defaults-${Math.random().toString(36).slice(2)}`);
});

vi.mock('os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('os')>();
  return { ...orig, homedir: () => tmpHome };
});

import { mergeSettings } from '../../src/cli/hooks.js';

const SETTINGS = join(tmpHome, '.claude', 'settings.json');

function readSettings(): string {
  return existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf-8') : '';
}

beforeEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  mkdirSync(join(tmpHome, '.claude'), { recursive: true });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('mergeSettings defaults (Phase 91)', () => {
  it('default install writes the verified hook set WITHOUT the edit reminder', () => {
    mergeSettings();
    const text = readSettings();
    for (const h of [
      'hook-posttooluse',
      'hook-precompact',
      'hook-worktree-create',
      'hook-worktree-remove',
      'hook-taskcompleted',
      'hook-subagentstart',
    ]) {
      expect(text).toContain(h);
    }
    expect(text).not.toContain('hook-pretooluse');
  });

  it('--with-reminders adds the PreToolUse edit reminder', () => {
    mergeSettings({ withReminders: true });
    expect(readSettings()).toContain('hook-pretooluse');
  });

  it('re-running the default REMOVES a previously opted-in reminder (converges)', () => {
    mergeSettings({ withReminders: true });
    expect(readSettings()).toContain('hook-pretooluse');
    mergeSettings();
    const text = readSettings();
    expect(text).not.toContain('hook-pretooluse');
    expect(text).toContain('hook-posttooluse'); // rest of the set intact
  });

  it('never clobbers a foreign PreToolUse hook', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    const foreign = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-other-tool guard' }] },
        ],
      },
    };
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(SETTINGS, JSON.stringify(foreign, null, 2));
    mergeSettings(); // default: no reminder
    const text = readSettings();
    expect(text).toContain('my-other-tool guard');
    expect(text).not.toContain('hook-pretooluse');
  });
});
