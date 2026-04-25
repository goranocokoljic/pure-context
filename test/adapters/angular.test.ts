import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { angularAdapter } from '../../src/adapters/angular.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';
import { readFileSync } from 'fs';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/angular-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

async function parseTs(source: string) {
  const b = buf(source);
  const tree = await parseFile(b, typescriptHandler);
  return { tree, buf: b };
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-angular-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

beforeEach(() => {
  resetAdapters();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('angularAdapter metadata', () => {
  it('has name "angular"', () => {
    expect(angularAdapter.name).toBe('angular');
  });

  it('declares no extra extensions', () => {
    expect(angularAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('angularAdapter.detect', () => {
  it('detects @angular/core in dependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@angular/core': '^17.0.0' },
    }));
    expect(await angularAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when @angular/core is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }));
    expect(await angularAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for missing package.json', async () => {
    const dir = tmpDir();
    expect(await angularAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture angular project', async () => {
    expect(await angularAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ─────────────────────────────────────────────────────────────

describe('angularAdapter.fileFilter', () => {
  it('accepts .component.ts files', () => {
    expect(angularAdapter.fileFilter('src/app/home.component.ts')).toBe(true);
  });

  it('accepts .service.ts files', () => {
    expect(angularAdapter.fileFilter('src/app/auth.service.ts')).toBe(true);
  });

  it('accepts .module.ts files', () => {
    expect(angularAdapter.fileFilter('src/app/app.module.ts')).toBe(true);
  });

  it('accepts .guard.ts files', () => {
    expect(angularAdapter.fileFilter('src/auth/auth.guard.ts')).toBe(true);
  });

  it('accepts .pipe.ts files', () => {
    expect(angularAdapter.fileFilter('src/shared/date-format.pipe.ts')).toBe(true);
  });

  it('accepts .directive.ts files', () => {
    expect(angularAdapter.fileFilter('src/shared/tooltip.directive.ts')).toBe(true);
  });

  it('accepts -routing.module.ts files', () => {
    expect(angularAdapter.fileFilter('src/app/app-routing.module.ts')).toBe(true);
  });

  it('rejects plain .ts files', () => {
    expect(angularAdapter.fileFilter('src/utils/helpers.ts')).toBe(false);
  });

  it('rejects .spec.ts files', () => {
    expect(angularAdapter.fileFilter('src/app/app.spec.ts')).toBe(false);
  });
});

// ─── @Component extraction ────────────────────────────────────────────────────

describe('angularAdapter — @Component', () => {
  it('emits component symbol with selector', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: '<h1>Home</h1>'
})
export class HomeComponent {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/home.component.ts');
    expect(symbols).toHaveLength(1);
    const sym = symbols[0]!;
    expect(sym.name).toBe('HomeComponent');
    expect(sym.kind).toBe('component');
    expect(sym.frameworkMeta?.selector).toBe('app-home');
  });

  it('emits component from fixture app.component.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app.component.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app/app.component.ts',
    );
    const comp = symbols.find((s) => s.name === 'AppComponent');
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe('component');
    expect(comp!.frameworkMeta?.selector).toBe('app-root');
  });
});

// ─── @Injectable extraction ───────────────────────────────────────────────────

describe('angularAdapter — @Injectable', () => {
  it('emits class symbol for @Injectable service', async () => {
    const source = `
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UserService {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/user.service.ts');
    expect(symbols).toHaveLength(1);
    const sym = symbols[0]!;
    expect(sym.name).toBe('UserService');
    expect(sym.kind).toBe('class');
    expect(sym.frameworkMeta?.angular_service).toBe(true);
    expect(sym.frameworkMeta?.angular_injectable).toBe(true);
  });

  it('emits class symbol from fixture auth.service.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/auth.service.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app/auth.service.ts',
    );
    const svc = symbols.find((s) => s.name === 'AuthService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.angular_service).toBe(true);
  });
});

// ─── @NgModule extraction ─────────────────────────────────────────────────────

describe('angularAdapter — @NgModule', () => {
  it('emits class symbol for @NgModule', async () => {
    const source = `
import { NgModule } from '@angular/core';

@NgModule({
  declarations: [],
  imports: []
})
export class FeatureModule {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/feature/feature.module.ts');
    const mod = symbols.find((s) => s.name === 'FeatureModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
    expect(mod!.frameworkMeta?.angular_module).toBe(true);
  });

  it('emits class symbol from fixture app.module.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app.module.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app/app.module.ts',
    );
    const mod = symbols.find((s) => s.name === 'AppModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
    expect(mod!.frameworkMeta?.angular_module).toBe(true);
  });
});

// ─── CanActivate guard extraction ─────────────────────────────────────────────

describe('angularAdapter — CanActivate guard', () => {
  it('emits middleware symbol for class implementing CanActivate', async () => {
    const source = `
import { Injectable, CanActivate, ExecutionContext } from '@angular/core';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/auth/auth.guard.ts');
    const guard = symbols.find((s) => s.name === 'AuthGuard');
    expect(guard).toBeDefined();
    expect(guard!.kind).toBe('middleware');
    expect(guard!.frameworkMeta?.angular_guard).toBe(true);
  });
});

// ─── Angular route extraction ─────────────────────────────────────────────────

describe('angularAdapter — route extraction', () => {
  it('extracts route paths from RouterModule.forRoot (inline array)', async () => {
    const source = `
import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@NgModule({
  imports: [RouterModule.forRoot([
    { path: 'home', component: HomeComponent },
    { path: 'about', component: AboutComponent },
  ])],
  exports: [RouterModule]
})
export class AppRoutingModule {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app/app-routing.module.ts',
    );
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/home');
    expect(routeNames).toContain('/about');
  });

  it('extracts NgModule class from fixture app-routing.module.ts', async () => {
    // Note: the fixture uses `forRoot(routes)` with a variable reference.
    // Route path extraction requires an inline array; the fixture tests class extraction.
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app-routing.module.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app/app-routing.module.ts',
    );
    const mod = symbols.find((s) => s.name === 'AppRoutingModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
    expect(mod!.frameworkMeta?.angular_module).toBe(true);
  });

  it('extracts routes from RouterModule.forChild (inline array)', async () => {
    const source = `
import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@NgModule({
  imports: [RouterModule.forChild([
    { path: 'list', component: ListComponent },
    { path: ':id', component: DetailComponent },
  ])],
  exports: [RouterModule]
})
export class UsersRoutingModule {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/users/users-routing.module.ts',
    );
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/list');
    expect(routeNames).toContain('/:id');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('angularAdapter.enrichMetadata', () => {
  it('adds angular_injectable flag to class symbols in .service.ts files', () => {
    const sym = {
      id: 'abc',
      name: 'UserService',
      kind: 'class' as const,
      filePath: 'src/app/user.service.ts',
      startByte: 0,
      endByte: 0,
      signature: 'class UserService',
      summary: '',
      frameworkMeta: {},
    };
    const enriched = angularAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.angular_injectable).toBe(true);
  });

  it('skips enrichment when angular_service is already set (already enriched by extractor)', () => {
    // enrichMetadata only acts on symbols where angular_service is NOT yet set.
    // Symbols extracted by the adapter already have both flags; this guards against double-runs.
    const sym = {
      id: 'abc',
      name: 'AuthService',
      kind: 'class' as const,
      filePath: 'src/app/auth.service.ts',
      startByte: 0,
      endByte: 0,
      signature: 'class AuthService',
      summary: '',
      frameworkMeta: { angular_service: true, angular_injectable: true },
    };
    const enriched = angularAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.angular_service).toBe(true);
    expect(enriched.frameworkMeta?.angular_injectable).toBe(true);
  });

  it('does not add flag to non-service class files', () => {
    const sym = {
      id: 'abc',
      name: 'AppModule',
      kind: 'class' as const,
      filePath: 'src/app/app.module.ts',
      startByte: 0,
      endByte: 0,
      signature: 'class AppModule',
      summary: '',
      frameworkMeta: { angular_module: true },
    };
    const enriched = angularAdapter.enrichMetadata!(sym);
    expect(enriched.frameworkMeta?.angular_injectable).toBeUndefined();
  });
});

// ─── Null tree fallback ───────────────────────────────────────────────────────

describe('angularAdapter — null tree (text-only mode)', () => {
  it('extracts routes even without AST', async () => {
    const source = `
RouterModule.forRoot([
  { path: 'dashboard', component: DashboardComponent },
]);
`;
    const b = buf(source);
    const symbols = angularAdapter.extractFrameworkSymbols(null, b, 'src/app/app-routing.module.ts');
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/dashboard');
  });

  it('returns empty when no Angular patterns in source', () => {
    const source = `export function helper() {}`;
    const b = buf(source);
    const symbols = angularAdapter.extractFrameworkSymbols(null, b, 'src/app/auth.service.ts');
    expect(symbols).toHaveLength(0);
  });
});
