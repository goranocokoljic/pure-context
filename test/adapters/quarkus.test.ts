import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { quarkusAdapter } from '../../src/adapters/quarkus.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/quarkus-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-quarkus-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('quarkusAdapter metadata', () => {
  it('has name "quarkus"', () => {
    expect(quarkusAdapter.name).toBe('quarkus');
  });

  it('declares no extra extensions', () => {
    expect(quarkusAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('quarkusAdapter.detect', () => {
  it('detects via pom.xml with io.quarkus groupId', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>io.quarkus</groupId><artifactId>quarkus-resteasy-reactive</artifactId></dependency>\n',
    );
    expect(await quarkusAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via pom.xml with quarkus- artifactId', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>io.quarkus.platform</groupId><artifactId>quarkus-bom</artifactId></dependency>\n',
    );
    expect(await quarkusAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle.kts with io.quarkus', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'id("io.quarkus") version "3.8.0"\n');
    expect(await quarkusAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle with io.quarkus', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "id 'io.quarkus' version '3.8.0'\n");
    expect(await quarkusAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when quarkus is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pom.xml'), '<project><artifactId>other-spring-app</artifactId></project>\n');
    expect(await quarkusAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await quarkusAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture quarkus project via pom.xml', async () => {
    expect(await quarkusAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('quarkusAdapter.fileFilter', () => {
  it('accepts .java files', () => {
    expect(quarkusAdapter.fileFilter('UserResource.java')).toBe(true);
    expect(quarkusAdapter.fileFilter('src/main/java/com/example/App.java')).toBe(true);
  });

  it('accepts .kt files', () => {
    expect(quarkusAdapter.fileFilter('UserResource.kt')).toBe(true);
  });

  it('rejects non-JVM files', () => {
    expect(quarkusAdapter.fileFilter('pom.xml')).toBe(false);
    expect(quarkusAdapter.fileFilter('build.gradle')).toBe(false);
    expect(quarkusAdapter.fileFilter('App.ts')).toBe(false);
    expect(quarkusAdapter.fileFilter('application.properties')).toBe(false);
    expect(quarkusAdapter.fileFilter('UserResource.groovy')).toBe(false);
  });
});

// ─── JAX-RS @GET route extraction ─────────────────────────────────────────────

describe('quarkusAdapter — @GET routes', () => {
  it('extracts @GET route from @Path resource', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    public List<User> listUsers() { return List.of(); }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    const route = symbols.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.quarkus_route).toBe(true);
  });

  it('extracts @GET with sub-path from @Path on method', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    @Path("/{id}")
    public User getUser(Long id) { return null; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    const route = symbols.find((s) => s.name === 'GET /users/{id}');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/{id}');
  });

  it('extracts @POST route', () => {
    const source = `
@Path("/users")
public class UserResource {
    @POST
    public User createUser(User user) { return user; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @PUT, @DELETE, @PATCH routes', () => {
    const source = `
@Path("/items")
public class ItemResource {
    @PUT
    @Path("/{id}")
    public Item update(Long id, Item item) { return item; }

    @DELETE
    @Path("/{id}")
    public void delete(Long id) {}

    @PATCH
    @Path("/{id}")
    public Item patch(Long id, Item partial) { return partial; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'ItemResource.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('PUT /items/{id}');
    expect(names).toContain('DELETE /items/{id}');
    expect(names).toContain('PATCH /items/{id}');
  });
});

// ─── @Path resource class ─────────────────────────────────────────────────────

describe('quarkusAdapter — @Path resource class', () => {
  it('emits class symbol with quarkus_resource', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    public List<User> list() { return List.of(); }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    const cls = symbols.find((s) => s.name === 'UserResource');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.quarkus_resource).toBe(true);
    expect(cls!.frameworkMeta?.route_prefix).toBe('/users');
  });

  it('combines class prefix with method sub-path', () => {
    const source = `
@Path("/api/v1")
public class ApiResource {
    @GET
    @Path("/health")
    public String health() { return "UP"; }

    @POST
    @Path("/data")
    public String postData() { return "OK"; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'ApiResource.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /api/v1/health');
    expect(names).toContain('POST /api/v1/data');
  });

  it('handles multiple resource classes in one file', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    public List<User> list() { return List.of(); }
}

@Path("/orders")
class OrderResource {
    @GET
    public List<Order> listOrders() { return List.of(); }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'Resources.java');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /orders');
  });

  it('does not emit routes from non-resource classes', () => {
    const source = `
@ApplicationScoped
public class UserService {
    @GET
    public String notARoute() { return "nope"; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Path variable preservation ───────────────────────────────────────────────

describe('quarkusAdapter — path variables', () => {
  it('preserves {id} path variable in route_path', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    @Path("/{id}")
    public User getUser(Long id) { return null; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/users/{id}');
  });

  it('preserves nested path variables', () => {
    const source = `
@Path("/orgs/{orgId}")
public class ProjectResource {
    @GET
    @Path("/projects/{projectId}")
    public Project getProject(Long orgId, Long projectId) { return null; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'ProjectResource.java');
    const route = symbols.find((s) => s.kind === 'route');
    expect(route?.frameworkMeta?.route_path).toBe('/orgs/{orgId}/projects/{projectId}');
  });
});

// ─── @ApplicationScoped / @Singleton / @Dependent beans ─────────────────────

describe('quarkusAdapter — bean scopes', () => {
  it('emits class symbol for @ApplicationScoped with quarkus_bean', () => {
    const source = `
@ApplicationScoped
public class UserService {
    public List<User> findAll() { return List.of(); }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe('class');
    expect(svc!.frameworkMeta?.quarkus_bean).toBe(true);
  });

  it('emits class symbol for @Singleton with quarkus_bean', () => {
    const source = `
@Singleton
public class UserRepository {
    public User save(User user) { return user; }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserRepository.java');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    expect(repo).toBeDefined();
    expect(repo!.frameworkMeta?.quarkus_bean).toBe(true);
  });

  it('emits class symbol for @Dependent with quarkus_bean', () => {
    const source = `
@Dependent
public class RequestContext {
    private String requestId;
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'RequestContext.java');
    const ctx = symbols.find((s) => s.name === 'RequestContext');
    expect(ctx).toBeDefined();
    expect(ctx!.frameworkMeta?.quarkus_bean).toBe(true);
  });

  it('does not emit bean for undecorated classes', () => {
    const source = `
public class PlainClass {
    public void doSomething() {}
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'Plain.java');
    expect(symbols).toHaveLength(0);
  });
});

// ─── @RegisterRestClient interface ────────────────────────────────────────────

describe('quarkusAdapter — @RegisterRestClient', () => {
  it('emits interface symbol for @RegisterRestClient with quarkus_client', () => {
    const source = `
@RegisterRestClient(baseUri = "http://user-service/api")
public interface UserClient {
    @GET
    List<User> findAll();
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserClient.java');
    const client = symbols.find((s) => s.name === 'UserClient');
    expect(client).toBeDefined();
    expect(client!.kind).toBe('interface');
    expect(client!.frameworkMeta?.quarkus_client).toBe(true);
  });

  it('emits multiple @RegisterRestClient interfaces from one file', () => {
    const source = `
@RegisterRestClient(baseUri = "http://user-service")
public interface UserClient {
    @GET
    List<User> list();
}

@RegisterRestClient(configKey = "order-service")
interface OrderClient {
    @GET
    List<Object> list();
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'Clients.java');
    const clientNames = symbols
      .filter((s) => s.frameworkMeta?.quarkus_client)
      .map((s) => s.name);
    expect(clientNames).toContain('UserClient');
    expect(clientNames).toContain('OrderClient');
  });

  it('emits client without base_path when @RegisterRestClient has no string arg', () => {
    const source = `
@RegisterRestClient
public interface HealthClient {
    @GET
    String health();
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'HealthClient.java');
    const client = symbols.find((s) => s.name === 'HealthClient');
    expect(client).toBeDefined();
    expect(client!.frameworkMeta?.quarkus_client).toBe(true);
  });
});

// ─── @Scheduled methods ───────────────────────────────────────────────────────

describe('quarkusAdapter — @Scheduled methods', () => {
  it('emits function symbol for @Scheduled method', () => {
    const source = `
@ApplicationScoped
public class TaskService {
    @Scheduled(every = "1h")
    public void runTask() {}
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'TaskService.java');
    const task = symbols.find((s) => s.name === 'runTask');
    expect(task).toBeDefined();
    expect(task!.kind).toBe('function');
    expect(task!.frameworkMeta?.quarkus_scheduled).toBe(true);
  });

  it('handles @Scheduled with cron expression', () => {
    const source = `
@ApplicationScoped
public class CronJob {
    @Scheduled(cron = "0 0 * * *")
    public void nightly() {}
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'CronJob.java');
    const task = symbols.find((s) => s.name === 'nightly');
    expect(task).toBeDefined();
    expect(task!.frameworkMeta?.quarkus_scheduled).toBe(true);
  });

  it('handles multiple @Scheduled methods', () => {
    const source = `
@ApplicationScoped
public class SchedulerService {
    @Scheduled(every = "5m")
    public void frequent() {}

    @Scheduled(cron = "0 0 * * *")
    public void nightly() {}
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'SchedulerService.java');
    const tasks = symbols.filter((s) => s.frameworkMeta?.quarkus_scheduled);
    expect(tasks).toHaveLength(2);
    const names = tasks.map((s) => s.name);
    expect(names).toContain('frequent');
    expect(names).toContain('nightly');
  });
});

// ─── Reactive @Route ──────────────────────────────────────────────────────────

describe('quarkusAdapter — reactive @Route', () => {
  it('emits route symbol with quarkus_reactive', () => {
    const source = `
@ApplicationScoped
public class ReactiveRoutes {
    @Route(path = "/health")
    public void health(RoutingContext rc) {
        rc.response().end("UP");
    }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'ReactiveRoutes.java');
    const route = symbols.find((s) => s.frameworkMeta?.quarkus_reactive);
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.quarkus_reactive).toBe(true);
    expect(route!.frameworkMeta?.route_path).toBe('/health');
  });

  it('handles @Route without explicit path', () => {
    const source = `
@ApplicationScoped
public class ReactiveRoutes {
    @Route
    public void index(RoutingContext rc) {
        rc.response().end("OK");
    }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'ReactiveRoutes.java');
    const route = symbols.find((s) => s.frameworkMeta?.quarkus_reactive);
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('quarkusAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
@Path("/users")
public class UserResource {
    @GET
    public List<User> a() { return List.of(); }
    @GET
    public List<User> b() { return List.of(); }
}
`;
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, buf(source), 'UserResource.java');
    expect(symbols.filter((s) => s.name === 'GET /users')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('quarkusAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'UserResource.java',
      startByte: 0,
      endByte: 0,
      signature: '@GET public List<User> listUsers(...)',
      summary: 'Quarkus route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', quarkus_route: true },
    };
    expect(quarkusAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('quarkusAdapter — fixture project', () => {
  it('detects fixture as quarkus project', async () => {
    expect(await quarkusAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('extracts JAX-RS routes from UserResource.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserResource.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserResource.java');
    const names = symbols.map((s) => s.name);

    // UserResource routes (with /users prefix)
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /users/{id}');
    expect(names).toContain('POST /users');
    expect(names).toContain('PUT /users/{id}');
    expect(names).toContain('DELETE /users/{id}');
    // OrderResource routes
    expect(names).toContain('GET /orders');
    expect(names).toContain('POST /orders');
  });

  it('emits resource class symbols from UserResource.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserResource.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserResource.java');
    const resourceNames = symbols
      .filter((s) => s.kind === 'class' && s.frameworkMeta?.quarkus_resource)
      .map((s) => s.name);
    expect(resourceNames).toContain('UserResource');
    expect(resourceNames).toContain('OrderResource');
  });

  it('extracts @ApplicationScoped and @Singleton beans from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const svc = symbols.find((s) => s.name === 'UserService');
    const repo = symbols.find((s) => s.name === 'UserRepository');
    expect(svc?.frameworkMeta?.quarkus_bean).toBe(true);
    expect(repo?.frameworkMeta?.quarkus_bean).toBe(true);
  });

  it('extracts @Scheduled tasks from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const scheduled = symbols.filter((s) => s.frameworkMeta?.quarkus_scheduled);
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    const names = scheduled.map((s) => s.name);
    expect(names).toContain('cleanupExpiredSessions');
    expect(names).toContain('nightly');
  });

  it('extracts reactive @Route from UserService.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserService.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserService.java');
    const reactiveRoutes = symbols.filter((s) => s.frameworkMeta?.quarkus_reactive);
    expect(reactiveRoutes.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts @RegisterRestClient interfaces from UserClient.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/UserClient.java'),
      'utf8',
    );
    const symbols = quarkusAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'UserClient.java');
    const clients = symbols.filter((s) => s.frameworkMeta?.quarkus_client);
    const clientNames = clients.map((s) => s.name);
    expect(clientNames).toContain('UserClient');
    expect(clientNames).toContain('OrderClient');
  });
});
