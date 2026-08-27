/**
 * Phase 92 (Task 570c) — Next.js un-shadowing integration tests.
 *
 * Pre-92 the react adapter registered before nextjs and claimed every
 * .tsx/.jsx file, so nextjs.extractFrameworkSymbols never ran for App Router
 * pages. These tests run BOTH adapters in the new bootstrap order
 * ([nextjs, react]) through the full pipeline.
 *
 * Also covers 570b: 'use client' detection must survive a license header, and
 * 'use server' / directive metadata applies to special files too.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nextjsAdapter, detectDirective } from '../../src/adapters/nextjs.js';
import { reactAdapter } from '../../src/adapters/react.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import { registerHandler, _resetForTesting as resetHandlers } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { indexFolder, deleteIndex, computeRepoId } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-nextorder-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  resetHandlers();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

beforeEach(() => {
  _resetForTesting();
});

// ─── detectDirective unit tests (570b) ───────────────────────────────────────

describe('nextjs detectDirective', () => {
  it("finds 'use client' as the first statement", () => {
    expect(detectDirective(Buffer.from(`'use client';\nexport default function P() {}`)))
      .toBe('use client');
  });

  it('finds the directive behind a license header (block comment)', () => {
    const license = '/*\n' + ' * Copyright (c) Example Corp.\n'.repeat(12) + ' */\n';
    expect(detectDirective(Buffer.from(`${license}'use client';\nexport default function P() {}`)))
      .toBe('use client');
  });

  it('finds the directive behind line comments and blank lines', () => {
    expect(detectDirective(Buffer.from(`// eslint-disable\n\n// note\n"use server";\nexport async function act() {}`)))
      .toBe('use server');
  });

  it('returns null when the directive is not the first statement', () => {
    expect(detectDirective(Buffer.from(`import x from 'y';\n'use client';`)))
      .toBeNull();
  });

  it('returns null when there is no directive', () => {
    expect(detectDirective(Buffer.from(`export default function P() {}`)))
      .toBeNull();
  });
});

// ─── Full pipeline: nextjs before react ──────────────────────────────────────

describe('Phase 92 — nextjs un-shadowed by react (bootstrap order)', () => {
  it('App Router pages produce route symbols AND their own component symbols', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      const license = '/*\n * Copyright (c) Example Corp. All rights reserved.\n * Licensed under MIT.\n */\n';
      writeFile(dir, 'app/dashboard/page.tsx', `${license}'use client';
export default function DashboardPage() {
  return <div>dash</div>;
}
`);
      writeFile(dir, 'app/layout.tsx', `
export default function RootLayout({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`.trim());
      writeFile(dir, 'pages/api/user.ts', `
export default function handler(req: unknown, res: unknown) {}
`.trim());
      writeFile(dir, 'middleware.ts', `
export function middleware() {}
`.trim());
      writeFile(dir, 'components/Button.tsx', `
export function Button() {
  return <button />;
}
`.trim());

      // New bootstrap order: nextjs BEFORE react
      await indexFolder(dir, { adapters: [nextjsAdapter, reactAdapter] });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();

      // Route symbol for the App Router page — the pre-92 shadowing bug made
      // this impossible (react claimed the file, extractFrameworkSymbols
      // returned []).
      const pageRoute = all.find((s) => s.kind === 'route' && s.name === '/dashboard');
      expect(pageRoute).toBeDefined();
      // 570b: 'use client' detected despite the license header
      expect(pageRoute?.frameworkMeta?.['client_component']).toBe(true);

      // The page's own component symbol is still extracted (handler parses in
      // the adapter path) and react's cross-adapter enrichment upgrades it.
      const pageComponent = all.find(
        (s) => s.name === 'DashboardPage' && s.filePath.endsWith('page.tsx'),
      );
      expect(pageComponent).toBeDefined();
      expect(pageComponent?.kind).toBe('component');

      // Layout special file → component symbol with directive default
      const layout = all.find(
        (s) => s.kind === 'component' && String(s.name).startsWith('layout:'),
      );
      expect(layout).toBeDefined();
      expect(layout?.frameworkMeta?.['server_component']).toBe(true);

      // Pages Router .ts API route unchanged
      const apiRoute = all.find((s) => s.kind === 'route' && s.name === '/api/user');
      expect(apiRoute).toBeDefined();

      // Middleware unchanged
      expect(all.some((s) => s.kind === 'middleware')).toBe(true);

      // Non-Next .tsx still falls through to react
      const button = all.find((s) => s.name === 'Button');
      expect(button?.kind).toBe('component');
      expect(button?.frameworkMeta?.['react_component']).toBe(true);
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('Pages Router pages record ssr/ssg data-fetching meta (573 stretch)', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      writeFile(dir, 'pages/blog/[slug].tsx', `
export async function getServerSideProps() {
  return { props: {} };
}
export default function BlogPost() {
  return <article />;
}
`.trim());
      writeFile(dir, 'pages/about.tsx', `
export const getStaticProps = async () => ({ props: {} });
export default function About() {
  return <main />;
}
`.trim());

      await indexFolder(dir, { adapters: [nextjsAdapter, reactAdapter] });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();

      const blogRoute = all.find((s) => s.kind === 'route' && s.name === '/blog/:slug');
      expect(blogRoute?.frameworkMeta?.['ssr']).toBe(true);
      expect(blogRoute?.frameworkMeta?.['ssg']).toBeUndefined();

      const aboutRoute = all.find((s) => s.kind === 'route' && s.name === '/about');
      expect(aboutRoute?.frameworkMeta?.['ssg']).toBe(true);
      expect(aboutRoute?.frameworkMeta?.['ssr']).toBeUndefined();
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
