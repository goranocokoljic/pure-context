/**
 * Task 509 (Phase 83): C# visibility fix.
 *
 * C# has ASYMMETRIC defaults: a top-level type with no modifier is `internal`
 * (must be indexed — the pre-83 handler dropped it, explaining the C# benchmark
 * floor), while a member with no modifier is `private` (stays skipped).
 * Non-public visibility is recorded in frameworkMeta.visibility (Kotlin pattern).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { csharpHandler } from '../../src/handlers/csharp.js';

async function symbolsOf(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, csharpHandler);
  return csharpHandler.extractSymbols(tree, buf, 'src/Test.cs');
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('C# type-level visibility (default internal)', () => {
  it('indexes a modifier-less top-level class as internal', async () => {
    const syms = await symbolsOf(`class OrderProcessor {}\n`);
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('OrderProcessor');
    expect(syms[0].frameworkMeta?.['visibility']).toBe('internal');
  });

  it('indexes an explicit internal class with visibility metadata', async () => {
    const syms = await symbolsOf(`internal class Repository {}\n`);
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('Repository');
    expect(syms[0].frameworkMeta?.['visibility']).toBe('internal');
  });

  it('indexes modifier-less struct, record, enum, and interface as internal', async () => {
    const syms = await symbolsOf(
      `struct Point { }\nrecord User(long Id);\nenum Role { Admin }\ninterface IThing { }\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).toContain('Point');
    expect(names).toContain('User');
    expect(names).toContain('Role');
    expect(names).toContain('IThing');
    for (const s of syms) {
      expect(s.frameworkMeta?.['visibility']).toBe('internal');
    }
  });

  it('a public class carries no visibility metadata', async () => {
    const syms = await symbolsOf(`public class Api {}\n`);
    expect(syms[0].frameworkMeta).toBeUndefined();
  });

  it('indexes modifier-less types inside a file-scoped namespace', async () => {
    const syms = await symbolsOf(`namespace My.App;\nclass Hidden {}\n`);
    expect(syms.some((s) => s.name === 'Hidden')).toBe(true);
  });

  it('skips a nested type marked private, keeps a modifier-less nested type', async () => {
    const syms = await symbolsOf(
      `public class Outer {\n  private class Secret {}\n  class Helper {}\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('Outer.Secret');
    expect(names).toContain('Outer.Helper');
  });
});

describe('C# member-level visibility (default private)', () => {
  it('indexes an internal method with visibility metadata', async () => {
    const syms = await symbolsOf(
      `public class Svc {\n  internal void Sync() {}\n}\n`,
    );
    const m = syms.find((s) => s.name === 'Svc.Sync');
    expect(m).toBeDefined();
    expect(m!.frameworkMeta?.['visibility']).toBe('internal');
  });

  it('indexes protected internal, skips private protected', async () => {
    const syms = await symbolsOf(
      `public class Svc {\n  protected internal void A() {}\n  private protected void B() {}\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).toContain('Svc.A');
    expect(names).not.toContain('Svc.B');
    const a = syms.find((s) => s.name === 'Svc.A');
    expect(a!.frameworkMeta?.['visibility']).toBe('protected internal');
  });

  it('still skips no-modifier methods and fields (private default)', async () => {
    const syms = await symbolsOf(
      `public class Svc {\n  void Helper() {}\n  const int MAX = 3;\n  static readonly string Tag = "t";\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).toEqual(['Svc']);
  });

  it('still skips explicitly private members', async () => {
    const syms = await symbolsOf(
      `public class Svc {\n  private void Hidden() {}\n  private string Name { get; set; }\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('Svc.Hidden');
    expect(names).not.toContain('Svc.Name');
  });

  it('interface members remain indexed without explicit modifiers', async () => {
    const syms = await symbolsOf(
      `public interface IRepo {\n  Entity Get(int id);\n  string Name { get; }\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).toContain('IRepo.Get');
    expect(names).toContain('IRepo.Name');
  });

  it('indexes members of an internal class by their own modifiers', async () => {
    const syms = await symbolsOf(
      `internal class Impl {\n  public void Run() {}\n  void Local() {}\n}\n`,
    );
    const names = syms.map((s) => s.name);
    expect(names).toContain('Impl.Run');
    expect(names).not.toContain('Impl.Local');
  });
});
