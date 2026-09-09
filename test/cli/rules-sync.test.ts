/**
 * Phase 97, Task 604 — the always-on rules are single-sourced.
 *
 * `assets/agent-rules.md` ↔ the managed block in this repo's CLAUDE.md
 * (`npm run sync:rules`), and `hooks --install` must inject THAT text, not a
 * private copy (the pre-97 drift: two installers, two rule sets).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPureContextInstructions } from '../../src/cli/install-writers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = '<!-- purecontext-mcp-start -->';
const END = '<!-- purecontext-mcp-end -->';

describe('agent rules single source', () => {
  it('CLAUDE.md managed block equals assets/agent-rules.md (run `npm run sync:rules`)', () => {
    const rules = readFileSync(join(root, 'assets', 'agent-rules.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
    const s = claude.indexOf(START);
    const e = claude.indexOf(END);
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    expect(claude.slice(s + START.length, e).trim()).toBe(rules.trim());
  });

  it('the rules are a task table that names what the index is NOT for', () => {
    const rules = getPureContextInstructions('markdown');
    expect(rules).toMatch(/\| Task \| Use \| Not \|/);
    expect(rules).toContain('absence proof');
    expect(rules).toContain('git grep');
    expect(rules).toContain('freshness');
    expect(rules).toContain('onlyChanged: true');
    expect(rules).toContain('externalImports');
    // The old absolutist block is gone from the source of truth.
    expect(rules).not.toContain('Mandatory workflow');
    expect(rules).not.toContain('never skip this step');
  });

  it('hooks.ts carries no private copy of the rules', () => {
    const hooks = readFileSync(join(root, 'src', 'cli', 'hooks.ts'), 'utf8');
    expect(hooks).not.toContain('## Mandatory workflow');
    expect(hooks).toContain("getPureContextInstructions('markdown')");
  });
});
