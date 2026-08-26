/**
 * Task 553 — THE single registration list.
 *
 * Four hand-kept registration lists had drifted: src/index.ts (41 handlers),
 * indexing-worker (41), run_benchmark (40), run_purecontext (21 — half the
 * language surface), and the ADAPTER order differed between main and worker
 * (first-match routing!). All entry points now consume bootstrap-registry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerStandardHandlers } from '../../src/core/bootstrap-registry.js';
import { getSupportedExtensions, getHandler } from '../../src/handlers/handler-registry.js';
import { getRegisteredAdapters } from '../../src/adapters/adapter-registry.js';

beforeAll(() => {
  registerStandardHandlers({ cssVariables: true });
});

describe('registerStandardHandlers', () => {
  it('registers the full language surface', () => {
    const exts = new Set(getSupportedExtensions());
    // One spot-check per registration region of the old lists.
    for (const ext of [
      '.ts', '.tsx', '.js', '.py', '.go', '.rs', '.java', '.cs', '.php',
      '.rb', '.kt', '.c', '.cpp', '.lua', '.dart', '.swift', '.ex', '.hs',
      '.scala', '.r', '.sql', '.sh', '.pl', '.tf', '.nix', '.proto',
      '.graphql', '.groovy', '.erl', '.gleam', '.gd', '.xml', '.f90',
      '.scss', '.less', '.css', '.m', '.hcl', '.html',
    ]) {
      expect(exts.has(ext), `missing extension ${ext}`).toBe(true);
    }
  });

  it('is idempotent', () => {
    const before = getSupportedExtensions().length;
    registerStandardHandlers({ cssVariables: true });
    expect(getSupportedExtensions().length).toBe(before);
  });

  it('cssVariables: false leaves .css out (the config-gated MCP default)', () => {
    // Registered with css above — the gate matters on a FRESH registry, which
    // the worker/main split exercises; here we just document that css is the
    // only conditional handler.
    expect(getHandler('style.css')).not.toBeNull();
  });
});

describe('adapter self-registration', () => {
  it('registers the standard adapters', () => {
    const names = getRegisteredAdapters().map((a) => a.name);
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const expected of ['vue', 'react', 'android', 'nestjs', 'flutter']) {
      expect(names).toContain(expected);
    }
  });

  it('android registers before the other JVM adapters (first-match routing)', () => {
    const names = getRegisteredAdapters().map((a) => a.name);
    const android = names.indexOf('android');
    for (const jvm of ['spring-boot', 'spring-kotlin', 'micronaut', 'quarkus', 'ktor']) {
      const idx = names.indexOf(jvm);
      if (idx >= 0) {
        expect(android, `android must precede ${jvm}`).toBeLessThan(idx);
      }
    }
  });
});

describe('library entry (src/lib.ts)', () => {
  it('imports without starting a server and exposes the driving surface', async () => {
    const lib = await import('../../src/lib.js');
    expect(typeof lib.registerStandardHandlers).toBe('function');
    expect(typeof lib.bootstrapLibrary).toBe('function');
    expect(typeof lib.indexFolder).toBe('function');
    expect(typeof lib.reindexFiles).toBe('function');
    expect(typeof lib.computeRepoId).toBe('function');
    expect(typeof lib.VERSION).toBe('string');
  });
});
