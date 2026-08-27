import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { angularAdapter, _factsCacheForTesting } from '../../src/adapters/angular.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';
import { readFileSync } from 'fs';
import type { SymbolRecord } from '../../src/core/types.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/angular-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

async function parseTs(source: string) {
  const b = buf(source);
  const tree = await parseFile(b, typescriptHandler);
  return { tree, buf: b };
}

/**
 * Mirrors the production pipeline for an angular-routed file:
 * TS handler extracts symbols → adapter collects facts + emits routes →
 * enrichMetadata upgrades the handler rows (processFile order).
 */
async function processAngular(source: string, filePath: string): Promise<SymbolRecord[]> {
  const b = buf(source);
  const tree = await parseFile(b, typescriptHandler);
  const handlerSymbols = typescriptHandler.extractSymbols(tree, b, filePath);
  const routeSymbols = angularAdapter.extractFrameworkSymbols(tree, b, filePath);
  const enriched = handlerSymbols.map((s) => angularAdapter.enrichMetadata!(s));
  return [...enriched, ...routeSymbols];
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
  _factsCacheForTesting().clear();
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

  it('accepts standalone routing/bootstrap + NgRx files (Task 587)', () => {
    expect(angularAdapter.fileFilter('src/app/app.routes.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/app.config.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/main.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/auth/auth.effects.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/auth/auth.reducer.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/auth/auth.facade.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/auth/auth.store.ts')).toBe(true);
    expect(angularAdapter.fileFilter('src/app/auth/auth.state.ts')).toBe(true);
  });
});

// ─── Detection beyond root package.json (Task 587 / A-8) ─────────────────────

describe('angularAdapter.detect — workspace + monorepo', () => {
  it('detects via angular.json at the root (no package.json)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'angular.json'), JSON.stringify({ version: 1, projects: {} }));
    expect(await angularAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects a nested app declaring @angular/core (Nx shape)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '1' } }));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { '@angular/core': '^17.0.0' },
    }));
    expect(await angularAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

// ─── NestJS shadow guard (Task 587 / A-12) ───────────────────────────────────

describe('angularAdapter — NestJS files are never claimed', () => {
  it('a NestJS @Injectable service keeps kind class with NO angular metadata', async () => {
    const source = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class OrdersService {
  findAll(): string[] { return []; }
}
`;
    const symbols = await processAngular(source, 'src/orders/orders.service.ts');
    const svc = symbols.find((s) => s.name === 'OrdersService')!;
    expect(svc.kind).toBe('class');
    expect(svc.frameworkMeta?.angular_service).toBeUndefined();
    expect(svc.frameworkMeta?.angular_injectable).toBeUndefined();
  });

  it('a NestJS guard class is not upgraded to angular middleware', async () => {
    const source = `
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean { return true; }
}
`;
    const symbols = await processAngular(source, 'src/auth/roles.guard.ts');
    const guard = symbols.find((s) => s.name === 'RolesGuard')!;
    expect(guard.kind).toBe('class');
    expect(guard.frameworkMeta?.angular_guard).toBeUndefined();
  });
});

// ─── @Component upgrade (single row — A-1) ────────────────────────────────────

describe('angularAdapter — @Component', () => {
  it('upgrades the handler class row to component — exactly ONE row', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: '<h1>Home</h1>'
})
export class HomeComponent {}
`;
    const symbols = await processAngular(source, 'src/app/home.component.ts');
    const rows = symbols.filter((s) => s.name === 'HomeComponent');
    expect(rows).toHaveLength(1);
    const sym = rows[0]!;
    expect(sym.kind).toBe('component');
    expect(sym.frameworkMeta?.selector).toBe('app-home');
    // Real span from the handler, not a re-emitted duplicate
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  it('preserves the handler docstring summary on upgrade', async () => {
    const source = `
import { Component } from '@angular/core';

/** The home page component. */
@Component({ selector: 'app-home', template: '' })
export class HomeComponent {}
`;
    const symbols = await processAngular(source, 'src/app/home.component.ts');
    const sym = symbols.find((s) => s.name === 'HomeComponent')!;
    expect(sym.kind).toBe('component');
    expect(sym.summary).toBe('The home page component.');
  });

  it('emits component from fixture app.component.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app.component.ts'),
      'utf8',
    );
    const symbols = await processAngular(source, 'src/app/app.component.ts');
    const rows = symbols.filter((s) => s.name === 'AppComponent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('component');
    expect(rows[0]!.frameworkMeta?.selector).toBe('app-root');
  });
});

