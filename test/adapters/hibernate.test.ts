import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { hibernateAdapter } from '../../src/adapters/hibernate.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/hibernate-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-hibernate-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('hibernateAdapter metadata', () => {
  it('has name "hibernate"', () => {
    expect(hibernateAdapter.name).toBe('hibernate');
  });

  it('declares no extra extensions', () => {
    expect(hibernateAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('hibernateAdapter.detect', () => {
  it('detects via pom.xml with hibernate-core', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><artifactId>hibernate-core</artifactId></dependency>\n',
    );
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via pom.xml with jakarta.persistence', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>jakarta.persistence</groupId><artifactId>jakarta.persistence-api</artifactId></dependency>\n',
    );
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via pom.xml with spring-boot-starter-data-jpa', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>\n',
    );
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle with hibernate-core', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "implementation 'org.hibernate:hibernate-core:6.4'\n");
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via build.gradle.kts with data-jpa', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'implementation("org.springframework.boot:spring-boot-starter-data-jpa")\n');
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via persistence.xml', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'src/main/resources/META-INF'), { recursive: true });
    writeFileSync(join(dir, 'src/main/resources/META-INF/persistence.xml'), '<persistence/>\n');
    expect(await hibernateAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when hibernate is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pom.xml'), '<project><artifactId>plain-app</artifactId></project>\n');
    expect(await hibernateAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await hibernateAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture hibernate project', async () => {
    expect(await hibernateAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('hibernateAdapter.fileFilter', () => {
  it('accepts .java files', () => {
    expect(hibernateAdapter.fileFilter('User.java')).toBe(true);
    expect(hibernateAdapter.fileFilter('src/main/java/com/example/Order.java')).toBe(true);
  });

  it('accepts .kt files', () => {
    expect(hibernateAdapter.fileFilter('User.kt')).toBe(true);
  });

  it('rejects non-JVM files', () => {
    expect(hibernateAdapter.fileFilter('pom.xml')).toBe(false);
    expect(hibernateAdapter.fileFilter('build.gradle')).toBe(false);
    expect(hibernateAdapter.fileFilter('App.ts')).toBe(false);
    expect(hibernateAdapter.fileFilter('application.properties')).toBe(false);
    expect(hibernateAdapter.fileFilter('persistence.xml')).toBe(false);
  });
});

// ─── @Entity class extraction ─────────────────────────────────────────────────

describe('hibernateAdapter — @Entity class', () => {
  it('emits class symbol with hibernate_entity', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const entity = symbols.find((s) => s.name === 'User');
    expect(entity).toBeDefined();
    expect(entity!.kind).toBe('class');
    expect(entity!.frameworkMeta?.hibernate_entity).toBe(true);
  });

  it('derives default table name via snake_case', () => {
    const source = `
@Entity
public class UserProfile {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'UserProfile.java');
    const entity = symbols.find((s) => s.name === 'UserProfile');
    expect(entity?.frameworkMeta?.table_name).toBe('user_profile');
  });

  it('uses @Table(name = ...) for table name', () => {
    const source = `
@Entity
@Table(name = "users")
public class User {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const entity = symbols.find((s) => s.name === 'User');
    expect(entity?.frameworkMeta?.table_name).toBe('users');
  });

  it('does not emit entity for plain class without @Entity', () => {
    const source = `
public class PlainHelper {
    private String value;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'PlainHelper.java');
    expect(symbols.filter((s) => s.frameworkMeta?.hibernate_entity)).toHaveLength(0);
  });
});

// ─── @Id and @GeneratedValue ──────────────────────────────────────────────────

describe('hibernateAdapter — @Id primary key', () => {
  it('marks @Id field with primary_key: true', () => {
    const source = `
@Entity
public class Product {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Product.java');
    const pk = symbols.find((s) => s.frameworkMeta?.primary_key === true);
    expect(pk).toBeDefined();
    expect(pk!.name).toBe('Product.id');
    expect(pk!.kind).toBe('const');
  });

  it('adds generated: true when @GeneratedValue present', () => {
    const source = `
@Entity
public class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Product.java');
    const pk = symbols.find((s) => s.frameworkMeta?.primary_key === true);
    expect(pk?.frameworkMeta?.generated).toBe(true);
  });

  it('infers column_type BIGINT for Long id', () => {
    const source = `
@Entity
public class Order {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Order.java');
    const pk = symbols.find((s) => s.frameworkMeta?.primary_key);
    expect(pk?.frameworkMeta?.column_type).toBe('BIGINT');
  });
});

// ─── @Column field extraction ─────────────────────────────────────────────────

describe('hibernateAdapter — @Column fields', () => {
  it('extracts @Column with custom name', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;

    @Column(name = "email")
    private String email;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const col = symbols.find((s) => s.name === 'User.email');
    expect(col).toBeDefined();
    expect(col!.kind).toBe('const');
    expect(col!.frameworkMeta?.column_name).toBe('email');
    expect(col!.frameworkMeta?.column_type).toBe('VARCHAR');
  });

  it('derives default column_name via snake_case when @Column has no name', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;

    @Column
    private String fullName;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const col = symbols.find((s) => s.name === 'User.fullName');
    expect(col?.frameworkMeta?.column_name).toBe('full_name');
  });

  it('captures nullable = false', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;

    @Column(nullable = false)
    private String email;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const col = symbols.find((s) => s.name === 'User.email');
    expect(col?.frameworkMeta?.nullable).toBe(false);
  });

  it('captures nullable = true', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;

    @Column(nullable = true)
    private String notes;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const col = symbols.find((s) => s.name === 'User.notes');
    expect(col?.frameworkMeta?.nullable).toBe(true);
  });

  it('does not emit field symbols outside @Entity class', () => {
    const source = `
public class Helper {
    @Column
    private String value;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Helper.java');
    expect(symbols.filter((s) => s.kind === 'const')).toHaveLength(0);
  });

  it('infers SQL types from Java types', () => {
    const source = `
@Entity
public class Types {
    @Id
    private Long id;

    @Column
    private String strField;

    @Column
    private Integer intField;

    @Column
    private Boolean boolField;

    @Column
    private BigDecimal decField;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Types.java');
    const get = (n: string) => symbols.find((s) => s.name === `Types.${n}`);
    expect(get('strField')?.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(get('intField')?.frameworkMeta?.column_type).toBe('INTEGER');
    expect(get('boolField')?.frameworkMeta?.column_type).toBe('BOOLEAN');
    expect(get('decField')?.frameworkMeta?.column_type).toBe('DECIMAL');
  });
});

// ─── Relationship annotations ─────────────────────────────────────────────────

describe('hibernateAdapter — relationships', () => {
  it('extracts @OneToMany relationship', () => {
    const source = `
@Entity
public class User {
    @Id
    private Long id;

    @OneToMany(mappedBy = "user")
    private List<Order> orders;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const rel = symbols.find((s) => s.name === 'User.orders');
    expect(rel).toBeDefined();
    expect(rel!.kind).toBe('const');
    expect(rel!.frameworkMeta?.relationship).toBe('OneToMany');
    expect(rel!.frameworkMeta?.target_entity).toBe('Order');
  });

  it('extracts @ManyToOne relationship', () => {
    const source = `
@Entity
public class Order {
    @Id
    private Long id;

    @ManyToOne
    private User user;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Order.java');
    const rel = symbols.find((s) => s.name === 'Order.user');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('ManyToOne');
    expect(rel!.frameworkMeta?.target_entity).toBe('User');
  });

  it('extracts @OneToOne relationship', () => {
    const source = `
@Entity
public class Product {
    @Id
    private Long id;

    @OneToOne
    private ProductDetail detail;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Product.java');
    const rel = symbols.find((s) => s.name === 'Product.detail');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('OneToOne');
    expect(rel!.frameworkMeta?.target_entity).toBe('ProductDetail');
  });

  it('extracts @ManyToMany relationship', () => {
    const source = `
@Entity
public class Order {
    @Id
    private Long id;

    @ManyToMany
    private List<Product> products;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Order.java');
    const rel = symbols.find((s) => s.name === 'Order.products');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('ManyToMany');
    expect(rel!.frameworkMeta?.target_entity).toBe('Product');
  });
});

// ─── @NamedQuery ──────────────────────────────────────────────────────────────

describe('hibernateAdapter — @NamedQuery', () => {
  it('emits function symbol for @NamedQuery', () => {
    const source = `
@Entity
@NamedQuery(name = "User.findByEmail", query = "SELECT u FROM User u WHERE u.email = :email")
public class User {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const nq = symbols.find((s) => s.name === 'User.findByEmail');
    expect(nq).toBeDefined();
    expect(nq!.kind).toBe('function');
    expect(nq!.frameworkMeta?.hibernate_query).toBe(true);
    expect(nq!.frameworkMeta?.query_string).toBe('SELECT u FROM User u WHERE u.email = :email');
  });

  it('emits multiple @NamedQuery annotations', () => {
    const source = `
@Entity
@NamedQuery(name = "User.findByEmail", query = "SELECT u FROM User u WHERE u.email = :email")
@NamedQuery(name = "User.findActive", query = "SELECT u FROM User u WHERE u.active = true")
public class User {
    @Id
    private Long id;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'User.java');
    const queries = symbols.filter((s) => s.frameworkMeta?.hibernate_query);
    expect(queries).toHaveLength(2);
    const names = queries.map((s) => s.name);
    expect(names).toContain('User.findByEmail');
    expect(names).toContain('User.findActive');
  });
});

// ─── Multiple entities in one file ────────────────────────────────────────────

describe('hibernateAdapter — multiple entities', () => {
  it('handles multiple @Entity classes in one file', () => {
    const source = `
@Entity
@Table(name = "users")
public class User {
    @Id
    private Long id;
    @Column
    private String name;
}

@Entity
@Table(name = "roles")
public class Role {
    @Id
    private Long id;
    @Column
    private String roleName;
}
`;
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, buf(source), 'Models.java');
    const entityNames = symbols
      .filter((s) => s.frameworkMeta?.hibernate_entity)
      .map((s) => s.name);
    expect(entityNames).toContain('User');
    expect(entityNames).toContain('Role');
    // Columns scoped to correct entity
    const userCol = symbols.find((s) => s.name === 'User.name');
    const roleCol = symbols.find((s) => s.name === 'Role.roleName');
    expect(userCol).toBeDefined();
    expect(roleCol).toBeDefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('hibernateAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc123',
      name: 'User',
      kind: 'class' as const,
      filePath: 'User.java',
      startByte: 0,
      endByte: 0,
      signature: '@Entity class User',
      summary: 'Hibernate entity: User (table: users)',
      frameworkMeta: { hibernate_entity: true, table_name: 'users' },
    };
    expect(hibernateAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('hibernateAdapter — fixture project', () => {
  it('detects fixture as hibernate project', async () => {
    expect(await hibernateAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('extracts @Entity classes from User.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/User.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'User.java');
    const entity = symbols.find((s) => s.name === 'User');
    expect(entity).toBeDefined();
    expect(entity!.frameworkMeta?.hibernate_entity).toBe(true);
    expect(entity!.frameworkMeta?.table_name).toBe('users');
  });

  it('extracts @Id primary key from User.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/User.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'User.java');
    const pk = symbols.find((s) => s.frameworkMeta?.primary_key === true);
    expect(pk).toBeDefined();
    expect(pk!.name).toBe('User.id');
    expect(pk!.frameworkMeta?.generated).toBe(true);
  });

  it('extracts @Column fields with metadata from User.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/User.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'User.java');
    const email = symbols.find((s) => s.name === 'User.email');
    expect(email).toBeDefined();
    expect(email!.frameworkMeta?.column_name).toBe('email');
    expect(email!.frameworkMeta?.nullable).toBe(false);
  });

  it('extracts @OneToMany relationship from User.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/User.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'User.java');
    const rel = symbols.find((s) => s.frameworkMeta?.relationship === 'OneToMany');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.target_entity).toBe('Order');
  });

  it('extracts @NamedQuery annotations from User.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/User.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'User.java');
    const queries = symbols.filter((s) => s.frameworkMeta?.hibernate_query);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    const names = queries.map((s) => s.name);
    expect(names).toContain('User.findByEmail');
    expect(names).toContain('User.findActive');
  });

  it('extracts @ManyToOne and @ManyToMany from Order.java fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/Order.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'Order.java');
    const manyToOne = symbols.find((s) => s.frameworkMeta?.relationship === 'ManyToOne');
    const manyToMany = symbols.find((s) => s.frameworkMeta?.relationship === 'ManyToMany');
    expect(manyToOne).toBeDefined();
    expect(manyToOne!.frameworkMeta?.target_entity).toBe('User');
    expect(manyToMany).toBeDefined();
    expect(manyToMany!.frameworkMeta?.target_entity).toBe('Product');
  });

  it('derives default table name for Product entity', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/java/com/example/Product.java'),
      'utf8',
    );
    const symbols = hibernateAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'Product.java');
    const entity = symbols.find((s) => s.name === 'Product');
    expect(entity?.frameworkMeta?.table_name).toBe('product');
  });
});
