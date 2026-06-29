import { describe, it, expect, vi } from 'vitest';

// The compact agent rules are loaded at runtime from assets/agent-rules.md.
// Mock `fs` so existsSync reports the file as absent, exercising the loader's
// fail-loud path. vi.mock is hoisted above the install-writers import, so the
// module's destructured `existsSync` binding resolves to the mock.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: () => false };
});

import { getPureContextInstructions } from '../../src/cli/install-writers.js';

describe('agent-rules loader — missing source file', () => {
  it('throws a clear, actionable error instead of writing empty rules', () => {
    expect(() => getPureContextInstructions('markdown')).toThrow(/agent rules file not found/);
  });

  it('also fails for the mdc format (no silent empty frontmatter)', () => {
    expect(() => getPureContextInstructions('mdc')).toThrow(/reinstall purecontext-mcp/);
  });
});
