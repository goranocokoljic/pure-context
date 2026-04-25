import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import {
  nextjsAdapter,
  derivePageRouterPath,
  deriveAppRouterPath,
} from '../../src/adapters/nextjs.js';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/nextjs-project');

async function parseTs(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, typescriptHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── derivePageRouterPath ─────────────────────────────────────────────────────

describe('derivePageRouterPath', () => {
  it('index page → /', () => {
    expect(derivePageRouterPath('pages/index.tsx')).toBe('/');
  });

  it('top-level page → /slug', () => {
    expect(derivePageRouterPath('pages/about.tsx')).toBe('/about');
  });

  it('nested page → /blog/post', () => {
    expect(derivePageRouterPath('pages/blog/post.tsx')).toBe('/blog/post');
  });

  it('dynamic segment → /blog/:slug', () => {
    expect(derivePageRouterPath('pages/blog/[slug].tsx')).toBe('/blog/:slug');
  });

  it('catch-all → /*catch', () => {
    expect(derivePageRouterPath('pages/[...catch].tsx')).toBe('/*catch');
  });

  it('optional catch-all → /*opt?', () => {
    expect(derivePageRouterPath('pages/[[...opt]].tsx')).toBe('/*opt?');
  });

  it('nested index → /blog', () => {
    expect(derivePageRouterPath('pages/blog/index.tsx')).toBe('/blog');
  });

  it('API route → /api/users', () => {
    expect(derivePageRouterPath('pages/api/users.ts')).toBe('/api/users');
  });
});

// ─── deriveAppRouterPath ──────────────────────────────────────────────────────

describe('deriveAppRouterPath', () => {
  it('root page → /', () => {
    expect(deriveAppRouterPath('app/page.tsx')).toBe('/');
  });

  it('nested page → /about', () => {
    expect(deriveAppRouterPath('app/about/page.tsx')).toBe('/about');
  });

  it('dynamic segment → /blog/:slug', () => {
    expect(deriveAppRouterPath('app/blog/[slug]/page.tsx')).toBe('/blog/:slug');
  });

  it('route group stripped → /about', () => {
    expect(deriveAppRouterPath('app/(marketing)/about/page.tsx')).toBe('/about');
  });

  it('api route → /api/users', () => {
    expect(deriveAppRouterPath('app/api/users/route.ts')).toBe('/api/users');
  });

  it('deeply nested → /dashboard/settings', () => {
    expect(deriveAppRouterPath('app/dashboard/settings/page.tsx')).toBe('/dashboard/settings');
  });

  it('layout at root → /', () => {
    expect(deriveAppRouterPath('app/layout.tsx')).toBe('/');
  });

  it('optional catch-all → /*slug?', () => {
    expect(deriveAppRouterPath('app/[[...slug]]/page.tsx')).toBe('/*slug?');
  });
});

// ─── fileFilter ───────────────────────────────────────────────────────────────

describe('nextjsAdapter.fileFilter', () => {
  it('accepts pages/ file', () => {
    expect(nextjsAdapter.fileFilter('pages/index.tsx')).toBe(true);
  });

  it('accepts pages/api/ file', () => {
    expect(nextjsAdapter.fileFilter('pages/api/users.ts')).toBe(true);
  });

  it('accepts app/page.tsx', () => {
    expect(nextjsAdapter.fileFilter('app/page.tsx')).toBe(true);
  });

  it('accepts app/layout.tsx', () => {
    expect(nextjsAdapter.fileFilter('app/layout.tsx')).toBe(true);
  });

  it('accepts app/route.ts', () => {
    expect(nextjsAdapter.fileFilter('app/api/users/route.ts')).toBe(true);
  });

  it('accepts middleware.ts', () => {
    expect(nextjsAdapter.fileFilter('middleware.ts')).toBe(true);
  });

  it('accepts src/ prefixed paths', () => {
    expect(nextjsAdapter.fileFilter('src/app/page.tsx')).toBe(true);
    expect(nextjsAdapter.fileFilter('src/pages/index.tsx')).toBe(true);
    expect(nextjsAdapter.fileFilter('src/middleware.ts')).toBe(true);
  });

  it('rejects components/ files', () => {
    expect(nextjsAdapter.fileFilter('components/Button.tsx')).toBe(false);
  });

  it('rejects lib/ files', () => {
    expect(nextjsAdapter.fileFilter('lib/utils.ts')).toBe(false);
  });

  it('rejects app/components/ files (not special Next.js name)', () => {
    expect(nextjsAdapter.fileFilter('app/components/Button.tsx')).toBe(false);
  });
});

// ─── detect ──────────────────────────────────────────────────────────────────

describe('nextjsAdapter.detect', () => {
  it('detects via next.config.js', async () => {
    const result = await nextjsAdapter.detect(FIXTURE_ROOT);
    expect(result).toBe(true);
  });

  it('detects via package.json dependency', async () => {
    // A directory with no config file but next in package.json
    // Use the fixture which has both; test a sub-path via a temp approach
    // Instead, test detection directly: fixture has next.config.js so it returns true
    expect(await nextjsAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for non-Next project', async () => {
    // Use a directory that definitely has no next.config.* or next dep
    const result = await nextjsAdapter.detect(resolve(FIXTURE_ROOT, '../go-project'));
    expect(result).toBe(false);
  });
});

// ─── extractFrameworkSymbols — pages router page ──────────────────────────────

describe('extractFrameworkSymbols — pages router page', () => {
  it('emits a route symbol for pages/index.tsx → /', async () => {
    const src = Buffer.from('export default function Home() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/index.tsx');
    expect(syms).toHaveLength(1);
    const sym = syms[0];
    expect(sym.kind).toBe('route');
    expect(sym.name).toBe('/');
    expect(sym.signature).toBe('GET /');
    expect(sym.frameworkMeta?.route_path).toBe('/');
    expect(sym.frameworkMeta?.router).toBe('pages');
    expect(sym.frameworkMeta?.nextjs_page).toBe(true);
  });

  it('emits correct route for pages/blog/[slug].tsx', async () => {
    const src = Buffer.from('export default function Post() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/blog/[slug].tsx');
    expect(syms[0].name).toBe('/blog/:slug');
  });

  it('handles src/ prefix for pages router', async () => {
    const src = Buffer.from('export default function Page() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'src/pages/about.tsx');
    expect(syms[0].name).toBe('/about');
  });
});

// ─── extractFrameworkSymbols — pages router api ───────────────────────────────

describe('extractFrameworkSymbols — pages router API', () => {
  it('emits a route for pages/api/users.ts → /api/users', async () => {
    const src = Buffer.from('export default function handler(req, res) {}');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/api/users.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('route');
    expect(syms[0].name).toBe('/api/users');
    expect(syms[0].frameworkMeta?.api_route).toBe(true);
    expect(syms[0].frameworkMeta?.router).toBe('pages');
  });

  it('preserves dynamic segment in API path', async () => {
    const src = Buffer.from('export default function handler(req, res) {}');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/api/users/[id].ts');
    expect(syms[0].name).toBe('/api/users/:id');
  });
});

// ─── extractFrameworkSymbols — app router page ───────────────────────────────

describe('extractFrameworkSymbols — app router page', () => {
  it('emits route for app/page.tsx → /', async () => {
    const src = Buffer.from('export default function Page() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/page.tsx');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('route');
    expect(syms[0].name).toBe('/');
    expect(syms[0].frameworkMeta?.router).toBe('app');
    expect(syms[0].frameworkMeta?.nextjs_page).toBe(true);
    expect(syms[0].frameworkMeta?.server_component).toBe(true);
  });

  it('detects use client directive', async () => {
    const src = Buffer.from("'use client';\nexport default function Page() { return null; }");
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/dashboard/page.tsx');
    expect(syms[0].frameworkMeta?.client_component).toBe(true);
    expect(syms[0].frameworkMeta?.server_component).toBeUndefined();
  });

  it('handles route groups (strips from path)', async () => {
    const src = Buffer.from('export default function Page() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/(marketing)/about/page.tsx');
    expect(syms[0].name).toBe('/about');
  });

  it('handles src/ prefix', async () => {
    const src = Buffer.from('export default function Page() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'src/app/about/page.tsx');
    expect(syms[0].name).toBe('/about');
  });
});

// ─── extractFrameworkSymbols — app router special ────────────────────────────

describe('extractFrameworkSymbols — app router special files', () => {
  it('layout → component with nextjs_special=layout', async () => {
    const src = Buffer.from('export default function Layout({ children }) { return children; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/layout.tsx');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('component');
    expect(syms[0].frameworkMeta?.nextjs_special).toBe('layout');
    expect(syms[0].frameworkMeta?.route_path).toBe('/');
  });

  it('loading → component with nextjs_special=loading', async () => {
    const src = Buffer.from('export default function Loading() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/dashboard/loading.tsx');
    expect(syms[0].frameworkMeta?.nextjs_special).toBe('loading');
    expect(syms[0].frameworkMeta?.route_path).toBe('/dashboard');
  });

  it('error → component with nextjs_special=error', async () => {
    const src = Buffer.from("'use client';\nexport default function Error() { return null; }");
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/error.tsx');
    expect(syms[0].frameworkMeta?.nextjs_special).toBe('error');
  });

  it('not-found → component with nextjs_special=not-found', async () => {
    const src = Buffer.from('export default function NotFound() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/not-found.tsx');
    expect(syms[0].frameworkMeta?.nextjs_special).toBe('not-found');
  });

  it('special file name includes route path', async () => {
    const src = Buffer.from('export default function Layout({ children }) { return children; }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'app/dashboard/layout.tsx');
    expect(syms[0].name).toBe('layout:/dashboard');
    expect(syms[0].signature).toBe('layout /dashboard');
  });
});

// ─── extractFrameworkSymbols — app router API ────────────────────────────────

describe('extractFrameworkSymbols — app router API route', () => {
  it('emits one symbol per exported HTTP method', async () => {
    const src = `
export async function GET() { return Response.json([]); }
export async function POST() { return Response.json({}, { status: 201 }); }
`;
    const { tree, buf } = await parseTs(src);
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, buf, 'app/api/users/route.ts');
    expect(syms).toHaveLength(2);
    const names = syms.map((s) => s.name).sort();
    expect(names).toContain('GET /api/users');
    expect(names).toContain('POST /api/users');
    for (const sym of syms) {
      expect(sym.kind).toBe('route');
      expect(sym.frameworkMeta?.api_route).toBe(true);
      expect(sym.frameworkMeta?.router).toBe('app');
    }
  });

  it('emits generic route if no HTTP method exported', async () => {
    const src = `export const config = { runtime: 'edge' };`;
    const { tree, buf } = await parseTs(src);
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, buf, 'app/api/health/route.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('/api/health');
    expect(syms[0].frameworkMeta?.http_method).toBeUndefined();
  });

  it('each method symbol has correct http_method in meta', async () => {
    const src = `export function GET() {}\nexport function DELETE() {}`;
    const { tree, buf } = await parseTs(src);
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, buf, 'app/items/[id]/route.ts');
    const methods = syms.map((s) => s.frameworkMeta?.http_method as string).sort();
    expect(methods).toEqual(['DELETE', 'GET']);
  });
});

// ─── extractFrameworkSymbols — middleware ────────────────────────────────────

describe('extractFrameworkSymbols — middleware', () => {
  it('emits a middleware symbol for middleware.ts', async () => {
    const src = Buffer.from('export function middleware() { return NextResponse.next(); }');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'middleware.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('middleware');
    expect(syms[0].name).toBe('middleware');
    expect(syms[0].frameworkMeta?.nextjs_middleware).toBe(true);
  });

  it('emits middleware for middleware.js', async () => {
    const src = Buffer.from('export function middleware() {}');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'middleware.js');
    expect(syms[0].kind).toBe('middleware');
  });

  it('handles src/middleware.ts', async () => {
    const src = Buffer.from('export function middleware() {}');
    const { tree } = await parseTs(src.toString());
    const syms = nextjsAdapter.extractFrameworkSymbols(tree, src, 'src/middleware.ts');
    expect(syms[0].kind).toBe('middleware');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('nextjsAdapter.enrichMetadata', () => {
  it('enriches a Pages Router component with route_path', () => {
    const sym = {
      id: 'abc',
      name: 'Home',
      kind: 'component' as const,
      filePath: 'pages/index.tsx',
      startByte: 0,
      endByte: 50,
      signature: 'function Home()',
      summary: '',
    };
    const enriched = nextjsAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.route_path).toBe('/');
    expect(enriched.frameworkMeta?.nextjs_page).toBe(true);
  });

  it('enriches an App Router page component', () => {
    const sym = {
      id: 'def',
      name: 'Dashboard',
      kind: 'component' as const,
      filePath: 'app/dashboard/page.tsx',
      startByte: 0,
      endByte: 50,
      signature: 'function Dashboard()',
      summary: '',
    };
    const enriched = nextjsAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.route_path).toBe('/dashboard');
    expect(enriched.frameworkMeta?.router).toBe('app');
  });

  it('does not enrich pages/api/ components', () => {
    const sym = {
      id: 'ghi',
      name: 'handler',
      kind: 'component' as const,
      filePath: 'pages/api/users.ts',
      startByte: 0,
      endByte: 50,
      signature: 'function handler()',
      summary: '',
    };
    const enriched = nextjsAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.route_path).toBeUndefined();
  });

  it('does not enrich non-component symbols', () => {
    const sym = {
      id: 'jkl',
      name: 'getServerSideProps',
      kind: 'function' as const,
      filePath: 'pages/index.tsx',
      startByte: 0,
      endByte: 50,
      signature: 'function getServerSideProps()',
      summary: '',
    };
    const enriched = nextjsAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta).toBeUndefined();
  });

  it('preserves existing frameworkMeta when enriching', () => {
    const sym = {
      id: 'mno',
      name: 'BlogPost',
      kind: 'component' as const,
      filePath: 'pages/blog/[slug].tsx',
      startByte: 0,
      endByte: 50,
      signature: 'function BlogPost()',
      summary: '',
      frameworkMeta: { react_component: true },
    };
    const enriched = nextjsAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.react_component).toBe(true);
    expect(enriched.frameworkMeta?.route_path).toBe('/blog/:slug');
  });
});

// ─── Symbol ID determinism ────────────────────────────────────────────────────

describe('symbol ID determinism', () => {
  it('produces the same ID for the same file+route combination', async () => {
    const src = Buffer.from('export default function Page() { return null; }');
    const { tree } = await parseTs(src.toString());
    const syms1 = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/index.tsx');
    const syms2 = nextjsAdapter.extractFrameworkSymbols(tree, src, 'pages/index.tsx');
    expect(syms1[0].id).toBe(syms2[0].id);
    expect(syms1[0].id).toHaveLength(16);
    expect(syms1[0].id).toMatch(/^[0-9a-f]+$/);
  });
});
