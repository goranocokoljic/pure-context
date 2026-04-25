import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { springKotlinAdapter } from '../../src/adapters/spring-kotlin.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/spring-kotlin-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-spring-kotlin-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('springKotlinAdapter metadata', () => {
  it('has name "spring-kotlin"', () => {
    expect(springKotlinAdapter.name).toBe('spring-kotlin');
  });

  it('declares no extra extensions', () => {
    expect(springKotlinAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('springKotlinAdapter.detect', () => {
  it('detects spring boot in build.gradle.kts', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'id("org.springframework.boot") version "3.2.0"\n');
    expect(await springKotlinAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects spring boot in build.gradle', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "id 'org.springframework.boot' version '3.2.0'\n");
    expect(await springKotlinAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects spring boot in pom.xml', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>\n',
    );
    expect(await springKotlinAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when spring is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'implementation("io.ktor:ktor-server-core:2.3.7")\n');
    expect(await springKotlinAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await springKotlinAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture spring-kotlin project', async () => {
    expect(await springKotlinAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('springKotlinAdapter.fileFilter', () => {
  it('accepts .kt files', () => {
    expect(springKotlinAdapter.fileFilter('UserController.kt')).toBe(true);
    expect(springKotlinAdapter.fileFilter('src/main/kotlin/App.kt')).toBe(true);
  });

  it('rejects non-Kotlin files', () => {
    expect(springKotlinAdapter.fileFilter('build.gradle.kts')).toBe(false);
    expect(springKotlinAdapter.fileFilter('UserController.java')).toBe(false);
    expect(springKotlinAdapter.fileFilter('App.ts')).toBe(false);
  });
});

// ─── @RestController routes ───────────────────────────────────────────────────

describe('springKotlinAdapter — @RestController routes', () => {
  it('extracts @GetMapping route from @RestController', () => {
    const source = `
@RestController
class UserController {
    @GetMapping("/users")
    fun listUsers(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    const route = symbols.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.spring_route).toBe(true);
  });

  it('extracts @PostMapping route', () => {
    const source = `
@RestController
class UserController {
    @PostMapping("/users")
    fun createUser(): User = User()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @PutMapping, @DeleteMapping, @PatchMapping routes', () => {
    const source = `
@RestController
class ItemController {
    @PutMapping("/items/{id}")
    fun update(): Item = Item()

    @DeleteMapping("/items/{id}")
    fun delete() {}

    @PatchMapping("/items/{id}")
    fun patch(): Item = Item()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'ItemController.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('PUT /items/{id}');
    expect(names).toContain('DELETE /items/{id}');
    expect(names).toContain('PATCH /items/{id}');
  });

  it('extracts bare @GetMapping with no path argument', () => {
    const source = `
@RestController
class UserController {
    @GetMapping
    fun listUsers(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    expect(symbols.find((s) => s.kind === 'route')).toBeDefined();
  });
});

// ─── Class-level @RequestMapping prefix ──────────────────────────────────────

describe('springKotlinAdapter — class-level @RequestMapping prefix', () => {
  it('combines class-level prefix with method-level @GetMapping', () => {
    const source = `
@RestController
@RequestMapping("/users")
class UserController {
    @GetMapping("/{id}")
    fun getUser(): User = User()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    expect(symbols.find((s) => s.name === 'GET /users/{id}')).toBeDefined();
  });

  it('combines prefix with multiple routes', () => {
    const source = `
@RestController
@RequestMapping("/api/v1")
class ApiController {
    @GetMapping("/health")
    fun health(): String = "OK"

    @PostMapping("/data")
    fun postData(): String = "OK"
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'ApiController.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /api/v1/health');
    expect(names).toContain('POST /api/v1/data');
  });

  it('uses prefix alone when method annotation has no path', () => {
    const source = `
@RestController
@RequestMapping("/users")
class UserController {
    @GetMapping
    fun listUsers(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users');
  });
});

// ─── Class symbols ────────────────────────────────────────────────────────────

describe('springKotlinAdapter — class symbols', () => {
  it('emits class symbol for @RestController', () => {
    const source = `
@RestController
class UserController {
    @GetMapping("/users")
    fun list(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    const cls = symbols.find((s) => s.name === 'UserController');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.spring_controller).toBe(true);
  });

  it('emits class symbol for @Service', () => {
    const source = `
@Service
class UserService {
    fun findAll(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.kt');
    const svc = symbols.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.spring_service).toBe(true);
  });

  it('emits class symbol for @Repository', () => {
    const source = `
@Repository
class UserRepository {
    fun findAll(): List<User> = emptyList()
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserRepository.kt');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    expect(repo).toBeDefined();
    expect(repo!.kind).toBe('class');
    expect(repo!.frameworkMeta?.spring_repository).toBe(true);
  });

  it('emits class symbol for @Component', () => {
    const source = `
@Component
class AuditLogger {
    fun log(msg: String) {}
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'AuditLogger.kt');
    const comp = symbols.find((s) => s.name === 'AuditLogger');
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe('class');
    expect(comp!.frameworkMeta?.spring_component).toBe(true);
  });

  it('emits class symbol for @Controller', () => {
    const source = `
@Controller
class PageController {
    @GetMapping("/")
    fun index(): String = "index"
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'PageController.kt');
    const cls = symbols.find((s) => s.name === 'PageController');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.spring_controller).toBe(true);
  });

  it('does not emit Spring metadata for undecorated classes', () => {
    const source = `
class PlainClass {
    fun doSomething() {}
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'Plain.kt');
    expect(symbols).toHaveLength(0);
  });
});

// ─── Routes not emitted for non-controller Spring classes ─────────────────────

describe('springKotlinAdapter — routes only inside controllers', () => {
  it('does not emit routes from @Service class', () => {
    const source = `
@Service
class UserService {
    @GetMapping("/should-not-appear")
    fun notARoute(): String = "nope"
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.kt');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('springKotlinAdapter — fixture project', () => {
  it('extracts routes from UserController.kt fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/kotlin/com/example/UserController.kt'),
      'utf8',
    );
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.kt');
    const names = symbols.map((s) => s.name);

    // UserController routes (with /users prefix)
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /users/{id}');
    expect(names).toContain('POST /users');
    expect(names).toContain('PUT /users/{id}');
    expect(names).toContain('DELETE /users/{id}');
    // ApiController routes
    expect(names).toContain('GET /api/v1/health');
    expect(names).toContain('GET /api/v1/version');
    // PageController routes
    expect(names).toContain('GET /');
    expect(names).toContain('GET /about');
  });

  it('emits controller class symbols from UserController.kt fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/kotlin/com/example/UserController.kt'),
      'utf8',
    );
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.kt');
    const ctrlNames = symbols
      .filter((s) => s.kind === 'class' && s.frameworkMeta?.spring_controller)
      .map((s) => s.name);
    expect(ctrlNames).toContain('UserController');
    expect(ctrlNames).toContain('ApiController');
    expect(ctrlNames).toContain('PageController');
  });

  it('extracts service, repository, component from UserService.kt fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/kotlin/com/example/UserService.kt'),
      'utf8',
    );
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.kt');
    const svc = symbols.find((s) => s.name === 'UserService');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    const comp = symbols.find((s) => s.name === 'AuditLogger');

    expect(svc?.frameworkMeta?.spring_service).toBe(true);
    expect(repo?.frameworkMeta?.spring_repository).toBe(true);
    expect(comp?.frameworkMeta?.spring_component).toBe(true);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('springKotlinAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
@RestController
class UserController {
    @GetMapping("/users")
    fun a(): String = ""
    @GetMapping("/users")
    fun b(): String = ""
}
`;
    const symbols = springKotlinAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.kt');
    expect(symbols.filter((s) => s.name === 'GET /users')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('springKotlinAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'UserController.kt',
      startByte: 0,
      endByte: 0,
      signature: '@GetMapping("/users") fun listUsers(...)',
      summary: 'Spring route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', spring_route: true },
    };
    expect(springKotlinAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