// ─── Duplicate absence for every decorated shape (A-1) ────────────────────────

describe('angularAdapter — duplicate absence', () => {
  it('one row per class for @Component/@Directive/@Pipe/guard in one file', async () => {
    const source = `
import { Component, Directive, Pipe, Injectable, CanActivate } from '@angular/core';

@Component({ selector: 'app-a', template: '' })
export class AComponent {}

@Directive({ selector: '[appHighlight]' })
export class HighlightDirective {}

@Pipe({ name: 'shorten' })
export class ShortenPipe {}

@Injectable()
export class RouteGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
`;
    const symbols = await processAngular(source, 'src/app/mixed.component.ts');
    for (const name of ['AComponent', 'HighlightDirective', 'ShortenPipe', 'RouteGuard']) {
      const rows = symbols.filter((s) => s.name === name);
      expect(rows, name).toHaveLength(1);
    }
    expect(symbols.find((s) => s.name === 'AComponent')!.kind).toBe('component');
    expect(symbols.find((s) => s.name === 'HighlightDirective')!.kind).toBe('component');
    expect(symbols.find((s) => s.name === 'HighlightDirective')!.frameworkMeta?.angular_directive).toBe(true);
    expect(symbols.find((s) => s.name === 'ShortenPipe')!.kind).toBe('component');
    expect(symbols.find((s) => s.name === 'ShortenPipe')!.frameworkMeta?.angular_pipe).toBe(true);
    expect(symbols.find((s) => s.name === 'RouteGuard')!.kind).toBe('middleware');
  });

  it('extractFrameworkSymbols emits NO class symbols (routes only)', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ selector: 'app-solo', template: '' })
export class SoloComponent {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/solo.component.ts');
    expect(symbols).toHaveLength(0);
  });
});

// ─── Abstract classes (A-9) ───────────────────────────────────────────────────

