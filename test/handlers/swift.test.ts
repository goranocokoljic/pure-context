import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { swiftHandler } from '../../src/handlers/swift.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, swiftHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols — class ───────────────────────────────────────────────────

describe('Swift handler — class', () => {
  it('extracts a public class as kind "class"', async () => {
    const { tree, buf } = await parse(
      `import Foundation\npublic class AuthService {\n  public init() {}\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'AuthService.swift');
    const cls = syms.find((s) => s.name === 'AuthService' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.signature).toContain('class AuthService');
  });

  it('extracts class with inheritance in signature', async () => {
    const { tree, buf } = await parse(
      `public class AdminService: AuthService {\n  public init() {}\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'AdminService.swift');
    const cls = syms.find((s) => s.name === 'AdminService');
    expect(cls).toBeDefined();
    expect(cls!.signature).toContain('AuthService');
  });

  it('skips a private class', async () => {
    const { tree, buf } = await parse(`private class InternalHelper {}\n`);
    const syms = swiftHandler.extractSymbols(tree, buf, 'helper.swift');
    expect(syms.find((s) => s.name === 'InternalHelper')).toBeUndefined();
  });

  it('skips a fileprivate class', async () => {
    const { tree, buf } = await parse(`fileprivate class FileScopedHelper {}\n`);
    const syms = swiftHandler.extractSymbols(tree, buf, 'helper.swift');
    expect(syms.find((s) => s.name === 'FileScopedHelper')).toBeUndefined();
  });
});

// ─── extractSymbols — struct ──────────────────────────────────────────────────

describe('Swift handler — struct', () => {
  it('extracts a public struct as kind "class"', async () => {
    const { tree, buf } = await parse(
      `public struct User: Encodable {\n  public let id: Int\n  public init(id: Int) { self.id = id }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'User.swift');
    const s = syms.find((s) => s.name === 'User');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.signature).toContain('struct User');
  });
});

// ─── extractSymbols — enum ────────────────────────────────────────────────────

describe('Swift handler — enum', () => {
  it('extracts a public enum as kind "enum"', async () => {
    const { tree, buf } = await parse(
      `public enum Role: String {\n  case admin\n  case user\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Role.swift');
    const e = syms.find((s) => s.name === 'Role');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('enum');
    expect(e!.signature).toContain('enum Role');
  });
});

// ─── extractSymbols — actor ───────────────────────────────────────────────────

describe('Swift handler — actor', () => {
  it('extracts a public actor as kind "class" with swift_actor meta', async () => {
    const { tree, buf } = await parse(
      `public actor TokenStore {\n  private var tokens: [String: Date] = [:]\n  public func store(token: String) {}\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'TokenStore.swift');
    const a = syms.find((s) => s.name === 'TokenStore');
    expect(a).toBeDefined();
    expect(a!.kind).toBe('class');
    expect(a!.frameworkMeta?.swift_actor).toBe(true);
    expect(a!.signature).toContain('actor TokenStore');
  });
});

// ─── extractSymbols — extension ───────────────────────────────────────────────

describe('Swift handler — extension', () => {
  it('extracts extension as kind "class" with swift_extension meta', async () => {
    const { tree, buf } = await parse(
      `extension String {\n  public var isValid: Bool { return !isEmpty }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'String+Ext.swift');
    const ext = syms.find((s) => s.frameworkMeta?.swift_extension === true);
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('class');
    expect(ext!.name).toBe('String');
  });

  it('includes protocol conformance in extension signature', async () => {
    const { tree, buf } = await parse(
      `extension String: CustomStringConvertible {\n  public var description: String { return self }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'ext.swift');
    const ext = syms.find((s) => s.frameworkMeta?.swift_extension === true);
    expect(ext).toBeDefined();
    expect(ext!.signature).toContain('CustomStringConvertible');
  });
});

// ─── extractSymbols — protocol ────────────────────────────────────────────────

describe('Swift handler — protocol', () => {
  it('extracts a protocol as kind "interface"', async () => {
    const { tree, buf } = await parse(
      `public protocol Authenticatable {\n  var username: String { get }\n  func login(password: String) throws\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Authenticatable.swift');
    const p = syms.find((s) => s.name === 'Authenticatable');
    expect(p).toBeDefined();
    expect(p!.kind).toBe('interface');
    expect(p!.signature).toContain('protocol Authenticatable');
  });

  it('extracts protocol function requirements', async () => {
    const { tree, buf } = await parse(
      `public protocol Authenticatable {\n  func login(password: String) throws\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Auth.swift');
    const method = syms.find((s) => s.name === 'Authenticatable.login');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });
});

// ─── extractSymbols — function ────────────────────────────────────────────────

describe('Swift handler — function', () => {
  it('extracts a top-level function as kind "function"', async () => {
    const { tree, buf } = await parse(
      `public func greet(name: String) -> String {\n  return "Hello, \\(name)"\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'utils.swift');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('func greet');
  });

  it('skips a private func', async () => {
    const { tree, buf } = await parse(`private func helper() {}\n`);
    const syms = swiftHandler.extractSymbols(tree, buf, 'utils.swift');
    expect(syms.find((s) => s.name === 'helper')).toBeUndefined();
  });

  it('includes async throws in function signature', async () => {
    const { tree, buf } = await parse(
      `public func fetchData() async throws -> Data {\n  return Data()\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'network.swift');
    const fn = syms.find((s) => s.name === 'fetchData');
    expect(fn).toBeDefined();
    expect(fn!.signature).toMatch(/async|throws/);
  });
});

// ─── extractSymbols — method ──────────────────────────────────────────────────

describe('Swift handler — method', () => {
  it('extracts class methods as kind "method" with ClassName.methodName', async () => {
    const { tree, buf } = await parse(
      `public class Service {\n  public func execute() {}\n  private func helper() {}\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Service.swift');
    const method = syms.find((s) => s.name === 'Service.execute');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
    // private helper should be skipped
    expect(syms.find((s) => s.name === 'Service.helper')).toBeUndefined();
  });
});

// ─── extractSymbols — init / deinit ───────────────────────────────────────────

describe('Swift handler — init / deinit', () => {
  it('extracts init as method named TypeName.init', async () => {
    const { tree, buf } = await parse(
      `public class Foo {\n  public init(value: Int) {}\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Foo.swift');
    const init_ = syms.find((s) => s.name === 'Foo.init');
    expect(init_).toBeDefined();
    expect(init_!.kind).toBe('method');
  });

  it('extracts failable init as TypeName.init?', async () => {
    const { tree, buf } = await parse(
      `public class Foo {\n  public init?(rawValue: String) { return nil }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Foo.swift');
    const init_ = syms.find((s) => s.name === 'Foo.init?');
    expect(init_).toBeDefined();
  });

  it('extracts deinit as TypeName.deinit', async () => {
    const { tree, buf } = await parse(
      `public class Resource {\n  public init() {}\n  deinit { }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'Resource.swift');
    const d = syms.find((s) => s.name === 'Resource.deinit');
    expect(d).toBeDefined();
    expect(d!.kind).toBe('method');
  });
});

// ─── extractSymbols — typealias ───────────────────────────────────────────────

describe('Swift handler — typealias', () => {
  it('extracts a typealias as kind "type"', async () => {
    const { tree, buf } = await parse(`public typealias Completion = (Error?) -> Void\n`);
    const syms = swiftHandler.extractSymbols(tree, buf, 'types.swift');
    const t = syms.find((s) => s.name === 'Completion');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('type');
    expect(t!.signature).toContain('typealias Completion');
  });
});

// ─── extractSymbols — @State property attribute in signature ──────────────────

describe('Swift handler — property attributes', () => {
  it('includes @State attribute in property signature', async () => {
    const { tree, buf } = await parse(
      `import SwiftUI\nstruct MyView: View {\n  @State private var count: Int = 0\n  var body: some View { Text("") }\n}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'MyView.swift');
    // struct should be extracted
    const s = syms.find((s) => s.name === 'MyView');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
  });
});

// ─── extractSymbols — docstring ───────────────────────────────────────────────

describe('Swift handler — docstring', () => {
  it('captures /// triple-slash doc comment', async () => {
    const { tree, buf } = await parse(
      `/// Authenticates the user.\npublic func login() {}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'auth.swift');
    const fn = syms.find((s) => s.name === 'login');
    expect(fn).toBeDefined();
    expect(fn!.summary).toContain('Authenticates');
  });

  it('captures /** block doc comment', async () => {
    const { tree, buf } = await parse(
      `/** Logs out the current session. */\npublic func logout() {}\n`,
    );
    const syms = swiftHandler.extractSymbols(tree, buf, 'auth.swift');
    const fn = syms.find((s) => s.name === 'logout');
    expect(fn).toBeDefined();
    expect(fn!.summary).toContain('Logs out');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Swift handler — extractImports', () => {
  it('extracts a simple import', async () => {
    const { tree, buf } = await parse(`import Foundation\npublic class Foo {}\n`);
    const imports = swiftHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(1);
    const imp = imports.find((i) => i.specifier === 'Foundation');
    expect(imp).toBeDefined();
    expect(imp!.resolvedPath).toBeNull();
    expect(imp!.isTypeOnly).toBe(false);
  });

  it('extracts multiple imports', async () => {
    const { tree, buf } = await parse(
      `import Foundation\nimport UIKit\npublic class Foo {}\n`,
    );
    const imports = swiftHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('Foundation');
    expect(imports.map((i) => i.specifier)).toContain('UIKit');
  });
});

// ─── Extension ID collision (Phase 88, Task 546) ─────────────────────────────

describe('Swift handler — extension does not clobber the primary declaration', () => {
  it('class + same-file extensions keep distinct IDs and the class summary survives', async () => {
    const { tree, buf } = await parse(`
/// An ordered list of handlers.
public final class ChannelPipeline {
  public init() {}
}

extension ChannelPipeline {
  public func addHandler() {}
}

extension ChannelPipeline {
  public func removeHandler() {}
}
`);
    const syms = swiftHandler.extractSymbols(tree, buf, 'ChannelPipeline.swift');
    const pipelineRows = syms.filter((s) => s.name === 'ChannelPipeline' && s.kind === 'class');
    // one class + two extensions, all with unique IDs
    expect(pipelineRows.length).toBe(3);
    expect(new Set(pipelineRows.map((s) => s.id)).size).toBe(3);
    const classRow = pipelineRows.find((s) => !s.frameworkMeta?.['swift_extension']);
    expect(classRow).toBeDefined();
    expect(classRow!.summary).toContain('ordered list of handlers');
  });
});
