import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { micronautAdapter } from '../../src/adapters/micronaut.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/micronaut-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-micronaut-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('micronautAdapter metadata', () => {
  it('has name "micronaut"', () => {
    expect(micronautAdapter.name).toBe('micronaut');
  });

  it('declares no extra extensions', () => {
    expect(micronautAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('micronautAdapter.detect', () => {
  it('detects via pom.xml with io.micronaut parent', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<parent><groupId>io.micronaut</groupId><artifactId>micronaut-parent</artifactId></parent>\n',
    );
    expect(await micronautAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via pom.xml with micronaut- artifactId', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>io.micronaut</groupId><artifactId>micronaut-http-server-netty</artifactId></dependency>\n',
    );
    expect(await micronautAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle.kts with io.micronaut', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'id("io.micronaut.application") version "4.3.0"\n');
    expect(await micronautAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle with io.micronaut', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "id 'io.micronaut.application' version '4.3.0'\n");
    expect(await micronautAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when micronaut is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pom.xml'), '<project><artifactId>other</artifactId></project>\n');
    expect(await micronautAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await micronautAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture micronaut project via pom.xml', async () => {
    expect(await micronautAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('micronautAdapter.fileFilter', () => {
  it('accepts .java files', () => {
    expect(micronautAdapter.fileFilter('UserController.java')).toBe(true);
    expect(micronautAdapter.fileFilter('src/main/java/com/example/App.java')).toBe(true);
  });

  it('accepts .kt files', () => {
    expect(micronautAdapter.fileFilter('UserController.kt')).toBe(true);
  });

  it('accepts .groovy files', () => {
    expect(micronautAdapter.fileFilter('UserController.groovy')).toBe(true);
  });

  it('rejects non-JVM files', () => {
    expect(micronautAdapter.fileFilter('pom.xml')).toBe(false);
    expect(micronautAdapter.fileFilter('build.gradle')).toBe(false);
    expect(micronautAdapter.fileFilter('App.ts')).toBe(false);
    expect(micronautAdapter.fileFilter('config.yml')).toBe(false);
  });
});

// ─── @Get route extraction ─────────────────────────────────────────────────────

describe('micronautAdapter — @Get routes', () => {
  it('extracts @Get route from @Controller', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get("/{id}")
    public HttpResponse<User> getUser(Long id) { return HttpResponse.ok(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const route = symbols.find((s) => s.name === 'GET /users/{id}');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users/{id}');
    expect(route!.frameworkMeta?.micronaut_route).toBe(true);
  });

  it('extracts bare @Get with no path (uses controller prefix)', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get
    public List<User> listUsers() { return List.of(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users');
  });

  it('extracts @Post route', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Post
    public User createUser(User user) { return user; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @Put, @Delete, @Patch routes', () => {
    const source = `
@Controller("/items")
public class ItemController {
    @Put("/{id}")
    public Item update(Long id, Item item) { return item; }

    @Delete("/{id}")
    public void delete(Long id) {}

    @Patch("/{id}")
    public Item patch(Long id, Item partial) { return partial; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'ItemController.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('PUT /items/{id}');
    expect(names).toContain('DELETE /items/{id}');
    expect(names).toContain('PATCH /items/{id}');
  });
});

// ─── @Controller with base path ───────────────────────────────────────────────

describe('micronautAdapter — @Controller base path', () => {
  it('emits class symbol with micronaut_controller', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get
    public List<User> list() { return List.of(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const cls = symbols.find((s) => s.name === 'UserController');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.micronaut_controller).toBe(true);
    expect(cls!.frameworkMeta?.route_prefix).toBe('/users');
  });

  it('combines class prefix with method path', () => {
    const source = `
@Controller("/api/v1")
public class ApiController {
    @Get("/health")
    public String health() { return "UP"; }

    @Post("/data")
    public String postData() { return "OK"; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'ApiController.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /api/v1/health');
    expect(names).toContain('POST /api/v1/data');
  });

  it('handles multiple controllers in one file', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get
    public List<User> list() { return List.of(); }
}

@Controller("/orders")
class OrderController {
    @Get
    public List<Order> listOrders() { return List.of(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'Controllers.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /orders');
  });

  it('does not emit routes from non-controller classes', () => {
    const source = `
@Singleton
public class UserService {
    @Get("/should-not-appear")
    public String notARoute() { return "nope"; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Path variable preservation ───────────────────────────────────────────────

describe('micronautAdapter — path variables', () => {
  it('preserves {id} path variable in route_path', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get("/{id}")
    public User getUser(Long id) { return null; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/users/{id}');
  });

  it('preserves nested path variables', () => {
    const source = `
@Controller("/orgs/{orgId}")
public class ProjectController {
    @Get("/projects/{projectId}")
    public Project getProject(Long orgId, Long projectId) { return null; }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'ProjectController.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/orgs/{orgId}/projects/{projectId}');
  });
});

// ─── @Singleton / @Prototype beans ───────────────────────────────────────────

describe('micronautAdapter — bean scopes', () => {
  it('emits class symbol for @Singleton with micronaut_bean', () => {
    const source = `
@Singleton
public class UserService {
    public List<User> findAll() { return List.of(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.micronaut_bean).toBe(true);
  });

  it('emits class symbol for @Prototype with micronaut_bean', () => {
    const source = `
@Prototype
public class RequestContext {
    private String requestId;
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'RequestContext.java');
    const ctx = symbols.find((s) => s.name === 'RequestContext');
    expect(ctx).toBeDefined();
    expect(ctx!.frameworkMeta?.micronaut_bean).toBe(true);
  });

  it('does not emit bean for undecorated classes', () => {
    const source = `
public class PlainClass {
    public void doSomething() {}
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'Plain.java');
    expect(symbols).toHaveLength(0);
  });
});

// ─── @Bean in @Factory class ──────────────────────────────────────────────────

describe('micronautAdapter — @Factory @Bean methods', () => {
  it('emits function symbol for @Bean inside @Factory', () => {
    const source = `
@Factory
public class AppFactory {
    @Bean
    public UserService userService() {
        return new UserService();
    }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'AppFactory.java');
    const bean = symbols.find((s) => s.name === 'userService');
    expect(bean).toBeDefined();
    expect(bean!.kind).toBe('function');
    expect(bean!.frameworkMeta?.micronaut_bean).toBe(true);
  });

  it('emits multiple @Bean methods from @Factory', () => {
    const source = `
@Factory
public class AppFactory {
    @Bean
    public UserService userService() { return new UserService(); }

    @Bean
    public UserRepository userRepository() { return new UserRepository(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'AppFactory.java');
    const beanNames = symbols
      .filter((s) => s.frameworkMeta?.micronaut_bean && s.kind === 'function')
      .map((s) => s.name);
    expect(beanNames).toContain('userService');
    expect(beanNames).toContain('userRepository');
  });
});

// ─── @Client interface ────────────────────────────────────────────────────────

describe('micronautAdapter — @Client interface', () => {
  it('emits interface symbol for @Client with micronaut_client', () => {
    const source = `
@Client("/users")
public interface UserClient {
    @Get("/{id}")
    User getUser(Long id);
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserClient.java');
    const client = symbols.find((s) => s.name === 'UserClient');
    expect(client).toBeDefined();
    expect(client!.kind).toBe('interface');
    expect(client!.frameworkMeta?.micronaut_client).toBe(true);
    expect(client!.frameworkMeta?.base_path).toBe('/users');
  });

  it('emits multiple @Client interfaces from one file', () => {
    const source = `
@Client("/users")
public interface UserClient {
    @Get
    List<User> list();
}

@Client("/orders")
interface OrderClient {
    @Get
    List<Order> list();
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'Clients.java');
    const clientNames = symbols
      .filter((s) => s.frameworkMeta?.micronaut_client)
      .map((s) => s.name);
    expect(clientNames).toContain('UserClient');
    expect(clientNames).toContain('OrderClient');
  });

  it('emits interface without base_path when @Client has no argument', () => {
    const source = `
@Client
public interface HealthClient {
    @Get("/health")
    String health();
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'HealthClient.java');
    const client = symbols.find((s) => s.name === 'HealthClient');
    expect(client).toBeDefined();
    expect(client!.frameworkMeta?.micronaut_client).toBe(true);
    expect(client!.frameworkMeta?.base_path).toBeUndefined();
  });
});

// ─── @Scheduled methods ───────────────────────────────────────────────────────

describe('micronautAdapter — @Scheduled methods', () => {
  it('emits function symbol for @Scheduled method', () => {
    const source = `
@Singleton
public class TaskService {
    @Scheduled(fixedDelay = "1h")
    public void runTask() {}
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'TaskService.java');
    const task = symbols.find((s) => s.name === 'runTask');
    expect(task).toBeDefined();
    expect(task!.kind).toBe('function');
    expect(task!.frameworkMeta?.micronaut_scheduled).toBe(true);
  });

  it('handles @Scheduled with cron expression', () => {
    const source = `
@Singleton
public class CronJob {
    @Scheduled(cron = "0 0 * * *")
    public void nightly() {}
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'CronJob.java');
    const task = symbols.find((s) => s.name === 'nightly');
    expect(task).toBeDefined();
    expect(task!.frameworkMeta?.micronaut_scheduled).toBe(true);
  });
});

// ─── @EventListener methods ───────────────────────────────────────────────────

describe('micronautAdapter — @EventListener methods', () => {
  it('emits function symbol for @EventListener method', () => {
    const source = `
@Singleton
public class UserService {
    @EventListener
    public void onUserCreated(UserCreatedEvent event) {}
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    const listener = symbols.find((s) => s.name === 'onUserCreated');
    expect(listener).toBeDefined();
    expect(listener!.kind).toBe('function');
    expect(listener!.frameworkMeta?.micronaut_listener).toBe(true);
  });

  it('handles multiple @EventListener methods', () => {
    const source = `
@Singleton
public class EventHandler {
    @EventListener
    public void onCreated(CreatedEvent e) {}

    @EventListener
    public void onDeleted(DeletedEvent e) {}
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'EventHandler.java');
    const listeners = symbols.filter((s) => s.frameworkMeta?.micronaut_listener);
    expect(listeners).toHaveLength(2);
    const names = listeners.map((s) => s.name);
    expect(names).toContain('onCreated');
    expect(names).toContain('onDeleted');
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('micronautAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
@Controller("/users")
public class UserController {
    @Get
    public List<User> a() { return List.of(); }
    @Get
    public List<User> b() { return List.of(); }
}
`;
    const symbols = micronautAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.java');
    expect(symbols.filter((s) => s.name === 'GET /users')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('micronautAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'UserController.java',
      startByte: 0,
      endByte: 0,
      signature: '@Get("/users") public List<User> listUsers(...)',
      summary: 'Micronaut route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', micronaut_route: true },
    };
    expect(micronautAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('micronautAdapter — fixture project', () => {
  it('detects fixture as micronaut project', async () => {
    expect(await micronautAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('extracts routes from UserController.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserController.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.java');
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
    expect(names).toContain('POST /api/v1/echo');
  });

  it('emits controller class symbols from UserController.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserController.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserController.java');
    const ctrlNames = symbols
      .filter((s) => s.kind === 'class' && s.frameworkMeta?.micronaut_controller)
      .map((s) => s.name);
    expect(ctrlNames).toContain('UserController');
    expect(ctrlNames).toContain('ApiController');
  });

  it('extracts @Singleton beans from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    expect(svc?.frameworkMeta?.micronaut_bean).toBe(true);
    expect(repo?.frameworkMeta?.micronaut_bean).toBe(true);
  });

  it('extracts @Scheduled and @EventListener from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const scheduled = symbols.find((s) => s.frameworkMeta?.micronaut_scheduled);
    expect(scheduled).toBeDefined();
    expect(scheduled!.name).toBe('cleanupExpiredSessions');

    const listeners = symbols.filter((s) => s.frameworkMeta?.micronaut_listener);
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    const listenerNames = listeners.map((s) => s.name);
    expect(listenerNames).toContain('onUserCreated');
    expect(listenerNames).toContain('onUserDeleted');
  });

  it('extracts @Bean methods from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const beans = symbols.filter((s) => s.kind === 'function' && s.frameworkMeta?.micronaut_bean);
    const beanNames = beans.map((s) => s.name);
    expect(beanNames).toContain('userService');
    expect(beanNames).toContain('userRepository');
  });

  it('extracts @Client interfaces from UserClient.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserClient.java'),
      'utf8',
    );
    const symbols = micronautAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserClient.java');
    const clients = symbols.filter((s) => s.frameworkMeta?.micronaut_client);
    const clientNames = clients.map((s) => s.name);
    expect(clientNames).toContain('UserClient');
    expect(clientNames).toContain('ApiClient');

    const userClient = clients.find((s) => s.name === 'UserClient');
    expect(userClient!.frameworkMeta?.base_path).toBe('/users');
  });
});
