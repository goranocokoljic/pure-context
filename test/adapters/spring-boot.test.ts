import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { springBootAdapter } from '../../src/adapters/spring-boot.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/spring-boot-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-spring-boot-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('springBootAdapter metadata', () => {
  it('has name "spring-boot"', () => {
    expect(springBootAdapter.name).toBe('spring-boot');
  });

  it('declares no extra extensions', () => {
    expect(springBootAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('springBootAdapter.detect', () => {
  it('detects via pom.xml with spring-boot-starter', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>\n',
    );
    expect(await springBootAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle.kts with org.springframework.boot', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'id("org.springframework.boot") version "3.2.0"\n');
    expect(await springBootAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle with org.springframework.boot', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "id 'org.springframework.boot' version '3.2.0'\n");
    expect(await springBootAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via application.properties', async () => {
    const dir = tmpDir();
    const resDir = join(dir, 'src', 'main', 'resources');
    mkdirSync(resDir, { recursive: true });
    writeFileSync(join(resDir, 'application.properties'), 'spring.application.name=demo\n');
    expect(await springBootAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via application.yml', async () => {
    const dir = tmpDir();
    const resDir = join(dir, 'src', 'main', 'resources');
    mkdirSync(resDir, { recursive: true });
    writeFileSync(join(resDir, 'application.yml'), 'spring:\n  application:\n    name: demo\n');
    expect(await springBootAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when spring is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pom.xml'), '<project><artifactId>other</artifactId></project>\n');
    expect(await springBootAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await springBootAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture spring-boot project via pom.xml', async () => {
    expect(await springBootAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('springBootAdapter.fileFilter', () => {
  it('accepts .java files', () => {
    expect(springBootAdapter.fileFilter('UserController.java')).toBe(true);
    expect(springBootAdapter.fileFilter('src/main/java/com/example/App.java')).toBe(true);
  });

  it('accepts .kt files', () => {
    expect(springBootAdapter.fileFilter('UserController.kt')).toBe(true);
    expect(springBootAdapter.fileFilter('src/main/kotlin/App.kt')).toBe(true);
  });

  it('rejects non-Java/Kotlin files', () => {
    expect(springBootAdapter.fileFilter('build.gradle.kts')).toBe(false);
    expect(springBootAdapter.fileFilter('App.ts')).toBe(false);
    expect(springBootAdapter.fileFilter('pom.xml')).toBe(false);
    expect(springBootAdapter.fileFilter('application.properties')).toBe(false);
  });
});

// ─── @GetMapping route extraction ────────────────────────────────────────────

describe('springBootAdapter — @GetMapping routes', () => {
  it('extracts @GetMapping route from @RestController', () => {
    const source = `
@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> listUsers() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
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
public class UserController {
    @PostMapping("/users")
    public User createUser(@RequestBody User user) { return user; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @PutMapping, @DeleteMapping, @PatchMapping routes', () => {
    const source = `
@RestController
public class ItemController {
    @PutMapping("/items/{id}")
    public Item update(@PathVariable Long id) { return null; }

    @DeleteMapping("/items/{id}")
    public void delete(@PathVariable Long id) {}

    @PatchMapping("/items/{id}")
    public Item patch(@PathVariable Long id) { return null; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'ItemController.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('PUT /items/{id}');
    expect(names).toContain('DELETE /items/{id}');
    expect(names).toContain('PATCH /items/{id}');
  });

  it('extracts bare @GetMapping with no path argument', () => {
    const source = `
@RestController
public class UserController {
    @GetMapping
    public List<User> listUsers() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.find((s) => s.kind === 'route')).toBeDefined();
  });
});

// ─── Class-level @RequestMapping prefix ──────────────────────────────────────

describe('springBootAdapter — class-level @RequestMapping prefix', () => {
  it('combines class-level prefix with method-level @GetMapping', () => {
    const source = `
@RestController
@RequestMapping("/users")
public class UserController {
    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) { return null; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.find((s) => s.name === 'GET /users/{id}')).toBeDefined();
  });

  it('combines prefix with multiple routes', () => {
    const source = `
@RestController
@RequestMapping("/api/v1")
public class ApiController {
    @GetMapping("/health")
    public String health() { return "OK"; }

    @PostMapping("/data")
    public String postData() { return "OK"; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'ApiController.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /api/v1/health');
    expect(names).toContain('POST /api/v1/data');
  });

  it('uses prefix alone when method annotation has no path', () => {
    const source = `
@RestController
@RequestMapping("/users")
public class UserController {
    @GetMapping
    public List<User> listUsers() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users');
  });
});

// ─── Class symbols ────────────────────────────────────────────────────────────

describe('springBootAdapter — class symbols', () => {
  it('emits class symbol for @RestController with spring_controller', () => {
    const source = `
@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const cls = symbols.find((s) => s.name === 'UserController');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.spring_controller).toBe(true);
  });

  it('emits class symbol for @Controller', () => {
    const source = `
@Controller
public class PageController {
    @GetMapping("/")
    public String index() { return "index"; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'PageController.java');
    const cls = symbols.find((s) => s.name === 'PageController');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.spring_controller).toBe(true);
  });

  it('emits class symbol for @Service with spring_bean', () => {
    const source = `
@Service
public class UserService {
    public List<User> findAll() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.spring_bean).toBe(true);
  });

  it('emits class symbol for @Repository with spring_bean', () => {
    const source = `
@Repository
public class UserRepository {
    public List<User> findAll() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserRepository.java');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    expect(repo).toBeDefined();
    expect(repo!.frameworkMeta?.spring_bean).toBe(true);
  });

  it('emits class symbol for @Component with spring_bean', () => {
    const source = `
@Component
public class AuditLogger {
    public void log(String msg) {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'AuditLogger.java');
    const comp = symbols.find((s) => s.name === 'AuditLogger');
    expect(comp).toBeDefined();
    expect(comp!.frameworkMeta?.spring_bean).toBe(true);
  });

  it('emits class symbol for @Configuration with spring_config', () => {
    const source = `
@Configuration
public class AppConfig {
    @Bean
    public UserService userService() { return new UserService(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'AppConfig.java');
    const cfg = symbols.find((s) => s.name === 'AppConfig');
    expect(cfg).toBeDefined();
    expect(cfg!.frameworkMeta?.spring_config).toBe(true);
  });

  it('does not emit Spring metadata for undecorated classes', () => {
    const source = `
public class PlainClass {
    public void doSomething() {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'Plain.java');
    expect(symbols).toHaveLength(0);
  });
});

// ─── @Bean methods ────────────────────────────────────────────────────────────

describe('springBootAdapter — @Bean methods', () => {
  it('emits function symbol for @Bean method', () => {
    const source = `
@Configuration
public class AppConfig {
    @Bean
    public UserService userService() {
        return new UserService();
    }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'AppConfig.java');
    const bean = symbols.find((s) => s.name === 'userService');
    expect(bean).toBeDefined();
    expect(bean!.kind).toBe('function');
    expect(bean!.frameworkMeta?.spring_bean).toBe(true);
  });

  it('emits multiple @Bean methods from @Configuration class', () => {
    const source = `
@Configuration
public class AppConfig {
    @Bean
    public UserService userService() { return new UserService(); }

    @Bean
    public AuditLogger auditLogger() { return new AuditLogger(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'AppConfig.java');
    const beanNames = symbols.filter((s) => s.frameworkMeta?.spring_bean && s.kind === 'function').map((s) => s.name);
    expect(beanNames).toContain('userService');
    expect(beanNames).toContain('auditLogger');
  });
});

// ─── @Scheduled methods ───────────────────────────────────────────────────────

describe('springBootAdapter — @Scheduled methods', () => {
  it('emits function symbol for @Scheduled method', () => {
    const source = `
@Service
public class TaskService {
    @Scheduled(fixedRate = 5000)
    public void runTask() {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'TaskService.java');
    const task = symbols.find((s) => s.name === 'runTask');
    expect(task).toBeDefined();
    expect(task!.kind).toBe('function');
    expect(task!.frameworkMeta?.spring_scheduled).toBe(true);
  });

  it('handles @Scheduled with cron expression', () => {
    const source = `
@Component
public class CronJob {
    @Scheduled(cron = "0 0 * * * ?")
    public void nightly() {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'CronJob.java');
    const task = symbols.find((s) => s.name === 'nightly');
    expect(task).toBeDefined();
    expect(task!.frameworkMeta?.spring_scheduled).toBe(true);
  });
});

// ─── @EventListener methods ───────────────────────────────────────────────────

describe('springBootAdapter — @EventListener methods', () => {
  it('emits function symbol for @EventListener method', () => {
    const source = `
@Service
public class UserService {
    @EventListener
    public void onUserCreated(UserCreatedEvent event) {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    const listener = symbols.find((s) => s.name === 'onUserCreated');
    expect(listener).toBeDefined();
    expect(listener!.kind).toBe('function');
    expect(listener!.frameworkMeta?.spring_listener).toBe(true);
  });

  it('handles multiple @EventListener methods', () => {
    const source = `
@Component
public class EventHandler {
    @EventListener
    public void onCreated(CreatedEvent e) {}

    @EventListener
    public void onDeleted(DeletedEvent e) {}
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'EventHandler.java');
    const listeners = symbols.filter((s) => s.frameworkMeta?.spring_listener);
    expect(listeners).toHaveLength(2);
    const names = listeners.map((s) => s.name);
    expect(names).toContain('onCreated');
    expect(names).toContain('onDeleted');
  });
});

// ─── Routes only inside controllers ──────────────────────────────────────────

describe('springBootAdapter — routes only inside controllers', () => {
  it('does not emit routes from @Service class', () => {
    const source = `
@Service
public class UserService {
    @GetMapping("/should-not-appear")
    public String notARoute() { return "nope"; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Path variable preservation ───────────────────────────────────────────────

describe('springBootAdapter — path variables', () => {
  it('preserves {id} path variable in route_path', () => {
    const source = `
@RestController
public class UserController {
    @GetMapping("/users/{id}")
    public User getUser(@PathVariable Long id) { return null; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/users/{id}');
  });

  it('preserves nested path variables', () => {
    const source = `
@RestController
@RequestMapping("/orgs/{orgId}")
public class ProjectController {
    @GetMapping("/projects/{projectId}")
    public Project getProject(@PathVariable Long orgId, @PathVariable Long projectId) { return null; }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'ProjectController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/orgs/{orgId}/projects/{projectId}');
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('springBootAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> a() { return List.of(); }
    @GetMapping("/users")
    public List<User> b() { return List.of(); }
}
`;
    const symbols = springBootAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.filter((s) => s.name === 'GET /users')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('springBootAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'UserController.java',
      startByte: 0,
      endByte: 0,
      signature: '@GetMapping("/users") public List<User> listUsers(...)',
      summary: 'Spring route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', spring_route: true },
    };
    expect(springBootAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('springBootAdapter — fixture project', () => {
  it('extracts routes from UserController.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserController.java'),
      'utf8',
    );
    const symbols = springBootAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.java');
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

  it('emits controller class symbols from UserController.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserController.java'),
      'utf8',
    );
    const symbols = springBootAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.java');
    const ctrlNames = symbols
      .filter((s) => s.kind === 'class' && s.frameworkMeta?.spring_controller)
      .map((s) => s.name);
    expect(ctrlNames).toContain('UserController');
    expect(ctrlNames).toContain('ApiController');
    expect(ctrlNames).toContain('PageController');
  });

  it('extracts @Service, @Repository, @Component from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = springBootAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    const comp = symbols.find((s) => s.name === 'AuditLogger');

    expect(svc?.frameworkMeta?.spring_bean).toBe(true);
    expect(repo?.frameworkMeta?.spring_bean).toBe(true);
    expect(comp?.frameworkMeta?.spring_bean).toBe(true);
  });

  it('extracts @Scheduled and @EventListener from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = springBootAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const scheduled = symbols.find((s) => s.frameworkMeta?.spring_scheduled);
    expect(scheduled).toBeDefined();
    expect(scheduled!.name).toBe('cleanupExpiredSessions');

    const listeners = symbols.filter((s) => s.frameworkMeta?.spring_listener);
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    const listenerNames = listeners.map((s) => s.name);
    expect(listenerNames).toContain('onUserCreated');
    expect(listenerNames).toContain('onUserDeleted');
  });

  it('extracts @Bean methods from AppConfig.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/AppConfig.java'),
      'utf8',
    );
    const symbols = springBootAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'AppConfig.java');
    const beans = symbols.filter((s) => s.kind === 'function' && s.frameworkMeta?.spring_bean);
    const beanNames = beans.map((s) => s.name);
    expect(beanNames).toContain('userService');
    expect(beanNames).toContain('auditLogger');
  });
});
