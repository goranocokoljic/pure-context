import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { javaHandler } from '../../src/handlers/java.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, javaHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Java handler — extractSymbols', () => {
  it('extracts a public class', async () => {
    const src = `public class AuthService {\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'src/AuthService.java');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('AuthService');
    expect(syms[0].kind).toBe('class');
    expect(syms[0].filePath).toBe('src/AuthService.java');
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `public class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const sym = javaHandler.extractSymbols(tree, buf, 'Foo.java')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = javaHandler.extractSymbols(tree, buf, 'Foo.java')[0];
    expect(sym2.id).toBe(sym.id);
  });

  it('does NOT extract package-private class', async () => {
    const src = `class PackagePrivate {}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Foo.java');
    expect(syms).toHaveLength(0);
  });

  it('extracts a public interface', async () => {
    const src = `public interface IAuthenticator {\n    boolean authenticate(String u, String p);\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = javaHandler.extractSymbols(tree, buf, 'IAuthenticator.java')[0];
    expect(sym.name).toBe('IAuthenticator');
    expect(sym.kind).toBe('interface');
  });

  it('extracts a public enum', async () => {
    const src = `public enum Role {\n    ADMIN, USER\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = javaHandler.extractSymbols(tree, buf, 'Role.java')[0];
    expect(sym.name).toBe('Role');
    expect(sym.kind).toBe('enum');
  });

  it('extracts public methods as ClassName.methodName', async () => {
    const src = `public class AuthService {\n    public boolean authenticate(String u) {\n        return true;\n    }\n    private void cleanup() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'AuthService.java');
    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService.authenticate');
    expect(names).not.toContain('AuthService.cleanup');
  });

  it('private methods are NOT indexed', async () => {
    const src = `public class Svc {\n    public void pub() {}\n    private void priv() {}\n    protected void prot() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Svc.java');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Svc.pub');
    expect(names).toContain('Svc.prot');
    expect(names).not.toContain('Svc.priv');
  });

  it('extracts constructor as ClassName.ClassName', async () => {
    const src = `public class User {\n    public User(long id, String name) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'User.java');
    const names = syms.map((s) => s.name);
    expect(names).toContain('User.User');
    const ctor = syms.find((s) => s.name === 'User.User');
    expect(ctor!.kind).toBe('method');
  });

  it('extracts public static final field as kind=const', async () => {
    const src = `public class Config {\n    public static final int MAX_RETRIES = 3;\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Config.java');
    const constant = syms.find((s) => s.kind === 'const');
    expect(constant).toBeDefined();
    expect(constant!.name).toContain('MAX_RETRIES');
  });

  it('does NOT extract non-static or non-final fields as const', async () => {
    const src = `public class Svc {\n    public String name;\n    public static String shared;\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Svc.java');
    const consts = syms.filter((s) => s.kind === 'const');
    expect(consts).toHaveLength(0);
  });

  it('builds signature capped at 120 chars', async () => {
    const src = `public class LongSig {\n    public <T extends Comparable<T>> Map<String, List<T>> veryLongMethodName(String paramOne, String paramTwo, int paramThree) { return null; }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'LongSig.java');
    const method = syms.find((s) => s.kind === 'method');
    if (method) {
      expect(method.signature.length).toBeLessThanOrEqual(120);
    }
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Java handler — extractDocstring', () => {
  it('captures Javadoc /** */ comment', async () => {
    const src = `/** Authenticate a user with credentials. */\npublic class AuthService {}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'AuthService.java');
    expect(syms[0].summary).toContain('Authenticate a user with credentials');
  });

  it('captures multi-line Javadoc', async () => {
    const src = `/**\n * Service for auth.\n * Provides login and logout.\n */\npublic class AuthService {}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'AuthService.java');
    expect(syms[0].summary).toContain('Service for auth');
  });

  it('ignores regular /* */ block comments (non-Javadoc)', async () => {
    const src = `/* not javadoc */\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Foo.java');
    expect(syms[0].summary).toBe('');
  });

  it('returns empty string when no comment', async () => {
    const src = `public class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = javaHandler.extractSymbols(tree, buf, 'Foo.java');
    expect(syms[0].summary).toBe('');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Java handler — extractImports', () => {
  it('extracts regular import', async () => {
    const src = `import java.util.HashMap;\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const imports = javaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('java.util.HashMap');
    expect(imports[0].importedNames).toContain('HashMap');
    expect(imports[0].resolvedPath).toBeNull();
  });

  it('extracts wildcard import', async () => {
    const src = `import java.util.*;\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const imports = javaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('java.util');
    expect(imports[0].importedNames).toContain('*');
  });

  it('extracts static import', async () => {
    const src = `import static java.util.Objects.requireNonNull;\npublic class Foo {}\n`;
    const { tree, buf } = await parse(src);
    const imports = javaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('java.util.Objects');
    expect(imports[0].importedNames).toContain('requireNonNull');
  });
});

// ─── Fixture-based test ───────────────────────────────────────────────────────

describe('Java handler — fixture files', () => {
  it('indexes java-project/src/AuthService.java correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/java-project/src/AuthService.java'));
    const tree = await parseFile(src, javaHandler);
    const syms = javaHandler.extractSymbols(tree, src, 'src/AuthService.java');

    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService');
    expect(names).toContain('AuthService.authenticate');
    expect(names).toContain('AuthService.startSession');
    expect(names).toContain('AuthService.isActive');
    expect(names).toContain('AuthService.endSession');
    expect(names).not.toContain('AuthService.cleanup');

    // Javadoc captured (first sentence of the Javadoc)
    const cls = syms.find((s) => s.name === 'AuthService');
    expect(cls!.summary).toContain('Service responsible for managing user authentication sessions');
  });

  it('indexes java-project/src/IAuthenticator.java correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/java-project/src/IAuthenticator.java'));
    const tree = await parseFile(src, javaHandler);
    const syms = javaHandler.extractSymbols(tree, src, 'src/IAuthenticator.java');

    const iface = syms.find((s) => s.kind === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.name).toBe('IAuthenticator');
  });

  it('indexes java-project/src/Role.java correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/java-project/src/Role.java'));
    const tree = await parseFile(src, javaHandler);
    const syms = javaHandler.extractSymbols(tree, src, 'src/Role.java');

    const enumSym = syms.find((s) => s.kind === 'enum');
    expect(enumSym).toBeDefined();
    expect(enumSym!.name).toBe('Role');
  });
});
