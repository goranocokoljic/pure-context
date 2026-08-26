/**
 * Task 503 (Phase 82): Kotlin `internal` symbols are indexed.
 *
 * `internal` = visible within the compilation module — exactly the unit being
 * indexed — so treating it like `private` produced false `no_match` verdicts
 * for impl classes, Hilt modules, and repository implementations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';

async function extract(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, kotlinHandler);
  return kotlinHandler.extractSymbols(tree, buf, 'Main.kt');
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('Kotlin internal visibility (Task 503)', () => {
  it('indexes an internal class with visibility recorded', async () => {
    const syms = await extract(`internal class RepositoryImpl {\n  fun load() {}\n}\n`);
    const cls = syms.find((s) => s.name === 'RepositoryImpl');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.['visibility']).toBe('internal');
    expect(cls!.signature).toContain('internal');
  });

  it('indexes an internal top-level function with visibility recorded', async () => {
    const syms = await extract(`internal fun wireUp(): Int = 1\n`);
    const fn = syms.find((s) => s.name === 'wireUp');
    expect(fn).toBeDefined();
    expect(fn!.frameworkMeta?.['visibility']).toBe('internal');
  });

  it('indexes an internal object and keeps the kotlin_object meta', async () => {
    const syms = await extract(`internal object DiModule {\n  fun provide(): Int = 1\n}\n`);
    const obj = syms.find((s) => s.name === 'DiModule');
    expect(obj).toBeDefined();
    expect(obj!.frameworkMeta?.['kotlin_object']).toBe(true);
    expect(obj!.frameworkMeta?.['visibility']).toBe('internal');
  });

  it('indexes an internal typealias and an internal const', async () => {
    const syms = await extract(
      `internal typealias Handler = (Int) -> Unit\ninternal val MAX_RETRIES = 3\n`,
    );
    expect(syms.find((s) => s.name === 'Handler')?.frameworkMeta?.['visibility']).toBe('internal');
    expect(syms.find((s) => s.name === 'MAX_RETRIES')?.frameworkMeta?.['visibility']).toBe('internal');
  });

  it('still skips private declarations', async () => {
    const syms = await extract(
      `private class Hidden\nprivate fun secret() {}\nclass Visible\n`,
    );
    expect(syms.find((s) => s.name === 'Hidden')).toBeUndefined();
    expect(syms.find((s) => s.name === 'secret')).toBeUndefined();
    expect(syms.find((s) => s.name === 'Visible')).toBeDefined();
  });

  it('public declarations carry no visibility meta', async () => {
    const syms = await extract(`class PublicThing\nfun publicFun() {}\n`);
    expect(syms.find((s) => s.name === 'PublicThing')!.frameworkMeta).toBeUndefined();
    expect(syms.find((s) => s.name === 'publicFun')!.frameworkMeta).toBeUndefined();
  });

  it('records protected visibility on class members', async () => {
    const syms = await extract(
      `open class Base {\n  protected fun hook() {}\n  internal fun mod() {}\n}\n`,
    );
    expect(syms.find((s) => s.name === 'Base.hook')?.frameworkMeta?.['visibility']).toBe('protected');
    expect(syms.find((s) => s.name === 'Base.mod')?.frameworkMeta?.['visibility']).toBe('internal');
  });
});
