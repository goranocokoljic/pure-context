/**
 * Phase 93 (Task 578) — lang="tsx" SFC blocks route to the tsx handler.
 *
 * Previously detectLanguage mapped tsx → 'typescript', whose grammar cannot
 * parse literal JSX, so the block yielded zero symbols. The block now carries
 * language 'tsx' and the pipeline resolves the tsxHandler for it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { processFile } from '../../src/core/file-processor.js';
import { vueAdapter } from '../../src/adapters/vue.js';

beforeAll(async () => {
  _resetForTesting();
  await initParser();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
});

describe('lang="tsx" SFC block — full pipeline', () => {
  it('extracts symbols from a tsx script block containing literal JSX', async () => {
    const sfc =
      '<script lang="tsx">\n' +
      'export function renderBadge(count: number) {\n' +
      '  return <span class="badge">{count}</span>\n' +
      '}\n' +
      'export const MAX_BADGES = 99\n' +
      '</script>\n';
    const buf = Buffer.from(sfc, 'utf8');
    const { symbols } = await processFile('components/Badge.vue', buf, [vueAdapter]);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('renderBadge');
    expect(names).toContain('MAX_BADGES');
  });

  it('lang="ts" without JSX still parses (guard)', async () => {
    const sfc =
      '<script lang="ts">\n' +
      'export function plainTs(): number { return 1 }\n' +
      '</script>\n';
    const buf = Buffer.from(sfc, 'utf8');
    const { symbols } = await processFile('components/Plain.vue', buf, [vueAdapter]);
    expect(symbols.map((s) => s.name)).toContain('plainTs');
  });
});
