/**
 * Phase 94 (Task 587 / A-12) — multi-adapter integration: angular + nestjs
 * active in ONE repo, real bootstrap order (angular registers before nestjs
 * and wins the shared `.service.ts`/`.guard.ts` suffixes).
 *
 * Asserts each framework's files are classified by its own adapter:
 *   - the Angular component is upgraded (kind component + selector),
 *   - the NestJS service keeps kind class with ZERO angular_* metadata
 *     (the shadow guard), and
 *   - NestJS route extraction still works for files angular does not claim
 *     (.controller.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { angularAdapter } from '../../src/adapters/angular.js';
import { nestjsAdapter } from '../../src/adapters/nestjs.js';

let repoRoot: string;
let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();

  repoRoot = join(tmpdir(), `purecontext-ng-nest-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(repoRoot, 'apps', 'web', 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'api', 'src'), { recursive: true });

  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    dependencies: { '@angular/core': '^17.0.0', '@nestjs/common': '^10.0.0' },
  }));

  writeFileSync(join(repoRoot, 'apps', 'web', 'src', 'home.component.ts'), `
import { Component } from '@angular/core';

@Component({ selector: 'app-home', template: '<h1>Home</h1>' })
export class HomeComponent {}
`);

  writeFileSync(join(repoRoot, 'apps', 'api', 'src', 'orders.service.ts'), `
import { Injectable } from '@nestjs/common';

@Injectable()
export class OrdersService {
  findAll(): string[] { return []; }
}
`);

  writeFileSync(join(repoRoot, 'apps', 'api', 'src', 'orders.controller.ts'), `
import { Controller, Get } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Get(':id')
  findOne(): string { return 'x'; }
}
`);

  // Real bootstrap order: angular BEFORE nestjs.
  const result = await indexFolder(repoRoot, {
    adapters: [angularAdapter, nestjsAdapter],
  });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('angular + nestjs in one repo', () => {
  it('the Angular component is upgraded by the angular adapter', () => {
    const db = openDatabase(repoId);
    const rows = searchSymbols(db, repoId, 'HomeComponent', { limit: 10 });
    db.close();
    const comp = rows.find((s) => s.name === 'HomeComponent');
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe('component');
    expect(comp!.frameworkMeta?.selector).toBe('app-home');
  });

  it('the NestJS service keeps kind class with zero angular metadata', () => {
    const db = openDatabase(repoId);
    const rows = searchSymbols(db, repoId, 'OrdersService', { limit: 10 });
    db.close();
    const svc = rows.find((s) => s.name === 'OrdersService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    const meta = svc!.frameworkMeta ?? {};
    for (const key of Object.keys(meta)) {
      expect(key.startsWith('angular_'), `unexpected ${key}`).toBe(false);
    }
  });

  it('NestJS route extraction still works for .controller.ts files', () => {
    const db = openDatabase(repoId);
    const routes = searchSymbols(db, repoId, '', { kind: 'route', limit: 50 });
    db.close();
    expect(routes.some((s) => s.name.includes('orders'))).toBe(true);
  });

  it('exactly ONE row exists for each class (no duplicates)', () => {
    const db = openDatabase(repoId);
    const all = searchSymbols(db, repoId, '', { limit: 200 });
    db.close();
    for (const name of ['HomeComponent', 'OrdersService', 'OrdersController']) {
      expect(all.filter((s) => s.name === name), name).toHaveLength(1);
    }
  });
});
