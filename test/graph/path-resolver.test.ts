import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResolver } from '../../src/graph/path-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp project directory with the given file tree and an optional
 * tsconfig.json. Returns the project root path.
 */
function makeTempProject(
  files: Record<string, string>,
  tsconfig?: object,
): string {
  const root = join(tmpdir(), `purecontext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const abs = join(root, filePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  if (tsconfig) {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  }

  return root;
}

// ─── Relative path resolution ─────────────────────────────────────────────────

describe('relative path resolution', () => {
  it('resolves ./sibling to the .ts file', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const r = createResolver(root);
    expect(r.resolve('./b', 'src/a.ts')).toBe('src/b.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves ./sibling.js to the .ts file (TS ESM convention)', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const r = createResolver(root);
    expect(r.resolve('./b.js', 'src/a.ts')).toBe('src/b.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves ../parent', () => {
    const root = makeTempProject({ 'src/utils/a.ts': '', 'src/b.ts': '' });
    const r = createResolver(root);
    expect(r.resolve('../b', 'src/utils/a.ts')).toBe('src/b.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves to .tsx file', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/Comp.tsx': '' });
    const r = createResolver(root);
    expect(r.resolve('./Comp', 'src/a.ts')).toBe('src/Comp.tsx');
    rmSync(root, { recursive: true });
  });

  it('resolves to index.ts when pointing at a directory', () => {
    const root = makeTempProject({
      'src/a.ts': '',
      'src/utils/index.ts': '',
    });
    const r = createResolver(root);
    expect(r.resolve('./utils', 'src/a.ts')).toBe('src/utils/index.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves to index.ts when specifier ends with /', () => {
    const root = makeTempProject({
      'src/a.ts': '',
      'src/utils/index.ts': '',
    });
    const r = createResolver(root);
    // ./utils/ is treated as a directory
    expect(r.resolve('./utils/', 'src/a.ts')).toBe('src/utils/index.ts');
    rmSync(root, { recursive: true });
  });

  it('returns null when file does not exist', () => {
    const root = makeTempProject({ 'src/a.ts': '' });
    const r = createResolver(root);
    expect(r.resolve('./nonexistent', 'src/a.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });

  it('resolves .js → .js when the .js file actually exists', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.js': '' });
    const r = createResolver(root);
    // .ts doesn't exist, but .js does
    expect(r.resolve('./b.js', 'src/a.ts')).toBe('src/b.js');
    rmSync(root, { recursive: true });
  });

  it('returns result with forward slashes on all platforms', () => {
    const root = makeTempProject({ 'src/nested/a.ts': '', 'src/b.ts': '' });
    const r = createResolver(root);
    const result = r.resolve('../b', 'src/nested/a.ts');
    expect(result).not.toContain('\\');
  });
});

// ─── tsconfig path alias resolution ──────────────────────────────────────────

describe('tsconfig path alias resolution', () => {
  it('resolves @/* wildcard alias', () => {
    const root = makeTempProject(
      { 'src/utils.ts': '' },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      },
    );
    const r = createResolver(root);
    expect(r.resolve('@/utils', 'app/page.ts')).toBe('src/utils.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves ~/* alias (Nuxt convention)', () => {
    const root = makeTempProject(
      { 'src/foo.ts': '' },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '~/*': ['src/*'] },
        },
      },
    );
    const r = createResolver(root);
    expect(r.resolve('~/foo', 'pages/index.ts')).toBe('src/foo.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves exact (non-wildcard) alias', () => {
    const root = makeTempProject(
      { 'src/config.ts': '' },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@config': ['src/config.ts'] },
        },
      },
    );
    const r = createResolver(root);
    expect(r.resolve('@config', 'app/main.ts')).toBe('src/config.ts');
    rmSync(root, { recursive: true });
  });

  it('resolves alias with nested path', () => {
    const root = makeTempProject(
      { 'src/components/Button.ts': '' },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@components/*': ['src/components/*'] },
        },
      },
    );
    const r = createResolver(root);
    expect(r.resolve('@components/Button', 'pages/home.ts')).toBe(
      'src/components/Button.ts',
    );
    rmSync(root, { recursive: true });
  });

  it('tries multiple replacements and returns first that resolves', () => {
    const root = makeTempProject(
      { 'fallback/foo.ts': '' },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['primary/*', 'fallback/*'] },
        },
      },
    );
    const r = createResolver(root);
    // primary/foo.ts doesn't exist but fallback/foo.ts does
    expect(r.resolve('@/foo', 'src/a.ts')).toBe('fallback/foo.ts');
    rmSync(root, { recursive: true });
  });

  it('falls through to external when alias has no match', () => {
    const root = makeTempProject(
      {},
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      },
    );
    const r = createResolver(root);
    // File doesn't exist — alias matches but file is missing
    expect(r.resolve('@/missing', 'src/a.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });

  it('handles tsconfig with comments without throwing', () => {
    const root = join(
      tmpdir(),
      `purecontext-comments-${Date.now()}`,
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'tsconfig.json'),
      `{
        // base url comment
        "compilerOptions": {
          "baseUrl": ".",
          /* paths comment */
          "paths": { "@/*": ["src/*"] }
        }
      }`,
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'foo.ts'), '');
    const r = createResolver(root);
    expect(r.resolve('@/foo', 'main.ts')).toBe('src/foo.ts');
    rmSync(root, { recursive: true });
  });

  it('does not treat comment-like sequences inside strings as comments', () => {
    // Regression: a `"~/*"` paths key opens `/*` and an `include` glob like
    // `"**​/*"` closes `*/`. A whole-text comment-stripping regex would delete
    // the entire paths block and corrupt the (valid) JSON.
    const root = join(tmpdir(), `purecontext-glob-${Date.now()}`);
    mkdirSync(join(root, 'vue/src/stores'), { recursive: true });
    writeFileSync(join(root, 'vue/src/stores/settings.js'), '');
    writeFileSync(
      join(root, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "~/*": ["./vue/src/*"],
            "@/*": ["./vue/src/*"]
          }
        },
        "include": ["vue/src/**/*"]
      }`,
    );
    const r = createResolver(root);
    expect(r.resolve('~/stores/settings', 'vue/src/pages/page.vue')).toBe(
      'vue/src/stores/settings.js',
    );
    rmSync(root, { recursive: true });
  });
});