describe('angularAdapter — abstract classes', () => {
  it('upgrades an abstract @Component', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ template: '' })
export abstract class BaseListComponent {}
`;
    const symbols = await processAngular(source, 'src/app/base-list.component.ts');
    const rows = symbols.filter((s) => s.name === 'BaseListComponent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('component');
  });

  it('stamps an abstract @Injectable with service metadata', async () => {
    const source = `
import { Injectable } from '@angular/core';

@Injectable()
export abstract class BaseCryptoService {
  abstract encrypt(data: string): string;
}
`;
    const symbols = await processAngular(source, 'src/app/base-crypto.service.ts');
    const rows = symbols.filter((s) => s.name === 'BaseCryptoService');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('class');
    expect(rows[0]!.frameworkMeta?.angular_service).toBe(true);
    expect(rows[0]!.frameworkMeta?.angular_injectable).toBe(true);
  });
});

// ─── @Injectable ─────────────────────────────────────────────────────────────

describe('angularAdapter — @Injectable', () => {
  it('stamps service metadata on the handler class row', async () => {
    const source = `
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UserService {}
`;
    const symbols = await processAngular(source, 'src/app/user.service.ts');
    const rows = symbols.filter((s) => s.name === 'UserService');
    expect(rows).toHaveLength(1);
    const sym = rows[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.frameworkMeta?.angular_service).toBe(true);
    expect(sym.frameworkMeta?.angular_injectable).toBe(true);
  });

  it('stamps service metadata from fixture auth.service.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/auth.service.ts'),
      'utf8',
    );
    const symbols = await processAngular(source, 'src/app/auth.service.ts');
    const svc = symbols.find((s) => s.name === 'AuthService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.angular_service).toBe(true);
  });
});

// ─── @NgModule ───────────────────────────────────────────────────────────────

describe('angularAdapter — @NgModule', () => {
  it('stamps module metadata on the handler class row', async () => {
    const source = `
import { NgModule } from '@angular/core';

@NgModule({
  declarations: [],
  imports: []
})
export class FeatureModule {}
`;
    const symbols = await processAngular(source, 'src/feature/feature.module.ts');
    const rows = symbols.filter((s) => s.name === 'FeatureModule');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('class');
    expect(rows[0]!.frameworkMeta?.angular_module).toBe(true);
  });

  it('stamps module metadata from fixture app.module.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app.module.ts'),
      'utf8',
    );
    const symbols = await processAngular(source, 'src/app/app.module.ts');
    const mod = symbols.find((s) => s.name === 'AppModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
    expect(mod!.frameworkMeta?.angular_module).toBe(true);
  });
});

// ─── CanActivate guard ───────────────────────────────────────────────────────

describe('angularAdapter — CanActivate guard', () => {
  it('upgrades a class implementing CanActivate to middleware — one row', async () => {
    const source = `
import { Injectable, CanActivate, ExecutionContext } from '@angular/core';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
`;
    const symbols = await processAngular(source, 'src/auth/auth.guard.ts');
    const rows = symbols.filter((s) => s.name === 'AuthGuard');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('middleware');
    expect(rows[0]!.frameworkMeta?.angular_guard).toBe(true);
  });

  it('upgrades a functional canX guard const to middleware — one row', async () => {
    const source = `
export const canActivateAdmin = () => {
  return true;
};
`;
    const symbols = await processAngular(source, 'src/auth/admin.guard.ts');
    const rows = symbols.filter((s) => s.name === 'canActivateAdmin');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('middleware');
    expect(rows[0]!.frameworkMeta?.angular_guard).toBe(true);
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
    const routes = symbols.filter((s) => s.kind === 'route');
    const routeNames = routes.map((s) => s.name);
    expect(routeNames).toContain('/home');
    expect(routeNames).toContain('/about');
    // Real spans (A-1 span fix): each route points at its `path: '...'` property
    for (const r of routes) {
      expect(r.startByte).toBeGreaterThan(0);
      expect(r.endByte).toBeGreaterThan(r.startByte);
      const slice = source.slice(r.startByte, r.endByte);
      expect(slice).toMatch(/^path\s*:/);
    }
  });

  it('extracts NgModule class from fixture app-routing.module.ts', async () => {
    // Note: the fixture uses `forRoot(routes)` with a variable reference.
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app/app-routing.module.ts'),
      'utf8',
    );
    const symbols = await processAngular(source, 'src/app/app-routing.module.ts');
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

// ─── enrichMetadata (no facts — fallback branch) ──────────────────────────────

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

  it('skips enrichment when angular_service is already set', () => {
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

  it('does not upgrade a method row that shares the class name prefix', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ selector: 'app-x', template: '' })
export class XComponent {
  render(): void {}
}
`;
    const symbols = await processAngular(source, 'src/app/x.component.ts');
    const method = symbols.find((s) => s.name === 'XComponent.render');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });
});

// ─── Route extraction — variable resolution + nesting (Phase 94, Task 586) ────

