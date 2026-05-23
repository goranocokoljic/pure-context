import { describe, it, expect } from 'vitest';
import { protobufHandler } from '../../src/handlers/protobuf.js';
import type { Tree } from '../../src/core/types.js';

// protobuf handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Protobuf handler — extractSymbols', () => {

  // ── message → class ───────────────────────────────────────────────────────

  it('extracts message as kind "class"', () => {
    const { tree, buf } = parse(`
message User {
  string id = 1;
  string name = 2;
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'user.proto');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('message User');
  });

  // ── service → interface ──────────────────────────────────────────────────

  it('extracts service as kind "interface"', () => {
    const { tree, buf } = parse(`
service UserService {
  rpc GetUser(GetUserRequest) returns (User);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'service.proto');
    const svc = syms.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('interface');
    expect(svc!.signature).toContain('service UserService');
  });

  // ── rpc → method (nested inside service) ─────────────────────────────────

  it('extracts rpc methods as kind "method" with ServiceName.MethodName', () => {
    const { tree, buf } = parse(`
service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc CreateUser(CreateUserRequest) returns (User);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'service.proto');
    const getUser = syms.find((s) => s.name === 'UserService.GetUser');
    const createUser = syms.find((s) => s.name === 'UserService.CreateUser');
    expect(getUser).toBeDefined();
    expect(getUser!.kind).toBe('method');
    expect(getUser!.signature).toContain('rpc GetUser');
    expect(getUser!.signature).toContain('GetUserRequest');
    expect(getUser!.signature).toContain('User');
    expect(createUser).toBeDefined();
  });

  // ── rpc with streaming keywords ──────────────────────────────────────────

  it('extracts streaming rpc methods and includes stream keyword in signature', () => {
    const { tree, buf } = parse(`
service StreamService {
  rpc StreamData(Request) returns (stream Response);
  rpc UploadData(stream Request) returns (Summary);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'stream.proto');
    const streamData = syms.find((s) => s.name === 'StreamService.StreamData');
    expect(streamData).toBeDefined();
    expect(streamData!.signature).toContain('stream Response');
  });

  // ── enum → enum ───────────────────────────────────────────────────────────

  it('extracts enum as kind "enum"', () => {
    const { tree, buf } = parse(`
enum Status {
  UNKNOWN = 0;
  ACTIVE = 1;
  INACTIVE = 2;
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'status.proto');
    const sym = syms.find((s) => s.name === 'Status');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('enum');
    expect(sym!.signature).toContain('enum Status');
  });

  // ── extend → class with extend. prefix ────────────────────────────────────

  it('extracts extend block as kind "class" with extend.Name', () => {
    const { tree, buf } = parse(`
extend User {
  string email = 100;
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'extensions.proto');
    const sym = syms.find((s) => s.name === 'extend.User');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('extend User');
  });

  // ── preceding // comment as summary ─────────────────────────────────────

  it('uses preceding // comment as summary', () => {
    const { tree, buf } = parse(
      `// A user in the system.\nmessage User {\n  string id = 1;\n}\n`,
    );
    const syms = protobufHandler.extractSymbols(tree, buf, 'user.proto');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym!.summary).toContain('user in the system');
  });

  it('uses preceding // comment as summary for service', () => {
    const { tree, buf } = parse(
      `// Manages user accounts.\nservice UserService {\n  rpc GetUser(Request) returns (User);\n}\n`,
    );
    const syms = protobufHandler.extractSymbols(tree, buf, 'service.proto');
    const sym = syms.find((s) => s.name === 'UserService');
    expect(sym!.summary).toContain('Manages user accounts');
  });

  // ── deterministic ID ─────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`message Foo {\n  string bar = 1;\n}\n`);
    const sym = protobufHandler.extractSymbols(tree, buf, 'foo.proto')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = protobufHandler.extractSymbols(tree, buf, 'foo.proto')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple top-level definitions ───────────────────────────────────────

  it('extracts multiple top-level definitions from a single file', () => {
    const { tree, buf } = parse(`
syntax = "proto3";

message GetUserRequest {
  string id = 1;
}

message User {
  string id = 1;
  string name = 2;
}

enum UserStatus {
  UNKNOWN = 0;
  ACTIVE = 1;
}

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'user.proto');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GetUserRequest');
    expect(names).toContain('User');
    expect(names).toContain('UserStatus');
    expect(names).toContain('UserService');
    expect(names).toContain('UserService.GetUser');
  });

  // ── frameworkMeta.serviceName on RPC methods ─────────────────────────────

  it('stores serviceName in frameworkMeta for rpc methods', () => {
    const { tree, buf } = parse(`
service Spanner {
  rpc Read(ReadRequest) returns (ResultSet);
  rpc Commit(CommitRequest) returns (CommitResponse);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'spanner.proto');
    const read = syms.find((s) => s.name === 'Spanner.Read');
    const commit = syms.find((s) => s.name === 'Spanner.Commit');
    expect(read!.frameworkMeta?.['serviceName']).toBe('Spanner');
    expect(commit!.frameworkMeta?.['serviceName']).toBe('Spanner');
  });

  it('service symbols do not have frameworkMeta.serviceName', () => {
    const { tree, buf } = parse(`
service MyService {
  rpc Foo(FooReq) returns (FooResp);
}
`);
    const syms = protobufHandler.extractSymbols(tree, buf, 'svc.proto');
    const svc = syms.find((s) => s.name === 'MyService');
    expect(svc!.frameworkMeta).toBeUndefined();
  });

  // ── byte offsets are set ─────────────────────────────────────────────────

  it('sets non-zero startByte and endByte', () => {
    const { tree, buf } = parse(`\nmessage Foo {\n  string x = 1;\n}\n`);
    const sym = protobufHandler.extractSymbols(tree, buf, 'foo.proto')[0]!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Protobuf handler — extractImports', () => {

  it('extracts import statements', () => {
    const { tree, buf } = parse(`
syntax = "proto3";
import "google/protobuf/timestamp.proto";
import "other_service.proto";
`);
    const imports = protobufHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('google/protobuf/timestamp.proto');
    expect(specs).toContain('other_service.proto');
  });

  it('marks well-known imports as external (resolvedPath null)', () => {
    const { tree, buf } = parse(`import "google/protobuf/timestamp.proto";\n`);
    const imports = protobufHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('marks relative imports with resolvedPath', () => {
    const { tree, buf } = parse(`import "./models/user.proto";\n`);
    const imports = protobufHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBe('./models/user.proto');
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(
      `import "common.proto";\nimport "common.proto";\n`,
    );
    const imports = protobufHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for files with no imports', () => {
    const { tree, buf } = parse(`message Foo {\n  string bar = 1;\n}\n`);
    expect(protobufHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
