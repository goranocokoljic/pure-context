/**
 * Phase 93 (Task 582) — Vue/Nuxt detection is blind to test-fixture trees.
 *
 * V-7 remainder: PureContext's own repo activated the Vue adapter (its only
 * .vue files are test fixtures) and self-indexed its Zustand stores as
 * `composable`. Detection now ignores test/fixture/example dirs.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { vueAdapter } from '../../src/adapters/vue.js';
import { nuxtAdapter } from '../../src/adapters/nuxt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-detect-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('fixture-blind detection', () => {
  it('vue: a repo whose only .vue files are test fixtures does NOT activate', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{"dependencies":{"zustand":"1.0.0"}}');
      const fx = join(dir, 'test', 'fixtures', 'vue-app');
      mkdirSync(fx, { recursive: true });
      writeFileSync(join(fx, 'App.vue'), '<template><div/></template>');
      expect(await vueAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vue: real source .vue files still activate', async () => {
    const dir = tmpDir();
    try {
      const src = join(dir, 'frontend', 'components');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'App.vue'), '<template><div/></template>');
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nuxt: a nuxt.config inside a fixtures tree does NOT activate', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      const fx = join(dir, 'fixtures', 'nuxt-app');
      mkdirSync(fx, { recursive: true });
      writeFileSync(join(fx, 'nuxt.config.ts'), 'export default {}');
      expect(await nuxtAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('self-index guard: PureContext itself activates neither vue nor nuxt', async () => {
    expect(await vueAdapter.detect(REPO_ROOT)).toBe(false);
    expect(await nuxtAdapter.detect(REPO_ROOT)).toBe(false);
  });
});