describe('angularAdapter — route extraction (Task 586)', () => {
  it('resolves forRoot(routesVar) to the Routes-typed declaration in the same file', async () => {
    const source = `
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  { path: 'vault', component: VaultComponent },
  { path: 'settings', component: SettingsComponent },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/app-routing.module.ts');
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/vault');
    expect(routeNames).toContain('/settings');
  });

  it('does not truncate at nested arrays (canActivate/children)', async () => {
    const source = `
RouterModule.forRoot([
  { path: 'admin', component: AdminComponent, canActivate: [authGuard, roleGuard] },
  { path: 'org', component: OrgComponent, children: [
    { path: 'members', component: MembersComponent },
  ] },
  { path: 'after', component: AfterComponent },
]);
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/app-routing.module.ts');
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/admin');
    expect(routeNames).toContain('/members');
    expect(routeNames).toContain('/after');
  });

  it('captures component target and guard names in frameworkMeta', async () => {
    const source = `
RouterModule.forRoot([
  { path: 'vault', component: VaultComponent, canActivate: [authGuard] },
  { path: 'lazy', loadComponent: () => import('./lazy/lazy.component').then(m => m.LazyComponent) },
]);
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/app-routing.module.ts');
    const vault = symbols.find((s) => s.name === '/vault')!;
    expect(vault.frameworkMeta?.component).toBe('VaultComponent');
    expect(vault.frameworkMeta?.guards).toEqual(['authGuard']);
    const lazy = symbols.find((s) => s.name === '/lazy')!;
    expect(lazy.frameworkMeta?.lazy).toBe(true);
  });

  it('extracts standalone provideRouter(routesVar) in app.config.ts', async () => {
    const source = `
import { ApplicationConfig } from '@angular/core';
import { provideRouter, Routes } from '@angular/router';

const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'profile/:username', component: ProfileComponent },
];

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/app.config.ts');
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/');
    expect(routeNames).toContain('/profile/:username');
  });

  it('extracts bare `export const routes: Routes = [...]` in *.routes.ts', async () => {
    const source = `
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'editor', component: EditorComponent },
  { path: 'article/:slug', component: ArticleComponent },
];
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = angularAdapter.extractFrameworkSymbols(tree, b, 'src/app/app.routes.ts');
    const routeNames = symbols.filter((s) => s.kind === 'route').map((s) => s.name);
    expect(routeNames).toContain('/editor');
    expect(routeNames).toContain('/article/:slug');
  });
});

// ─── Guards: heritage clause + functional providers (Phase 94, Task 586) ─────

describe('angularAdapter — guard semantics (Task 586)', () => {
  it('a service MENTIONING CanActivate in a comment stays a service', async () => {
    const source = `
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class RouteHelperService {
  // This helper builds URLs used by CanActivate guards elsewhere.
  buildUrl(): string { return '/x'; }
}
`;
    const symbols = await processAngular(source, 'src/app/route-helper.service.ts');
    const svc = symbols.find((s) => s.name === 'RouteHelperService')!;
    expect(svc.kind).toBe('class');
    expect(svc.frameworkMeta?.angular_service).toBe(true);
    expect(svc.frameworkMeta?.angular_guard).toBeUndefined();
  });

  it('recognizes CanActivateChild/CanDeactivate/CanMatch heritage', async () => {
    const source = `
import { Injectable, CanActivateChild } from '@angular/router';

@Injectable()
export class ChildGuard implements CanActivateChild {
  canActivateChild(): boolean { return true; }
}
`;
    const symbols = await processAngular(source, 'src/app/child.guard.ts');
    const guard = symbols.find((s) => s.name === 'ChildGuard')!;
    expect(guard.kind).toBe('middleware');
    expect(guard.frameworkMeta?.angular_guard).toBe(true);
    expect(guard.frameworkMeta?.angular_injectable).toBe(true);
  });

  it('upgrades typed functional guards: authGuard: CanActivateFn', async () => {
    const source = `
import { CanActivateFn } from '@angular/router';

export const authGuard: CanActivateFn = (route, state) => {
  return true;
};
`;
    const symbols = await processAngular(source, 'src/app/auth.guard.ts');
    const guard = symbols.find((s) => s.name === 'authGuard')!;
    expect(guard.kind).toBe('middleware');
    expect(guard.frameworkMeta?.angular_guard).toBe(true);
  });

  it('upgrades HttpInterceptorFn consts to middleware with interceptor meta', async () => {
    const source = `
import { HttpInterceptorFn } from '@angular/common/http';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req);
};
`;
    const symbols = await processAngular(source, 'src/app/error.interceptor.ts');
    const ic = symbols.find((s) => s.name === 'errorInterceptor')!;
    expect(ic.kind).toBe('middleware');
    expect(ic.frameworkMeta?.angular_interceptor).toBe(true);
  });

  it('upgrades ResolveFn consts to middleware with resolver meta', async () => {
    const source = `
