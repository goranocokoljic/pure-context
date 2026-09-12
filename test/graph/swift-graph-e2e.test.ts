/**
 * Phase 103, Task 642 / 645 — Swift cross-target edges end to end.
 *
 * A SwiftPM package with two targets, a test target and a `#if canImport`
 * import goes through the full indexFolder pipeline (worker path); edges must
 * cross targets, never dangle, and never point from production into tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { swiftHandler } from '../../src/handlers/swift.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function allEdges(): Array<[string, string]> {
  const db = openDatabase(repoId);
  const rows = db
    .prepare<[string], { source_file: string; target_file: string }>(
      'SELECT source_file, target_file FROM dep_edges WHERE repo_id = ? AND target_repo_id IS NULL',
    )
    .all(repoId);
  db.close();
  return rows
    .map((r) => [r.source_file.replace(/\\/g, '/'), r.target_file.replace(/\\/g, '/')] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function edgesFrom(source: string): string[] {
  return allEdges().filter(([s]) => s === source).map(([, t]) => t).sort();
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(swiftHandler);
  await initParser();
  root = resolve(mkdtempSync(join(tmpdir(), 'pc-swift-e2e-')));

  write(
    'Package.swift',
    [
      '// swift-tools-version:5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "demo",',
      '    targets: [',
      '        .target(name: "Core"),',
      '        .target(name: "App", dependencies: [.target(name: "Core")], path: "Sources/Application"),',
      '        .testTarget(name: "CoreTests", dependencies: ["Core"]),',
      '    ]',
      ')',
      '',
    ].join('\n'),
  );
  write('Sources/Core/Engine.swift', 'import Foundation\n\npublic struct Engine {\n    public init() {}\n    public func run() {}\n}\n');
  write('Sources/Core/Config.swift', 'public struct Config {\n    public var name: String\n}\n');
  write(
    'Sources/Application/main.swift',
    'import Core\n#if canImport(Darwin)\nimport Darwin\n#endif\n\nlet engine = Engine()\nengine.run()\n',
  );
  write('Sources/Application/Helpers.swift', 'import struct Core.Config\n\nfunc describe(_ c: Config) -> String { c.name }\n');
  write('Tests/CoreTests/EngineTests.swift', 'import XCTest\n@testable import Core\n\nfinal class EngineTests: XCTestCase {\n    func testRun() { Engine().run() }\n}\n');

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 120_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Swift cross-target edges end to end (Task 642)', () => {
  it('edges cross targets and none dangle', () => {
    const edges = allEdges();
    expect(edges.length).toBeGreaterThan(0);
    const db = openDatabase(repoId);
    const files = new Set(
      db.prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?').all(repoId)
        .map((r) => r.path.replace(/\\/g, '/')),
    );
    db.close();
    for (const [, t] of edges) expect(files.has(t)).toBe(true);
  });

  it('import Core → every file of the Core target; system modules make no edge', () => {
    expect(edgesFrom('Sources/Application/main.swift')).toEqual(['Sources/Core/Config.swift', 'Sources/Core/Engine.swift']);
    expect(edgesFrom('Sources/Application/Helpers.swift')).toEqual(['Sources/Core/Config.swift', 'Sources/Core/Engine.swift']);
    expect(edgesFrom('Sources/Core/Engine.swift')).toEqual([]);
  });

  it('@testable import from the test target resolves; production never imports tests', () => {
    expect(edgesFrom('Tests/CoreTests/EngineTests.swift')).toEqual(['Sources/Core/Config.swift', 'Sources/Core/Engine.swift']);
    for (const [s, t] of allEdges()) if (!s.startsWith('Tests/')) expect(t.startsWith('Tests/')).toBe(false);
  });

  it('blast radius of Engine reaches the app target and the tests', () => {
    const db = openDatabase(repoId);
    const sym = db
      .prepare<[string, string], { id: string }>('SELECT id FROM symbols WHERE repo_id = ? AND name = ?')
      .get(repoId, 'Engine');
    expect(sym).toBeDefined();
    const radius = getBlastRadius(sym!.id, repoId, db, 3);
    db.close();
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('Sources/Application/main.swift');
    expect(files).toContain('Tests/CoreTests/EngineTests.swift');
  });
});
