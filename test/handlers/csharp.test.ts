import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { csharpHandler } from '../../src/handlers/csharp.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, csharpHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('C# handler — extractSymbols', () => {
  it('extracts a public class', async () => {
    const src = `public class AuthService {\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'src/AuthService.cs');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('AuthService');
    expect(syms[0].kind).toBe('class');
    expect(syms[0].filePath).toBe('src/AuthService.cs');
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `public class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const sym = csharpHandler.extractSymbols(tree, buf, 'Foo.cs')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = csharpHandler.extractSymbols(tree, buf, 'Foo.cs')[0];
    expect(sym2.id).toBe(sym.id);
  });

  it('does NOT extract internal/private class', async () => {
    const src = `internal class InternalClass {}\nprivate class PrivateClass {}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Foo.cs');
    expect(syms).toHaveLength(0);
  });

  it('extracts a public interface', async () => {
    const src = `public interface IAuthenticator {\n    bool Authenticate(string u, string p);\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = csharpHandler.extractSymbols(tree, buf, 'IAuthenticator.cs')[0];
    expect(sym.name).toBe('IAuthenticator');
    expect(sym.kind).toBe('interface');
  });

  it('extracts a public enum', async () => {
    const src = `public enum Role {\n    Admin,\n    User\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = csharpHandler.extractSymbols(tree, buf, 'Role.cs')[0];
    expect(sym.name).toBe('Role');
    expect(sym.kind).toBe('enum');
  });

  it('extracts public struct as kind=class', async () => {
    const src = `public struct Point {\n    public int X;\n    public int Y;\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = csharpHandler.extractSymbols(tree, buf, 'Point.cs')[0];
    expect(sym.name).toBe('Point');
    expect(sym.kind).toBe('class');
  });

  it('extracts public record as kind=class', async () => {
    const src = `public record User(long Id, string Name);\n`;
    const { tree, buf } = await parse(src);
    const sym = csharpHandler.extractSymbols(tree, buf, 'User.cs')[0];
    expect(sym.name).toBe('User');
    expect(sym.kind).toBe('class');
  });

  it('extracts public methods as ClassName.MethodName', async () => {
    const src = `public class AuthService {\n    public bool Authenticate(string u) { return true; }\n    private void Cleanup() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'AuthService.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService.Authenticate');
    expect(names).not.toContain('AuthService.Cleanup');
  });

  it('extracts protected methods', async () => {
    const src = `public class Base {\n    protected void OnInit() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Base.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Base.OnInit');
  });

  it('extracts constructor as ClassName.ClassName', async () => {
    const src = `public class User {\n    public User(long id, string name) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'User.cs');
    const ctor = syms.find((s) => s.kind === 'method' && s.name === 'User.User');
    expect(ctor).toBeDefined();
  });

  it('extracts public property as kind=const', async () => {
    const src = `public class User {\n    public string Name { get; set; }\n    public int Age { get; }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'User.cs');
    const props = syms.filter((s) => s.kind === 'const');
    const names = props.map((s) => s.name);
    expect(names).toContain('User.Name');
    expect(names).toContain('User.Age');
  });

  it('extracts class inside namespace', async () => {
    const src = `namespace MyApp {\n    public class Service {\n    }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Service.cs');
    expect(syms.some((s) => s.name === 'Service')).toBe(true);
  });

  it('extracts class in file-scoped namespace', async () => {
    const src = `namespace MyApp;\npublic class Service {\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Service.cs');
    expect(syms.some((s) => s.name === 'Service')).toBe(true);
  });

  it('builds signature capped at 120 chars', async () => {
    const src = `public class LongSig {\n    public async Task<IEnumerable<VeryLongTypeName>> VeryLongMethodName(string paramOne, string paramTwo, int paramThree) { return null; }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'LongSig.cs');
    const method = syms.find((s) => s.kind === 'method');
    if (method) {
      expect(method.signature.length).toBeLessThanOrEqual(120);
    }
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('C# handler — extractDocstring', () => {
  it('captures /// <summary> XML doc comment', async () => {
    const src = `/// <summary>Manages authentication sessions.</summary>\npublic class AuthService {}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'AuthService.cs');
    expect(syms[0].summary).toContain('Manages authentication sessions');
  });

  it('captures multi-line /// <summary>', async () => {
    const src = `/// <summary>\n/// Manages auth.\n/// </summary>\npublic class AuthService {}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'AuthService.cs');
    expect(syms[0].summary).toContain('Manages auth');
  });

  it('captures plain /// comment without XML tags', async () => {
    const src = `/// Simple description.\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Foo.cs');
    expect(syms[0].summary).toContain('Simple description');
  });

  it('returns empty string when no doc comment', async () => {
    const src = `public class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Foo.cs');
    expect(syms[0].summary).toBe('');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('C# handler — extractImports', () => {
  it('extracts using directive', async () => {
    const src = `using System;\nusing System.Collections.Generic;\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const imports = csharpHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('System');
    expect(specifiers).toContain('System.Collections.Generic');
    imports.forEach((i) => expect(i.resolvedPath).toBeNull());
  });

  it('extracts using static directive', async () => {
    const src = `using static System.Console;\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const imports = csharpHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('System.Console');
  });

  it('extracts using inside namespace', async () => {
    const src = `namespace MyApp {\n    using System;\n    public class Foo {}\n}\n`;
    const { tree, buf } = await parse(src);
    const imports = csharpHandler.extractImports(tree, buf);
    expect(imports.some((i) => i.specifier === 'System')).toBe(true);
  });
});

// ─── Fixture-based test ───────────────────────────────────────────────────────

describe('C# handler — fixture files', () => {
  it('indexes csharp-project/src/AuthService.cs correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/csharp-project/src/AuthService.cs'));
    const tree = await parseFile(src, csharpHandler);
    const syms = csharpHandler.extractSymbols(tree, src, 'src/AuthService.cs');

    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService');
    expect(names).toContain('AuthService.Authenticate');
    expect(names).toContain('AuthService.StartSession');
    expect(names).toContain('AuthService.IsActive');
    expect(names).toContain('AuthService.EndSession');
    // Private method should not be indexed
    expect(names).not.toContain('AuthService.Cleanup');

    // XML doc comment captured
    const cls = syms.find((s) => s.name === 'AuthService');
    expect(cls!.summary).toContain('Manages user authentication sessions');
  });

  it('indexes csharp-project/src/IAuthenticator.cs correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/csharp-project/src/IAuthenticator.cs'));
    const tree = await parseFile(src, csharpHandler);
    const syms = csharpHandler.extractSymbols(tree, src, 'src/IAuthenticator.cs');

    const iface = syms.find((s) => s.kind === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.name).toBe('IAuthenticator');

    // Interface methods are implicitly public — should be extracted
    const names = syms.map((s) => s.name);
    expect(names).toContain('IAuthenticator.Authenticate');
    expect(names).toContain('IAuthenticator.IsActive');
  });

  it('indexes csharp-project/src/User.cs (record) correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/csharp-project/src/User.cs'));
    const tree = await parseFile(src, csharpHandler);
    const syms = csharpHandler.extractSymbols(tree, src, 'src/User.cs');

    const record = syms.find((s) => s.kind === 'class');
    expect(record).toBeDefined();
    expect(record!.name).toBe('User');
  });
});

// ─── Interface member extraction ──────────────────────────────────────────────

describe('C# handler — interface member extraction', () => {
  it('extracts interface methods without explicit public modifier', async () => {
    const src = `public interface IRepository {\n    Entity GetById(int id);\n    void Save(Entity entity);\n    void Delete(int id);\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'IRepository.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('IRepository');
    expect(names).toContain('IRepository.GetById');
    expect(names).toContain('IRepository.Save');
    expect(names).toContain('IRepository.Delete');
    const methods = syms.filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(3);
  });

  it('extracts interface properties', async () => {
    const src = `public interface IEntity {\n    int Id { get; }\n    string Name { get; set; }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'IEntity.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('IEntity.Id');
    expect(names).toContain('IEntity.Name');
  });

  it('extracts interface methods with XML doc comments', async () => {
    const src = `public interface IService {\n    /// <summary>Process the request.</summary>\n    void Process(string input);\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'IService.cs');
    const method = syms.find((s) => s.name === 'IService.Process');
    expect(method).toBeDefined();
    expect(method!.summary).toContain('Process the request');
  });

  it('does NOT extract private class methods but DOES extract interface methods', async () => {
    const src = `public class Impl {\n    private void Hidden() {}\n}\npublic interface IPublic {\n    void Visible();\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Mixed.cs');
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('Impl.Hidden');
    expect(names).toContain('IPublic.Visible');
  });
});

// ─── Event declaration extraction ────────────────────────────────────────────

describe('C# handler — event declaration extraction', () => {
  it('extracts event field declarations from classes as property kind', async () => {
    const src = `public class Button {\n    public event EventHandler Clicked;\n    public event EventHandler DataLoaded;\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'Button.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Button.Clicked');
    expect(names).toContain('Button.DataLoaded');
    const events = syms.filter((s) => s.kind === 'property');
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts event field declarations from interface declarations', async () => {
    const src = `public interface INotifier {\n    event EventHandler StateChanged;\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = csharpHandler.extractSymbols(tree, buf, 'INotifier.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('INotifier.StateChanged');
  });
});