import { ResolveFn } from '@angular/router';

export const bankAccountResolve: ResolveFn<BankAccount> = (route) => {
  return inject(BankAccountService).find(route.params.id);
};
`;
    const symbols = await processAngular(source, 'src/app/bank-account.resolver.ts');
    const r = symbols.find((s) => s.name === 'bankAccountResolve')!;
    expect(r.kind).toBe('middleware');
    expect(r.frameworkMeta?.angular_resolver).toBe(true);
  });
});

// ─── Standalone flag (Phase 94, Task 587 / A-11) ─────────────────────────────

describe('angularAdapter — standalone flag', () => {
  it('records true when explicit standalone: true', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ selector: 'app-a', standalone: true, template: '' })
export class AComponent {}
`;
    const symbols = await processAngular(source, 'src/app/a.component.ts');
    expect(symbols.find((s) => s.name === 'AComponent')!.frameworkMeta?.angular_standalone).toBe(true);
  });

  it('records false when explicit standalone: false', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ selector: 'app-b', standalone: false, template: '' })
export class BComponent {}
`;
    const symbols = await processAngular(source, 'src/app/b.component.ts');
    expect(symbols.find((s) => s.name === 'BComponent')!.frameworkMeta?.angular_standalone).toBe(false);
  });

  it('leaves the flag absent when not declared (unknown, not false)', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({ selector: 'app-c', template: '' })
export class CComponent {}
`;
    const symbols = await processAngular(source, 'src/app/c.component.ts');
    expect(symbols.find((s) => s.name === 'CComponent')!.frameworkMeta?.angular_standalone).toBeUndefined();
  });

  it('captures standalone imports array names', async () => {
    const source = `
import { Component } from '@angular/core';

@Component({
  selector: 'app-d',
  standalone: true,
  imports: [CommonModule, RouterLink, HeaderComponent],
  template: ''
})
export class DComponent {}
`;
    const symbols = await processAngular(source, 'src/app/d.component.ts');
    expect(symbols.find((s) => s.name === 'DComponent')!.frameworkMeta?.angular_imports)
      .toEqual(['CommonModule', 'RouterLink', 'HeaderComponent']);
  });
});

// ─── Field enrichment (Phase 94, Task 584) ────────────────────────────────────

describe('angularAdapter — field enrichment', () => {
  it('stamps angular_signal on signal/computed/input/output fields', async () => {
    const source = `
import { Component, signal, computed, input, output } from '@angular/core';

@Component({ selector: 'app-counter', template: '' })
export class CounterComponent {
  count = signal(0);
  double = computed(() => this.count() * 2);
  initial = input.required<number>();
  changed = output<number>();
}
`;
    const symbols = await processAngular(source, 'src/app/counter.component.ts');
    const byName = (n: string) => symbols.find((s) => s.name === `CounterComponent.${n}`)!;
    expect(byName('count').frameworkMeta?.angular_signal).toBe('signal');
    expect(byName('double').frameworkMeta?.angular_signal).toBe('computed');
    expect(byName('initial').frameworkMeta?.angular_signal).toBe('input');
    expect(byName('changed').frameworkMeta?.angular_signal).toBe('output');
  });

  it('stamps angular_injection with the injected token name', async () => {
    const source = `
import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({ selector: 'app-list', template: '' })
export class ListComponent {
  private http = inject(HttpClient);
}
`;
    const symbols = await processAngular(source, 'src/app/list.component.ts');
    const f = symbols.find((s) => s.name === 'ListComponent.http')!;
    expect(f.frameworkMeta?.angular_injection).toBe('HttpClient');
    expect(f.frameworkMeta?.visibility).toBe('private');
  });

  it('does not stamp signal meta on fields outside angular-routed files', async () => {
    const source = `
export class Store {
  count = signal(0);
}
`;
    const symbols = await processAngular(source, 'src/state/store.ts');
    const f = symbols.find((s) => s.name === 'Store.count')!;
    expect(f.frameworkMeta?.angular_signal).toBeUndefined();
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
