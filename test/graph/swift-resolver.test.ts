/**
 * Phase 103, Task 642 — Swift SwiftPM target mapping (module → target directory).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSwiftResolver,
  isSwiftSourceFile,
  parsePackageTargets,
} from '../../src/graph/swift-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'swifttest1';

function seedDb(root: string) {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: root,
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

const MANIFEST = `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "nio",
    products: [
        .library(name: "NIO", targets: ["NIOCore", "NIOPosix"]),
    ],
    targets: [
        .target(
            name: "NIOCore",
            dependencies: [
                "NIOConcurrencyHelpers",
                .target(name: "CNIOAtomics", condition: .when(platforms: [.linux])),
                .product(name: "Atomics", package: "swift-atomics"),
            ],
            swiftSettings: swiftSettings
        ),
        .target(name: "NIOConcurrencyHelpers"),
        .target(name: "CNIOAtomics", path: "Sources/CNIOAtomics"),
        .target(
            name: "NIOFS",
            dependencies: ["NIOCore"],
            path: "Sources/NIOFileSystem/"
        ),
        .executableTarget(name: "NIOEchoServer", dependencies: ["NIOCore"]),
        .binaryTarget(name: "Prebuilt", url: "https://x/y.zip", checksum: "abc"),
        .testTarget(
            name: "NIOCoreTests",
            dependencies: [.target(name: "NIOCore"), "NIOEmbedded"]
        ),
        .plugin(name: "GenPlugin", capability: .buildTool()),
    ]
)
`;

describe('parsePackageTargets', () => {
  it('reads top-level target declarations with default and explicit paths, skipping dependency references', () => {
    const targets = parsePackageTargets(MANIFEST);
    expect(targets).toEqual([
      { name: 'NIOCore', path: 'Sources/NIOCore', kind: 'target' },
      { name: 'NIOConcurrencyHelpers', path: 'Sources/NIOConcurrencyHelpers', kind: 'target' },
      { name: 'CNIOAtomics', path: 'Sources/CNIOAtomics', kind: 'target' },
      { name: 'NIOFS', path: 'Sources/NIOFileSystem', kind: 'target' },
      { name: 'NIOEchoServer', path: 'Sources/NIOEchoServer', kind: 'target' },
      { name: 'NIOCoreTests', path: 'Tests/NIOCoreTests', kind: 'test' },
      { name: 'GenPlugin', path: 'Plugins/GenPlugin', kind: 'plugin' },
    ]);
  });
  it('accepts .swift only', () => {
    expect(isSwiftSourceFile('Sources/A/x.swift')).toBe(true);
    expect(isSwiftSourceFile('Sources/A/x.c')).toBe(false);
  });
});

describe('createSwiftResolver', () => {
  let root: string;
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-swift-'));
    writeFileSync(join(root, 'Package.swift'), MANIFEST);
    mkdirSync(join(root, 'Examples', 'Demo'), { recursive: true });
    writeFileSync(
      join(root, 'Examples', 'Demo', 'Package.swift'),
      'let package = Package(name: "Demo", targets: [.target(name: "NIOCore"), .executableTarget(name: "DemoApp")])\n',
    );
    db = seedDb(root);
    for (const p of [
      'Package.swift',
      'Sources/NIOCore/Channel.swift',
      'Sources/NIOCore/ByteBuffer.swift',
      'Sources/NIOConcurrencyHelpers/Lock.swift',
      'Sources/CNIOAtomics/atomics.c',
      'Sources/CNIOAtomics/include/atomics.h',
      'Sources/NIOFileSystem/FileSystem.swift',
      'Sources/NIOEchoServer/main.swift',
      'Tests/NIOCoreTests/ChannelTests.swift',
      'Examples/Demo/Package.swift',
      'Examples/Demo/Sources/NIOCore/Shadow.swift',
      'Examples/Demo/Sources/DemoApp/main.swift',
      '.build/checkouts/swift-atomics/Sources/Atomics/Atomic.swift',
    ]) {
      upsertFile(db, REPO, p, 'h');
    }
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('maps a module to every indexed file of its target (package semantics)', () => {
    const r = createSwiftResolver(db, REPO, root);
    expect(r.resolve('NIOCore', 'Sources/NIOEchoServer/main.swift').sort()).toEqual([
      'Sources/NIOCore/ByteBuffer.swift',
      'Sources/NIOCore/Channel.swift',
    ]);
    // explicit path: and a C target
    expect(r.resolve('NIOFS', 'Sources/NIOCore/Channel.swift')).toEqual(['Sources/NIOFileSystem/FileSystem.swift']);
    expect(r.resolve('CNIOAtomics', 'Sources/NIOCore/Channel.swift').sort()).toEqual([
      'Sources/CNIOAtomics/atomics.c',
      'Sources/CNIOAtomics/include/atomics.h',
    ]);
    // `import struct Foundation.URL` shape → module is the first segment
    expect(r.resolve('NIOConcurrencyHelpers.Lock', 'Sources/NIOCore/Channel.swift')).toEqual([
      'Sources/NIOConcurrencyHelpers/Lock.swift',
    ]);
  });

  it('system modules, dependency packages and the importer\'s own module resolve to nothing', () => {
    const r = createSwiftResolver(db, REPO, root);
    expect(r.resolve('Foundation', 'Sources/NIOCore/Channel.swift')).toEqual([]);
    expect(r.resolve('Atomics', 'Sources/NIOCore/Channel.swift')).toEqual([]); // .build checkout is not a target
    expect(r.resolve('NIOCore', 'Sources/NIOCore/Channel.swift')).toEqual([]);
    expect(r.resolve('Nope', 'Sources/NIOCore/Channel.swift')).toEqual([]);
  });

  it('tests import production; production never resolves into a test target', () => {
    const r = createSwiftResolver(db, REPO, root);
    expect(r.resolve('NIOCore', 'Tests/NIOCoreTests/ChannelTests.swift').sort()).toEqual([
      'Sources/NIOCore/ByteBuffer.swift',
      'Sources/NIOCore/Channel.swift',
    ]);
    expect(r.resolve('NIOCoreTests', 'Sources/NIOCore/Channel.swift')).toEqual([]);
  });

  it('a nested package that redeclares a module name wins for its own importers only', () => {
    const r = createSwiftResolver(db, REPO, root);
    expect(r.resolve('NIOCore', 'Examples/Demo/Sources/DemoApp/main.swift')).toEqual([
      'Examples/Demo/Sources/NIOCore/Shadow.swift',
    ]);
    expect(r.resolve('NIOCore', 'Sources/NIOEchoServer/main.swift')).not.toContain(
      'Examples/Demo/Sources/NIOCore/Shadow.swift',
    );
  });

  it('without a manifest, Sources/<X>/ and Tests/<X>/ directories stand in for targets', () => {
    const db2 = seedDb(root + '-xcode');
    for (const p of ['Sources/App/App.swift', 'Sources/Core/Core.swift', 'Tests/CoreTests/CoreTests.swift']) {
      upsertFile(db2, REPO, p, 'h');
    }
    const r = createSwiftResolver(db2, REPO, root + '-xcode');
    expect(r.resolve('Core', 'Sources/App/App.swift')).toEqual(['Sources/Core/Core.swift']);
    expect(r.resolve('UIKit', 'Sources/App/App.swift')).toEqual([]);
    expect(r.resolve('Core', 'Tests/CoreTests/CoreTests.swift')).toEqual(['Sources/Core/Core.swift']);
    db2.close();
  });
});
