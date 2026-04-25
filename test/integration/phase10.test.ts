/**
 * Phase 10 Integration Tests — Task 89
 *
 * Validates all Phase 10 framework adapters end-to-end against representative fixtures.
 *
 *  1.  Axum: .route("/path", get(handler)) → route symbol with http_method + route_path
 *  2.  Axum: .nest("/prefix", router) → NEST route symbol with axum_nest: true
 *  3.  Axum: .layer(Middleware) → middleware symbol with axum_layer: true
 *  4.  Axum: #[derive(FromRequest)] / impl FromRequest → type with axum_extractor: true
 *  5.  Actix: #[get("/path")] macro → route with actix_route: true
 *  6.  Actix: #[post("/path")] macro → route with correct http_method
 *  7.  Actix: impl actix_web::FromRequest → type with actix_extractor: true
 *  8.  Rocket: #[get("/path")] → route with rocket_route: true
 *  9.  Rocket: #[catch(404)] → catcher with rocket_catcher: true + status_code
 *  10. Rocket: #[catch(default)] → catcher with status_code: null
 *  11. Rocket: impl Fairing → middleware with rocket_fairing: true
 *  12. Spring Boot: @GetMapping on controller → route with spring_route: true
 *  13. Spring Boot: @Service → class with spring_bean: true
 *  14. Spring Boot: @Scheduled → function with spring_scheduled: true
 *  15. Micronaut: @Get on controller → route with micronaut_route: true
 *  16. Micronaut: @Singleton → class with micronaut_bean: true
 *  17. Micronaut: @Client interface → interface with micronaut_client: true
 *  18. Quarkus: @GET (JAX-RS) → route with quarkus_route: true
 *  19. Quarkus: @ApplicationScoped → class with quarkus_bean: true
 *  20. Quarkus: @RegisterRestClient → interface with quarkus_client: true
 *  21. Hibernate: @Entity class → class with hibernate_entity: true + table_name
 *  22. Hibernate: @Column → const with column_name + nullable
 *  23. Hibernate: @Id → const with primary_key: true
 *  24. Hibernate: @OneToMany → const with relationship
 *  25. SQLAlchemy: Base subclass → class with sqlalchemy_model: true + table_name
 *  26. SQLAlchemy: Column(Integer) → const with column_type: 'INTEGER' + primary_key
 *  27. SQLAlchemy: relationship() → const with relationship target
 *  28. Django ORM: models.Model subclass → class with django_model: true + table_name
 *  29. Django ORM: ForeignKey → const with relationship: 'many_to_one'
 *  30. Django ORM: custom Manager → const with django_manager: true
 *  31. Regression: all Phase 1–9 TypeScript fixture still indexes cleanly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { rustHandler } from '../../src/handlers/rust.js';
import { javaHandler } from '../../src/handlers/java.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

import { axumAdapter } from '../../src/adapters/axum.js';
import { actixWebAdapter } from '../../src/adapters/actix-web.js';
import { rocketAdapter } from '../../src/adapters/rocket.js';
import { springBootAdapter } from '../../src/adapters/spring-boot.js';
import { micronautAdapter } from '../../src/adapters/micronaut.js';
import { quarkusAdapter } from '../../src/adapters/quarkus.js';
import { hibernateAdapter } from '../../src/adapters/hibernate.js';
import { sqlalchemyAdapter } from '../../src/adapters/sqlalchemy.js';
import { djangoOrmAdapter } from '../../src/adapters/django-orm.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const AXUM_FIXTURE        = resolve(__dirname, '../fixtures/axum-project');
const ACTIX_FIXTURE       = resolve(__dirname, '../fixtures/actix-project');
const ROCKET_FIXTURE      = resolve(__dirname, '../fixtures/rocket-project');
const SPRING_FIXTURE      = resolve(__dirname, '../fixtures/spring-boot-project');
const MICRONAUT_FIXTURE   = resolve(__dirname, '../fixtures/micronaut-project');
const QUARKUS_FIXTURE     = resolve(__dirname, '../fixtures/quarkus-project');
const HIBERNATE_FIXTURE   = resolve(__dirname, '../fixtures/hibernate-project');
const SQLALCHEMY_FIXTURE  = resolve(__dirname, '../fixtures/sqlalchemy-project');
const DJANGO_FIXTURE      = resolve(__dirname, '../fixtures/django-project');
const TS_FIXTURE          = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Shared state ──────────────────────────────────────────────────────────────

let axumRepoId:       string;
let actixRepoId:      string;
let rocketRepoId:     string;
let springRepoId:     string;
let micronautRepoId:  string;
let quarkusRepoId:    string;
let hibernateRepoId:  string;
let sqlalchemyRepoId: string;
let djangoRepoId:     string;
let tsRepoId:         string;

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(rustHandler);
  registerHandler(javaHandler);
  registerHandler(pythonHandler);

  await initParser();

  const [
    axumResult,
    actixResult,
    rocketResult,
    springResult,
    micronautResult,
    quarkusResult,
    hibernateResult,
    sqlalchemyResult,
    djangoResult,
    tsResult,
  ] = await Promise.all([
    indexFolder(AXUM_FIXTURE,       { adapters: [axumAdapter] }),
    indexFolder(ACTIX_FIXTURE,      { adapters: [actixWebAdapter] }),
    indexFolder(ROCKET_FIXTURE,     { adapters: [rocketAdapter] }),
    indexFolder(SPRING_FIXTURE,     { adapters: [springBootAdapter] }),
    indexFolder(MICRONAUT_FIXTURE,  { adapters: [micronautAdapter] }),
    indexFolder(QUARKUS_FIXTURE,    { adapters: [quarkusAdapter] }),
    indexFolder(HIBERNATE_FIXTURE,  { adapters: [hibernateAdapter] }),
    indexFolder(SQLALCHEMY_FIXTURE, { adapters: [sqlalchemyAdapter] }),
    indexFolder(DJANGO_FIXTURE,     { adapters: [djangoOrmAdapter] }),
    indexFolder(TS_FIXTURE),
  ]);

  axumRepoId       = axumResult.repoId;
  actixRepoId      = actixResult.repoId;
  rocketRepoId     = rocketResult.repoId;
  springRepoId     = springResult.repoId;
  micronautRepoId  = micronautResult.repoId;
  quarkusRepoId    = quarkusResult.repoId;
  hibernateRepoId  = hibernateResult.repoId;
  sqlalchemyRepoId = sqlalchemyResult.repoId;
  djangoRepoId     = djangoResult.repoId;
  tsRepoId         = tsResult.repoId;

  expect(axumResult.symbolsFound).toBeGreaterThan(0);
  expect(actixResult.symbolsFound).toBeGreaterThan(0);
  expect(rocketResult.symbolsFound).toBeGreaterThan(0);
  expect(springResult.symbolsFound).toBeGreaterThan(0);
  expect(micronautResult.symbolsFound).toBeGreaterThan(0);
  expect(quarkusResult.symbolsFound).toBeGreaterThan(0);
  expect(hibernateResult.symbolsFound).toBeGreaterThan(0);
  expect(sqlalchemyResult.symbolsFound).toBeGreaterThan(0);
  expect(djangoResult.symbolsFound).toBeGreaterThan(0);
}, 90_000);

afterAll(() => {
  for (const id of [
    axumRepoId, actixRepoId, rocketRepoId, springRepoId,
    micronautRepoId, quarkusRepoId, hibernateRepoId,
    sqlalchemyRepoId, djangoRepoId, tsRepoId,
  ]) {
    if (id) deleteIndex(id);
  }
});

// ─── 1. Axum: .route() → route symbol ─────────────────────────────────────────

describe('1. Axum: .route("/path", get(handler)) → route symbol', () => {
  it('GET /health route is extracted with http_method GET', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'GET /health', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.frameworkMeta?.route_path === '/health' && s.frameworkMeta?.http_method === 'GET');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.axum_route).toBe(true);
  });

  it('GET / route (from user sub-router) is extracted', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, '', { kind: 'route' });
    db.close();
    // Sub-router defines route at "/" which gets nested under "/users"
    const route = results.find((s) => s.frameworkMeta?.route_path === '/' && s.frameworkMeta?.http_method === 'GET');
    expect(route).toBeDefined();
  });

  it('POST / route (from user sub-router) is extracted', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.frameworkMeta?.route_path === '/' && s.frameworkMeta?.http_method === 'POST');
    expect(route).toBeDefined();
  });

  it('path with :id parameter is preserved', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      typeof s.frameworkMeta?.route_path === 'string' &&
      (s.frameworkMeta.route_path as string).includes(':id'),
    );
    expect(route).toBeDefined();
  });
});

// ─── 2. Axum: .nest() → NEST route symbol ─────────────────────────────────────

describe('2. Axum: .nest("/prefix", router) → NEST route symbol', () => {
  it('NEST /users symbol is extracted', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'NEST /users', { kind: 'route' });
    db.close();
    const nest = results.find((s) => s.frameworkMeta?.axum_nest === true && s.frameworkMeta?.route_path === '/users');
    expect(nest).toBeDefined();
  });

  it('NEST /items symbol is extracted', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'NEST /items', { kind: 'route' });
    db.close();
    const nest = results.find((s) => s.frameworkMeta?.axum_nest === true && s.frameworkMeta?.route_path === '/items');
    expect(nest).toBeDefined();
  });
});

// ─── 3. Axum: .layer() → middleware symbol ────────────────────────────────────

describe('3. Axum: .layer(Middleware) → middleware symbol', () => {
  it('CorsLayer middleware extracted with axum_layer: true', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'CorsLayer', { kind: 'middleware' });
    db.close();
    const mw = results.find((s) => s.frameworkMeta?.axum_layer === true);
    expect(mw).toBeDefined();
  });

  it('TraceLayer middleware extracted', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'TraceLayer', { kind: 'middleware' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── 4. Axum: FromRequest → extractor ─────────────────────────────────────────

describe('4. Axum: FromRequest → type with axum_extractor: true', () => {
  it('#[derive(FromRequest)] emits type with axum_extractor', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'CreateUserPayload');
    db.close();
    const extractor = results.find((s) => s.frameworkMeta?.axum_extractor === true);
    expect(extractor).toBeDefined();
  });

  it('impl FromRequest for AuthUser emits type with axum_extractor', () => {
    const db = openDatabase(axumRepoId);
    const results = searchSymbols(db, axumRepoId, 'AuthUser');
    db.close();
    const extractor = results.find((s) => s.frameworkMeta?.axum_extractor === true);
    expect(extractor).toBeDefined();
  });
});

// ─── 5. Actix: #[get] macro → route ───────────────────────────────────────────

describe('5. Actix: #[get("/path")] macro → route with actix_route: true', () => {
  it('#[get("/health")] produces route at /health', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.route_path === '/health' && s.frameworkMeta?.http_method === 'GET',
    );
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.actix_route).toBe(true);
  });

  it('#[get("/users")] produces route', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.route_path === '/users' && s.frameworkMeta?.http_method === 'GET',
    );
    expect(route).toBeDefined();
  });

  it('path with {id} is preserved', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      typeof s.frameworkMeta?.route_path === 'string' &&
      (s.frameworkMeta.route_path as string).includes('{id}'),
    );
    expect(route).toBeDefined();
  });
});

// ─── 6. Actix: #[post] macro → correct http_method ────────────────────────────

describe('6. Actix: #[post("/path")] → route with http_method POST', () => {
  it('#[post("/users")] produces POST route', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.route_path === '/users' && s.frameworkMeta?.http_method === 'POST',
    );
    expect(route).toBeDefined();
  });

  it('#[delete("/users/{id}")] produces DELETE route', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'DELETE' &&
      typeof s.frameworkMeta?.route_path === 'string' &&
      (s.frameworkMeta.route_path as string).includes('{id}'),
    );
    expect(route).toBeDefined();
  });
});

// ─── 7. Actix: FromRequest → extractor ────────────────────────────────────────

describe('7. Actix: impl actix_web::FromRequest → type with actix_extractor: true', () => {
  it('impl actix_web::FromRequest for AuthUser emits type with actix_extractor', () => {
    const db = openDatabase(actixRepoId);
    const results = searchSymbols(db, actixRepoId, 'AuthUser');
    db.close();
    const extractor = results.find((s) => s.frameworkMeta?.actix_extractor === true);
    expect(extractor).toBeDefined();
  });
});

// ─── 8. Rocket: #[get] → route ────────────────────────────────────────────────

describe('8. Rocket: #[get("/path")] → route with rocket_route: true', () => {
  it('#[get("/health")] produces route at /health', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.route_path === '/health' && s.frameworkMeta?.http_method === 'GET',
    );
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.rocket_route).toBe(true);
  });

  it('#[get("/users")] produces GET route', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.route_path === '/users' && s.frameworkMeta?.http_method === 'GET',
    );
    expect(route).toBeDefined();
  });

  it('path with <id> parameter is preserved', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      typeof s.frameworkMeta?.route_path === 'string' &&
      (s.frameworkMeta.route_path as string).includes('<id>'),
    );
    expect(route).toBeDefined();
  });
});

// ─── 9. Rocket: #[catch(404)] → catcher ───────────────────────────────────────

describe('9. Rocket: #[catch(404)] → catcher with rocket_catcher: true + status_code', () => {
  it('#[catch(404)] produces catcher with status_code 404', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const catcher = results.find((s) =>
      s.frameworkMeta?.rocket_catcher === true && s.frameworkMeta?.status_code === 404,
    );
    expect(catcher).toBeDefined();
  });

  it('#[catch(500)] produces catcher with status_code 500', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const catcher = results.find((s) =>
      s.frameworkMeta?.rocket_catcher === true && s.frameworkMeta?.status_code === 500,
    );
    expect(catcher).toBeDefined();
  });
});

// ─── 10. Rocket: #[catch(default)] → status_code null ────────────────────────

describe('10. Rocket: #[catch(default)] → catcher with status_code: null', () => {
  it('#[catch(default)] produces catcher with status_code null', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, '', { kind: 'route' });
    db.close();
    const catcher = results.find((s) =>
      s.frameworkMeta?.rocket_catcher === true && s.frameworkMeta?.status_code === null,
    );
    expect(catcher).toBeDefined();
  });
});

// ─── 11. Rocket: Fairing → middleware ─────────────────────────────────────────

describe('11. Rocket: impl Fairing → middleware with rocket_fairing: true', () => {
  it('AuthFairing is extracted as kind "middleware" with rocket_fairing: true', () => {
    const db = openDatabase(rocketRepoId);
    const results = searchSymbols(db, rocketRepoId, 'AuthFairing', { kind: 'middleware' });
    db.close();
    const fairing = results.find((s) => s.frameworkMeta?.rocket_fairing === true);
    expect(fairing).toBeDefined();
  });
});

// ─── 12. Spring Boot: @GetMapping → route ─────────────────────────────────────

describe('12. Spring Boot: @GetMapping → route with spring_route: true', () => {
  it('@GetMapping on UserController produces GET /users route', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'GET' &&
      s.frameworkMeta?.spring_route === true &&
      s.frameworkMeta?.route_path === '/users',
    );
    expect(route).toBeDefined();
  });

  it('@PostMapping on UserController produces POST /users route', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'POST' &&
      s.frameworkMeta?.spring_route === true &&
      s.frameworkMeta?.route_path === '/users',
    );
    expect(route).toBeDefined();
  });

  it('@DeleteMapping combines class prefix with method path', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'DELETE' &&
      typeof s.frameworkMeta?.route_path === 'string' &&
      (s.frameworkMeta.route_path as string).startsWith('/users'),
    );
    expect(route).toBeDefined();
  });

  it('multiple controllers produce routes (UserController + PageController)', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, '', { kind: 'route' });
    db.close();
    // PageController has routes at / and /about
    const indexRoute = results.find((s) => s.frameworkMeta?.route_path === '/');
    expect(indexRoute).toBeDefined();
  });
});

// ─── 13. Spring Boot: @Service → bean ─────────────────────────────────────────

describe('13. Spring Boot: @Service/@Repository/@Component → class with spring_bean: true', () => {
  it('@Service UserService produces class with spring_bean: true', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, 'UserService', { kind: 'class' });
    db.close();
    const svc = results.find((s) => s.frameworkMeta?.spring_bean === true);
    expect(svc).toBeDefined();
  });

  it('@Repository UserRepository produces class with spring_bean: true', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, 'UserRepository', { kind: 'class' });
    db.close();
    const repo = results.find((s) => s.frameworkMeta?.spring_bean === true);
    expect(repo).toBeDefined();
  });

  it('@Component AuditLogger produces class with spring_bean: true', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, 'AuditLogger', { kind: 'class' });
    db.close();
    const comp = results.find((s) => s.frameworkMeta?.spring_bean === true);
    expect(comp).toBeDefined();
  });
});

// ─── 14. Spring Boot: @Scheduled → function ───────────────────────────────────

describe('14. Spring Boot: @Scheduled → function with spring_scheduled: true', () => {
  it('cleanupExpiredSessions method is extracted with spring_scheduled: true', () => {
    const db = openDatabase(springRepoId);
    const results = searchSymbols(db, springRepoId, 'cleanupExpiredSessions');
    db.close();
    const task = results.find((s) => s.frameworkMeta?.spring_scheduled === true);
    expect(task).toBeDefined();
  });
});

// ─── 15. Micronaut: @Get → route ──────────────────────────────────────────────

describe('15. Micronaut: @Get on controller → route with micronaut_route: true', () => {
  it('@Get on UserController produces GET /users route', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'GET' &&
      s.frameworkMeta?.micronaut_route === true &&
      s.frameworkMeta?.route_path === '/users',
    );
    expect(route).toBeDefined();
  });

  it('@Get("/{id}") combined with @Controller("/users") produces /users/{id} route', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.micronaut_route === true &&
      s.frameworkMeta?.route_path === '/users/{id}',
    );
    expect(route).toBeDefined();
  });

  it('@Post on UserController produces POST route', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'POST' &&
      s.frameworkMeta?.micronaut_route === true,
    );
    expect(route).toBeDefined();
  });
});

// ─── 16. Micronaut: @Singleton → bean ─────────────────────────────────────────

describe('16. Micronaut: @Singleton → class with micronaut_bean: true', () => {
  it('@Singleton UserService produces class with micronaut_bean: true', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, 'UserService', { kind: 'class' });
    db.close();
    const bean = results.find((s) => s.frameworkMeta?.micronaut_bean === true);
    expect(bean).toBeDefined();
  });

  it('@Singleton UserRepository produces class with micronaut_bean: true', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, 'UserRepository', { kind: 'class' });
    db.close();
    const bean = results.find((s) => s.frameworkMeta?.micronaut_bean === true);
    expect(bean).toBeDefined();
  });
});

// ─── 17. Micronaut: @Client → interface ───────────────────────────────────────

describe('17. Micronaut: @Client interface → interface with micronaut_client: true', () => {
  it('UserClient interface extracted with micronaut_client: true', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, 'UserClient', { kind: 'interface' });
    db.close();
    const client = results.find((s) => s.frameworkMeta?.micronaut_client === true);
    expect(client).toBeDefined();
  });

  it('ApiClient interface extracted with micronaut_client: true', () => {
    const db = openDatabase(micronautRepoId);
    const results = searchSymbols(db, micronautRepoId, 'ApiClient', { kind: 'interface' });
    db.close();
    const client = results.find((s) => s.frameworkMeta?.micronaut_client === true);
    expect(client).toBeDefined();
  });
});

// ─── 18. Quarkus: @GET (JAX-RS) → route ───────────────────────────────────────

describe('18. Quarkus: @GET (JAX-RS) → route with quarkus_route: true', () => {
  it('@GET on UserResource produces GET /users route', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'GET' &&
      s.frameworkMeta?.quarkus_route === true &&
      s.frameworkMeta?.route_path === '/users',
    );
    expect(route).toBeDefined();
  });

  it('@POST on UserResource produces POST /users route', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.http_method === 'POST' &&
      s.frameworkMeta?.quarkus_route === true &&
      s.frameworkMeta?.route_path === '/users',
    );
    expect(route).toBeDefined();
  });

  it('@GET @Path("/{id}") combined with class @Path("/users") → /users/{id}', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, '', { kind: 'route' });
    db.close();
    const route = results.find((s) =>
      s.frameworkMeta?.quarkus_route === true &&
      s.frameworkMeta?.route_path === '/users/{id}',
    );
    expect(route).toBeDefined();
  });
});

// ─── 19. Quarkus: @ApplicationScoped → bean ───────────────────────────────────

describe('19. Quarkus: @ApplicationScoped → class with quarkus_bean: true', () => {
  it('@ApplicationScoped UserService produces class with quarkus_bean: true', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, 'UserService', { kind: 'class' });
    db.close();
    const bean = results.find((s) => s.frameworkMeta?.quarkus_bean === true);
    expect(bean).toBeDefined();
  });

  it('@Singleton UserRepository produces class with quarkus_bean: true', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, 'UserRepository', { kind: 'class' });
    db.close();
    const bean = results.find((s) => s.frameworkMeta?.quarkus_bean === true);
    expect(bean).toBeDefined();
  });
});

// ─── 20. Quarkus: @RegisterRestClient → interface ─────────────────────────────

describe('20. Quarkus: @RegisterRestClient → interface with quarkus_client: true', () => {
  it('UserClient interface extracted with quarkus_client: true', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, 'UserClient', { kind: 'interface' });
    db.close();
    const client = results.find((s) => s.frameworkMeta?.quarkus_client === true);
    expect(client).toBeDefined();
  });

  it('OrderClient interface extracted with quarkus_client: true', () => {
    const db = openDatabase(quarkusRepoId);
    const results = searchSymbols(db, quarkusRepoId, 'OrderClient', { kind: 'interface' });
    db.close();
    const client = results.find((s) => s.frameworkMeta?.quarkus_client === true);
    expect(client).toBeDefined();
  });
});

// ─── 21. Hibernate: @Entity → class with table_name ──────────────────────────

describe('21. Hibernate: @Entity class → class with hibernate_entity: true + table_name', () => {
  it('User entity extracted with hibernate_entity: true', () => {
    const db = openDatabase(hibernateRepoId);
    const results = searchSymbols(db, hibernateRepoId, 'User', { kind: 'class' });
    db.close();
    const entity = results.find((s) => s.frameworkMeta?.hibernate_entity === true);
    expect(entity).toBeDefined();
  });

  it('User entity has table_name "users" from @Table(name = "users")', () => {
    const db = openDatabase(hibernateRepoId);
    const results = searchSymbols(db, hibernateRepoId, 'User', { kind: 'class' });
    db.close();
    const entity = results.find((s) => s.frameworkMeta?.hibernate_entity === true);
    expect(entity).toBeDefined();
    expect(entity!.frameworkMeta?.table_name).toBe('users');
  });

  it('Product entity extracted with hibernate_entity: true', () => {
    const db = openDatabase(hibernateRepoId);
    const results = searchSymbols(db, hibernateRepoId, 'Product', { kind: 'class' });
    db.close();
    const entity = results.find((s) => s.frameworkMeta?.hibernate_entity === true);
    expect(entity).toBeDefined();
  });
});

// ─── 22. Hibernate: @Column → const with column_name + nullable ───────────────

describe('22. Hibernate: @Column → const with column_name + nullable', () => {
  it('@Column(name = "email", nullable = false) → column_name "email", nullable false', () => {
    const db = openDatabase(hibernateRepoId);
    const results = searchSymbols(db, hibernateRepoId, 'email', { kind: 'const' });
    db.close();
    const col = results.find((s) =>
      s.frameworkMeta?.column_name === 'email' && s.frameworkMeta?.nullable === false,
    );
    expect(col).toBeDefined();
  });
});

// ─── 23. Hibernate: @Id → primary_key ─────────────────────────────────────────

describe('23. Hibernate: @Id → const with primary_key: true', () => {
  it('@Id Long id field extracted with primary_key: true', () => {
    const db = openDatabase(hibernateRepoId);
    const all = searchSymbols(db, hibernateRepoId, 'id', { kind: 'const' });
    db.close();
    const pk = all.find((s) => s.frameworkMeta?.primary_key === true);
    expect(pk).toBeDefined();
  });
});

// ─── 24. Hibernate: @OneToMany → relationship ─────────────────────────────────

describe('24. Hibernate: @OneToMany → const with relationship', () => {
  it('@OneToMany orders field extracted with relationship "OneToMany"', () => {
    const db = openDatabase(hibernateRepoId);
    const results = searchSymbols(db, hibernateRepoId, 'orders', { kind: 'const' });
    db.close();
    const rel = results.find((s) => s.frameworkMeta?.relationship === 'OneToMany');
    expect(rel).toBeDefined();
  });
});

// ─── 25. SQLAlchemy: Base subclass → model ────────────────────────────────────

describe('25. SQLAlchemy: Base subclass → class with sqlalchemy_model: true + table_name', () => {
  it('User(Base) extracted with sqlalchemy_model: true', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'User', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.sqlalchemy_model === true);
    expect(model).toBeDefined();
  });

  it('User model has table_name "users"', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'User', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.sqlalchemy_model === true);
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.table_name).toBe('users');
  });

  it('Order(Base) extracted with sqlalchemy_model: true', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'Order', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.sqlalchemy_model === true);
    expect(model).toBeDefined();
  });
});

// ─── 26. SQLAlchemy: Column(Integer) → const with column_type + primary_key ───

describe('26. SQLAlchemy: Column(Integer) → const with column_type + primary_key', () => {
  it('id = Column(Integer, primary_key=True) → primary_key: true, column_type: "INTEGER"', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'id', { kind: 'const' });
    db.close();
    const pk = results.find((s) =>
      s.frameworkMeta?.primary_key === true && s.frameworkMeta?.column_type === 'INTEGER',
    );
    expect(pk).toBeDefined();
  });

  it('username Column(String) → column_type: "VARCHAR"', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'username', { kind: 'const' });
    db.close();
    const col = results.find((s) => s.frameworkMeta?.column_type === 'VARCHAR');
    expect(col).toBeDefined();
  });
});

// ─── 27. SQLAlchemy: relationship() → const with relationship target ──────────

describe('27. SQLAlchemy: relationship() → const with relationship target', () => {
  it('orders = relationship("Order") → const with relationship: "Order"', () => {
    const db = openDatabase(sqlalchemyRepoId);
    const results = searchSymbols(db, sqlalchemyRepoId, 'orders', { kind: 'const' });
    db.close();
    const rel = results.find((s) => s.frameworkMeta?.relationship === 'Order');
    expect(rel).toBeDefined();
  });
});

// ─── 28. Django ORM: models.Model → class with django_model + table_name ──────

describe('28. Django ORM: models.Model subclass → class with django_model: true + table_name', () => {
  it('User(models.Model) extracted with django_model: true', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'User', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.django_model === true);
    expect(model).toBeDefined();
  });

  it('User has table_name "auth_user" from Meta.db_table', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'User', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.django_model === true);
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.table_name).toBe('auth_user');
  });

  it('Post(models.Model) extracted with django_model: true', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'Post', { kind: 'class' });
    db.close();
    const model = results.find((s) => s.frameworkMeta?.django_model === true);
    expect(model).toBeDefined();
  });

  it('PlainPythonClass is NOT extracted as a django model', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'PlainPythonClass', { kind: 'class' });
    db.close();
    const djangoModel = results.find((s) => s.frameworkMeta?.django_model === true);
    expect(djangoModel).toBeUndefined();
  });
});

// ─── 29. Django ORM: ForeignKey → relationship many_to_one ───────────────────

describe('29. Django ORM: ForeignKey → const with relationship: "many_to_one"', () => {
  it('author = ForeignKey(User) → const with relationship: "many_to_one"', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'author', { kind: 'const' });
    db.close();
    const rel = results.find((s) => s.frameworkMeta?.relationship === 'many_to_one');
    expect(rel).toBeDefined();
  });

  it('posts = ManyToManyField → const with relationship: "many_to_many"', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'posts', { kind: 'const' });
    db.close();
    const rel = results.find((s) => s.frameworkMeta?.relationship === 'many_to_many');
    expect(rel).toBeDefined();
  });

  it('user = OneToOneField → const with relationship: "one_to_one"', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'user', { kind: 'const' });
    db.close();
    const rel = results.find((s) => s.frameworkMeta?.relationship === 'one_to_one');
    expect(rel).toBeDefined();
  });
});

// ─── 30. Django ORM: custom Manager → django_manager ─────────────────────────

describe('30. Django ORM: custom Manager → const with django_manager: true', () => {
  it('objects = UserManager() → const with django_manager: true', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'objects', { kind: 'const' });
    db.close();
    const mgr = results.find((s) => s.frameworkMeta?.django_manager === true);
    expect(mgr).toBeDefined();
  });
});

// ─── 31. Regression: TypeScript fixture still indexes cleanly ─────────────────

describe('31. Regression: Phase 1–9 TypeScript fixture still indexes cleanly', () => {
  it('basic-ts-project produces symbols', () => {
    const db = openDatabase(tsRepoId);
    const results = searchSymbols(db, tsRepoId, '', { limit: 50 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('TypeScript symbols have no Phase 10 adapter contamination', () => {
    const db = openDatabase(tsRepoId);
    const all = searchSymbols(db, tsRepoId, '', { limit: 200 });
    db.close();
    const contaminated = all.filter((s) =>
      s.frameworkMeta?.axum_route ||
      s.frameworkMeta?.actix_route ||
      s.frameworkMeta?.rocket_route ||
      s.frameworkMeta?.spring_route ||
      s.frameworkMeta?.micronaut_route ||
      s.frameworkMeta?.quarkus_route ||
      s.frameworkMeta?.hibernate_entity ||
      s.frameworkMeta?.sqlalchemy_model ||
      s.frameworkMeta?.django_model,
    );
    expect(contaminated).toHaveLength(0);
  });

  it('all Phase 10 repos have distinct repoIds', () => {
    const ids = new Set([
      axumRepoId, actixRepoId, rocketRepoId, springRepoId,
      micronautRepoId, quarkusRepoId, hibernateRepoId,
      sqlalchemyRepoId, djangoRepoId, tsRepoId,
    ]);
    expect(ids.size).toBe(10);
  });
});