// ─── jsconfig.json fallback ───────────────────────────────────────────────────

describe('jsconfig.json fallback', () => {
  it('resolves aliases from jsconfig.json when no tsconfig.json exists', () => {
    const root = join(tmpdir(), `purecontext-jsconfig-${Date.now()}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'foo.js'), '');
    writeFileSync(
      join(root, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    );
    const r = createResolver(root);
    expect(r.resolve('@/foo', 'app/page.js')).toBe('src/foo.js');
    rmSync(root, { recursive: true });
  });

  it('prefers tsconfig.json over jsconfig.json when both exist', () => {
    const root = join(tmpdir(), `purecontext-both-${Date.now()}`);
    mkdirSync(join(root, 'ts'), { recursive: true });
    mkdirSync(join(root, 'js'), { recursive: true });
    writeFileSync(join(root, 'ts', 'foo.ts'), '');
    writeFileSync(join(root, 'js', 'foo.js'), '');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['ts/*'] } },
      }),
    );
    writeFileSync(
      join(root, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['js/*'] } },
      }),
    );
    const r = createResolver(root);
    // tsconfig wins → ts/foo.ts, not js/foo.js
    expect(r.resolve('@/foo', 'app/page.ts')).toBe('ts/foo.ts');
    rmSync(root, { recursive: true });
  });
});

// ─── External packages ────────────────────────────────────────────────────────

describe('external package resolution', () => {
  it('returns null for bare npm package name', () => {
    const root = makeTempProject({});
    const r = createResolver(root);
    expect(r.resolve('express', 'src/app.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });

  it('returns null for scoped package', () => {
    const root = makeTempProject({});
    const r = createResolver(root);
    expect(r.resolve('@modelcontextprotocol/sdk', 'src/server.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });

  it('returns null for Node built-ins', () => {
    const root = makeTempProject({});
    const r = createResolver(root);
    expect(r.resolve('path', 'src/a.ts')).toBeNull();
    expect(r.resolve('node:fs', 'src/a.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });
});

// ─── No tsconfig ─────────────────────────────────────────────────────────────

describe('project without tsconfig', () => {
  it('still resolves relative imports', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    // No tsconfig — createResolver should not throw
    const r = createResolver(root);
    expect(r.resolve('./b', 'src/a.ts')).toBe('src/b.ts');
    rmSync(root, { recursive: true });
  });

  it('returns null for alias-style specifiers', () => {
    const root = makeTempProject({ 'src/a.ts': '' });
    const r = createResolver(root);
    expect(r.resolve('@/foo', 'src/a.ts')).toBeNull();
    rmSync(root, { recursive: true });
  });
});

// ─── Real fixture project ─────────────────────────────────────────────────────

describe('real fixture project', () => {
  const r = createResolver(FIXTURE);

  it('resolver has the correct projectRoot', () => {
    expect(r.projectRoot).toBe(FIXTURE);
  });

  it('resolves ./utils.js → src/utils.ts from src/index.ts', () => {
    const result = r.resolve('./utils.js', 'src/index.ts');
    expect(result).toBe('src/utils.ts');
  });

  it('resolves ./types.js → src/types.ts', () => {
    const result = r.resolve('./types.js', 'src/index.ts');
    expect(result).toBe('src/types.ts');
  });

  it('resolves @/* alias from fixture tsconfig', () => {
    // tsconfig has "@/*": ["src/*"] — but aliased.ts imports '@/lib/helpers'
    // which would be src/lib/helpers.ts (doesn't exist)
    // and '@/src/types' → src/src/types.ts (also not a real path)
    // Just verify the resolver uses the tsconfig
    const result = r.resolve('@/utils', 'src/aliased.ts');
    expect(result).toBe('src/utils.ts');
  });
});
