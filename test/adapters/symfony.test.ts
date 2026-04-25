import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { symfonyAdapter } from '../../src/adapters/symfony.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/symfony-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-symfony-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('symfonyAdapter metadata', () => {
  it('has name "symfony"', () => {
    expect(symfonyAdapter.name).toBe('symfony');
  });

  it('declares no extra extensions', () => {
    expect(symfonyAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('symfonyAdapter.detect', () => {
  it('detects via symfony/framework-bundle in composer.json', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^6.3' } }),
    );
    expect(await symfonyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via symfony/symfony in composer.json', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/symfony': '^5.4' } }),
    );
    expect(await symfonyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false for non-Symfony composer.json', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'composer.json'),
      JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
    );
    expect(await symfonyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false when composer.json is absent', async () => {
    const dir = tmpDir();
    expect(await symfonyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false on malformed composer.json', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'composer.json'), 'not valid json');
    expect(await symfonyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture Symfony project', async () => {
    expect(await symfonyAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('symfonyAdapter.fileFilter', () => {
  it('accepts src/**/*.php', () => {
    expect(symfonyAdapter.fileFilter('src/Controller/UserController.php')).toBe(true);
    expect(symfonyAdapter.fileFilter('src/Service/UserService.php')).toBe(true);
    expect(symfonyAdapter.fileFilter('src/Entity/User.php')).toBe(true);
  });

  it('rejects PHP files outside src/', () => {
    expect(symfonyAdapter.fileFilter('config/services.php')).toBe(false);
    expect(symfonyAdapter.fileFilter('migrations/Version001.php')).toBe(false);
    expect(symfonyAdapter.fileFilter('public/index.php')).toBe(false);
  });

  it('rejects non-PHP files', () => {
    expect(symfonyAdapter.fileFilter('src/Controller/UserController.ts')).toBe(false);
    expect(symfonyAdapter.fileFilter('config/services.yaml')).toBe(false);
  });
});

// ─── Attribute-based route extraction ────────────────────────────────────────

describe('symfonyAdapter — #[Route] attribute extraction', () => {
  it('extracts a route with path only (no methods restriction)', () => {
    const source = `<?php
use Symfony\\Component\\Routing\\Attribute\\Route;
class FooController {
    #[Route('/home')]
    public function home(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/FooController.php');
    const route = symbols.find((s) => s.kind === 'route' && s.name === '/home');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.symfony_route).toBe(true);
    expect(route!.frameworkMeta?.route_path).toBe('/home');
    expect(route!.frameworkMeta?.http_method).toBeUndefined();
  });

  it('extracts a route with single method', () => {
    const source = `<?php
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/UserController.php');
    const route = symbols.find((s) => s.name === 'GET /users' && s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.symfony_route).toBe(true);
  });

  it('emits one symbol per method when multiple methods specified', () => {
    const source = `<?php
class UserController {
    #[Route('/users/{id}', methods: ['PUT', 'PATCH'])]
    public function update(int $id): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/UserController.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes).toHaveLength(2);
    expect(routes.find((s) => s.name === 'PUT /users/{id}')).toBeDefined();
    expect(routes.find((s) => s.name === 'PATCH /users/{id}')).toBeDefined();
  });

  it('handles multiline attribute', () => {
    const source = `<?php
class UserController {
    #[Route(
        '/users',
        name: 'user_list',
        methods: ['GET']
    )]
    public function index(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/UserController.php');
    expect(symbols.find((s) => s.name === 'GET /users' && s.kind === 'route')).toBeDefined();
  });

  it('extracts multiple routes from the same file', () => {
    const source = `<?php
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index(): Response {}

    #[Route('/users', methods: ['POST'])]
    public function create(): Response {}

    #[Route('/users/{id}', methods: ['DELETE'])]
    public function delete(int $id): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/UserController.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes.find((s) => s.name === 'GET /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'DELETE /users/{id}')).toBeDefined();
  });

  it('extracts routes from fixture UserController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/Controller/UserController.php'),
      'utf8',
    );
    const symbols = symfonyAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/Controller/UserController.php',
    );
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'GET /users/{id}')).toBeDefined();
    expect(routes.find((s) => s.name === 'DELETE /users/{id}')).toBeDefined();
    // PUT /PATCH route emits two symbols
    expect(routes.find((s) => s.name === 'PUT /users/{id}')).toBeDefined();
    expect(routes.find((s) => s.name === 'PATCH /users/{id}')).toBeDefined();
  });

  it('extracts admin routes from fixture AdminController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/Controller/AdminController.php'),
      'utf8',
    );
    const symbols = symfonyAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/Controller/AdminController.php',
    );
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /admin')).toBeDefined();
    expect(routes.find((s) => s.name === 'GET /admin/settings')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /admin/settings')).toBeDefined();
  });
});

// ─── Annotation-based route extraction ───────────────────────────────────────

describe('symfonyAdapter — @Route annotation extraction', () => {
  it('extracts @Route from a docblock with a single method', () => {
    const source = `<?php
class LegacyController {
    /**
     * @Route("/legacy", methods={"GET"})
     */
    public function index(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/LegacyController.php');
    const route = symbols.find((s) => s.name === 'GET /legacy' && s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.symfony_route).toBe(true);
    expect(route!.frameworkMeta?.http_method).toBe('GET');
  });

  it('extracts @Route without methods restriction', () => {
    const source = `<?php
class LegacyController {
    /**
     * @Route("/legacy/index")
     */
    public function index(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/LegacyController.php');
    const route = symbols.find((s) => s.name === '/legacy/index' && s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBeUndefined();
  });

  it('emits one symbol per method for @Route with multiple methods', () => {
    const source = `<?php
class LegacyController {
    /**
     * @Route("/multi", methods={"GET", "POST"})
     */
    public function multi(): Response {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/LegacyController.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /multi')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /multi')).toBeDefined();
  });

  it('extracts annotation routes from fixture LegacyController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/Controller/LegacyController.php'),
      'utf8',
    );
    const symbols = symfonyAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/Controller/LegacyController.php',
    );
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /legacy/')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /legacy/create')).toBeDefined();
    // @Route("/multi", methods={"GET", "POST"}) emits two symbols
    expect(routes.find((s) => s.name === 'GET /legacy/multi')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /legacy/multi')).toBeDefined();
  });
});

// ─── Controller extraction ────────────────────────────────────────────────────

describe('symfonyAdapter — controller extraction', () => {
  it('extracts class extending AbstractController with symfony_controller meta', () => {
    const source = `<?php
use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
class UserController extends AbstractController {}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/UserController.php');
    const cls = symbols.find((s) => s.name === 'UserController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.symfony_controller).toBe(true);
  });

  it('extracts class with #[AsController] attribute', () => {
    const source = `<?php
#[AsController]
class AdminController {}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/AdminController.php');
    const cls = symbols.find((s) => s.name === 'AdminController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.symfony_controller).toBe(true);
  });

  it('does not emit controller symbol for plain PHP class', () => {
    const source = `<?php
class PlainService {
    public function doSomething(): void {}
}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Service/PlainService.php');
    expect(symbols.filter((s) => s.kind === 'class')).toHaveLength(0);
  });

  it('extracts controller from fixture UserController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/Controller/UserController.php'),
      'utf8',
    );
    const symbols = symfonyAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/Controller/UserController.php',
    );
    const cls = symbols.find((s) => s.name === 'UserController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.symfony_controller).toBe(true);
  });

  it('extracts #[AsController] controller from fixture AdminController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/Controller/AdminController.php'),
      'utf8',
    );
    const symbols = symfonyAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/Controller/AdminController.php',
    );
    const cls = symbols.find((s) => s.name === 'AdminController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.symfony_controller).toBe(true);
  });

  it('does not emit a controller twice if class has both attribute and extends', () => {
    const source = `<?php
#[AsController]
class HybridController extends AbstractController {}
`;
    const symbols = symfonyAdapter.extractFrameworkSymbols(null, buf(source), 'src/Controller/HybridController.php');
    const controllers = symbols.filter((s) => s.kind === 'class' && s.name === 'HybridController');
    expect(controllers).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('symfonyAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc123',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'src/Controller/UserController.php',
      startByte: 0,
      endByte: 0,
      signature: "#[Route('/users', methods: ['GET'])]",
      summary: 'Symfony route: GET /users',
      frameworkMeta: { symfony_route: true, http_method: 'GET', route_path: '/users' },
    };
    expect(symfonyAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
