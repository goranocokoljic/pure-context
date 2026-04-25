import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { nestjsAdapter } from '../../src/adapters/nestjs.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';
import { readFileSync } from 'fs';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/nestjs-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

async function parseTs(source: string) {
  const b = buf(source);
  const tree = await parseFile(b, typescriptHandler);
  return { tree, buf: b };
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-nestjs-test-${Math.random().toString(36).slice(2)}`);
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

describe('nestjsAdapter metadata', () => {
  it('has name "nestjs"', () => {
    expect(nestjsAdapter.name).toBe('nestjs');
  });

  it('declares no extra extensions', () => {
    expect(nestjsAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('nestjsAdapter.detect', () => {
  it('detects @nestjs/core in dependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@nestjs/core': '^10.0.0' },
    }));
    expect(await nestjsAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects @nestjs/common in dependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@nestjs/common': '^10.0.0' },
    }));
    expect(await nestjsAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when NestJS is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0' },
    }));
    expect(await nestjsAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for missing package.json', async () => {
    const dir = tmpDir();
    expect(await nestjsAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture nestjs project', async () => {
    expect(await nestjsAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ─────────────────────────────────────────────────────────────

describe('nestjsAdapter.fileFilter', () => {
  it('accepts .controller.ts', () => {
    expect(nestjsAdapter.fileFilter('src/users/users.controller.ts')).toBe(true);
  });

  it('accepts .service.ts', () => {
    expect(nestjsAdapter.fileFilter('src/users/users.service.ts')).toBe(true);
  });

  it('accepts .module.ts', () => {
    expect(nestjsAdapter.fileFilter('src/app.module.ts')).toBe(true);
  });

  it('accepts .guard.ts', () => {
    expect(nestjsAdapter.fileFilter('src/auth/auth.guard.ts')).toBe(true);
  });

  it('accepts .interceptor.ts', () => {
    expect(nestjsAdapter.fileFilter('src/logging.interceptor.ts')).toBe(true);
  });

  it('rejects plain .ts files', () => {
    expect(nestjsAdapter.fileFilter('src/utils/helpers.ts')).toBe(false);
  });

  it('rejects .spec.ts files', () => {
    expect(nestjsAdapter.fileFilter('src/users/users.spec.ts')).toBe(false);
  });
});

// ─── @Controller + HTTP method decorator routes ───────────────────────────────

describe('nestjsAdapter — route extraction', () => {
  it('extracts GET route from @Controller + @Get', async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('items')
export class ItemsController {
  @Get()
  findAll() {}
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/items/items.controller.ts');
    const route = symbols.find((s) => s.name === 'GET /items');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.controller_prefix).toBe('items');
  });

  it('extracts parameterized route @Get(":id")', async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne() {}
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/users/users.controller.ts');
    const route = symbols.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
  });

  it('extracts POST, PUT, DELETE routes', async () => {
    const source = `
import { Controller, Get, Post, Put, Delete } from '@nestjs/common';

@Controller('posts')
export class PostsController {
  @Get()
  findAll() {}

  @Post()
  create() {}

  @Put(':id')
  update() {}

  @Delete(':id')
  remove() {}
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/posts/posts.controller.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /posts');
    expect(names).toContain('POST /posts');
    expect(names).toContain('PUT /posts/:id');
    expect(names).toContain('DELETE /posts/:id');
  });

  it('merges controller prefix with method path', async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/users')
export class UsersV1Controller {
  @Get('profile')
  profile() {}
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/users/users.controller.ts');
    const route = symbols.find((s) => s.name === 'GET /api/v1/users/profile');
    expect(route).toBeDefined();
  });

  it('extracts routes from fixture users.controller.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/users/users.controller.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = nestjsAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/users/users.controller.ts',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /users/:id');
    expect(names).toContain('POST /users');
    expect(names).toContain('PUT /users/:id');
    expect(names).toContain('DELETE /users/:id');
  });
});

// ─── @Injectable service extraction ──────────────────────────────────────────

describe('nestjsAdapter — @Injectable service', () => {
  it('emits class symbol with nestjs_provider meta', async () => {
    const source = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/users/users.service.ts');
    const svc = symbols.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.nestjs_provider).toBe(true);
  });

  it('extracts service from fixture users.service.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/users/users.service.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = nestjsAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/users/users.service.ts',
    );
    const svc = symbols.find((s) => s.name === 'UsersService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
  });
});

// ─── @Module extraction ───────────────────────────────────────────────────────

describe('nestjsAdapter — @Module', () => {
  it('emits class symbol with nestjs_module meta', async () => {
    const source = `
import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/app.module.ts');
    const mod = symbols.find((s) => s.name === 'AppModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
    expect(mod!.frameworkMeta?.nestjs_module).toBe(true);
  });

  it('extracts module from fixture app.module.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app.module.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = nestjsAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/app.module.ts',
    );
    const mod = symbols.find((s) => s.name === 'AppModule');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
  });
});

// ─── CanActivate guard extraction ─────────────────────────────────────────────

describe('nestjsAdapter — CanActivate guard', () => {
  it('emits middleware symbol for class implementing CanActivate', async () => {
    const source = `
import { Injectable, CanActivate } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
`;
    const { tree, buf: b } = await parseTs(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(tree, b, 'src/auth/auth.guard.ts');
    const guard = symbols.find((s) => s.name === 'AuthGuard');
    expect(guard).toBeDefined();
    expect(guard!.kind).toBe('middleware');
    expect(guard!.frameworkMeta?.nestjs_guard).toBe(true);
  });

  it('extracts guard from fixture auth.guard.ts', async () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/auth/auth.guard.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const tree = await parseFile(b, typescriptHandler);
    const symbols = nestjsAdapter.extractFrameworkSymbols(
      tree,
      b,
      'src/auth/auth.guard.ts',
    );
    const guard = symbols.find((s) => s.name === 'AuthGuard');
    expect(guard).toBeDefined();
    expect(guard!.kind).toBe('middleware');
  });
});

// ─── Null tree fallback ───────────────────────────────────────────────────────

describe('nestjsAdapter — null tree fallback', () => {
  it('extracts routes via text fallback when tree is null', () => {
    const source = `
@Controller('products')
export class ProductsController {
  @Get()
  findAll() {}

  @Post()
  create() {}
}
`;
    const b = buf(source);
    const symbols = nestjsAdapter.extractFrameworkSymbols(null, b, 'src/products/products.controller.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /products');
    expect(names).toContain('POST /products');
  });
});
