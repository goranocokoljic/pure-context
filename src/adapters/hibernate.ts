/**
 * Hibernate / JPA adapter (Java/Kotlin).
 *
 * Enriches Java entity classes with database schema metadata from JPA/Hibernate
 * annotations. Handles both the legacy `javax.persistence` and modern
 * `jakarta.persistence` namespaces — annotation names are identical in both.
 *
 * Patterns recognised:
 *   @Entity class Foo { … }                  → class (hibernate_entity)
 *   @Table(name = "foo")                     → adds table_name to entity
 *   @Id field                                → const (primary_key: true)
 *   @GeneratedValue                          → adds generated: true to Id field
 *   @Column(name = "…", nullable = …)        → const (column metadata)
 *   @OneToMany / @ManyToOne / @OneToOne / @ManyToMany → const (relationship)
 *   @NamedQuery(name = "…", query = "…")     → function (hibernate_query)
 *
 * Detection:
 *   - pom.xml containing hibernate-core or jakarta.persistence-api
 *   - build.gradle/build.gradle.kts with hibernate or jakarta.persistence
 *   - persistence.xml in src/main/resources/META-INF/
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Extract a named attribute from an annotation text.
 * e.g. extractAttr('@Column(name = "email", nullable = false)', 'name') → 'email'
 * Returns null when the attribute is absent.
 */
function extractAttr(annoText: string, attr: string): string | null {
  // handles: attr = "value" and attr = 'value'
  const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`);
  const m = annoText.match(re);
  return m ? m[1]! : null;
}

/**
 * Extract a boolean attribute from an annotation text.
 * e.g. extractBoolAttr('@Column(nullable = false)', 'nullable') → false
 * Returns null when absent.
 */
function extractBoolAttr(annoText: string, attr: string): boolean | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(true|false)`);
  const m = annoText.match(re);
  return m ? m[1] === 'true' : null;
}

/**
 * Derive a SQL table/column name from a Java/Kotlin identifier using the
 * default JPA naming strategy (CamelCase → snake_case).
 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

// ─── Java type → SQL type heuristic ──────────────────────────────────────────

const JAVA_TO_SQL: Record<string, string> = {
  String: 'VARCHAR',
  Integer: 'INTEGER',
  int: 'INTEGER',
  Long: 'BIGINT',
  long: 'BIGINT',
  Double: 'DOUBLE',
  double: 'DOUBLE',
  Float: 'FLOAT',
  float: 'FLOAT',
  Boolean: 'BOOLEAN',
  boolean: 'BOOLEAN',
  Date: 'DATE',
  LocalDate: 'DATE',
  LocalDateTime: 'TIMESTAMP',
  ZonedDateTime: 'TIMESTAMP',
  BigDecimal: 'DECIMAL',
  UUID: 'UUID',
  byte: 'TINYINT',
  Short: 'SMALLINT',
  short: 'SMALLINT',
};

/**
 * Infer a SQL column type from a Java field type declaration.
 * Falls back to the raw Java type when no mapping exists.
 */
function inferSqlType(javaType: string): string {
  const base = javaType.trim().replace(/<.*>/, ''); // strip generics
  return JAVA_TO_SQL[base] ?? base.toUpperCase();
}

// ─── Symbol extraction ─────────────────────────────────────────────────────────

interface EntityFrame {
  name: string;
  tableName: string;
  entryDepth: number;
}

/**
 * Replace comment regions with spaces of equal length so that all character
 * positions stay valid (byte offsets in SymbolRecord remain correct), but
 * annotations and keywords inside comments are invisible to the scanners.
 */
function stripComments(source: string): string {
  // Replace /* ... */ (including Javadoc /**) with spaces
  let result = source.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  // Replace // ... to end of line with spaces
  result = result.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return result;
}

function extractHibernateSymbols(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  // Strip comments so annotations inside /** */ or // don't pollute the scan
  const stripped = stripComments(source);

  // ── Event types ──────────────────────────────────────────────────────────────

  type EventType =
    | 'entity-anno'
    | 'table-anno'
    | 'named-query-anno'
    | 'id-anno'
    | 'generated-value-anno'
    | 'column-anno'
    | 'relation-anno'
    | 'class-decl'
    | 'field-decl'
    | 'open'
    | 'close';

  interface Event {
    pos: number;
    type: EventType;
    name?: string;
    raw?: string;
    // annotation-specific payloads
    tableName?: string;
    columnName?: string;
    nullable?: boolean | null;
    relationType?: string;
    queryName?: string;
    queryString?: string;
    javaType?: string;
  }

  const ORDER: Record<EventType, number> = {
    'entity-anno': 0,
    'table-anno': 0,
    'named-query-anno': 0,
    'id-anno': 0,
    'generated-value-anno': 0,
    'column-anno': 0,
    'relation-anno': 0,
    'class-decl': 0,
    'field-decl': 0,
    open: 1,
    close: 2,
  };

  const events: Event[] = [];
  let m: RegExpExecArray | null;

  // ── Annotation scanning ───────────────────────────────────────────────────────

  // @Entity
  const entityAnnoRe = /@Entity\b(?:\s*\([^)]*\))?/g;
  while ((m = entityAnnoRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'entity-anno', raw: m[0] });
  }

  // @Table(name = "...")
  const tableAnnoRe = /@Table\s*(?:\([^)]*\))?/g;
  while ((m = tableAnnoRe.exec(stripped)) !== null) {
    const tableName = extractAttr(m[0], 'name') ?? null;
    events.push({ pos: m.index, type: 'table-anno', raw: m[0], tableName: tableName ?? undefined });
  }

  // @NamedQuery(name = "...", query = "...")
  const namedQueryRe = /@NamedQuery\s*\([^)]+\)/g;
  while ((m = namedQueryRe.exec(stripped)) !== null) {
    const queryName = extractAttr(m[0], 'name') ?? undefined;
    const queryString = extractAttr(m[0], 'query') ?? undefined;
    events.push({ pos: m.index, type: 'named-query-anno', raw: m[0], queryName, queryString });
  }

  // @Id
  const idAnnoRe = /@Id\b(?!\w)/g;
  while ((m = idAnnoRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'id-anno', raw: m[0] });
  }

  // @GeneratedValue
  const generatedValueRe = /@GeneratedValue\b(?:\s*\([^)]*\))?/g;
  while ((m = generatedValueRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'generated-value-anno', raw: m[0] });
  }

  // @Column
  const columnAnnoRe = /@Column\b(?:\s*\([^)]*\))?/g;
  while ((m = columnAnnoRe.exec(stripped)) !== null) {
    const columnName = extractAttr(m[0], 'name') ?? undefined;
    const nullable = extractBoolAttr(m[0], 'nullable');
    events.push({ pos: m.index, type: 'column-anno', raw: m[0], columnName, nullable: nullable ?? undefined });
  }

  // Relationship annotations
  const relationRe = /@(OneToMany|ManyToOne|OneToOne|ManyToMany)\b(?:\s*\([^)]*\))?/g;
  while ((m = relationRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'relation-anno', raw: m[0], relationType: m[1] });
  }

  // ── Declaration scanning ──────────────────────────────────────────────────────

  // class ClassName
  const classRe = /\bclass\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'class-decl', name: m[1] });
  }

  // Field declarations inside class body.
  // Match: [access modifier] [static] TypeName[<Generic>] fieldName [= ...];
  const fieldRe =
    /\b(?:(?:private|protected|public|static|final)\s+)*([A-Za-z_$][\w$]*(?:<[^>]*>)?)\s+([a-z_$][\w$]*)\s*(?:=|;)/g;
  while ((m = fieldRe.exec(stripped)) !== null) {
    const javaType = m[1]!;
    const fieldName = m[2]!;
    // Skip Java keywords that can look like field declarations
    if (['void', 'return', 'new', 'class', 'extends', 'implements', 'throws'].includes(javaType)) continue;
    events.push({ pos: m.index, type: 'field-decl', name: fieldName, javaType });
  }

  // Braces
  const openRe = /\{/g;
  while ((m = openRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'open' });
  }

  const closeRe = /\}/g;
  while ((m = closeRe.exec(stripped)) !== null) {
    events.push({ pos: m.index, type: 'close' });
  }

  events.sort((a, b) => a.pos - b.pos || ORDER[a.type] - ORDER[b.type]);

  // ── State machine ─────────────────────────────────────────────────────────────

  let pendingEntityAnno = false;
  let pendingTableAnno: { tableName?: string; raw: string } | null = null;
  let pendingNamedQueryAnnos: Array<{ queryName?: string; queryString?: string; raw: string }> = [];
  let pendingIdAnno = false;
  let pendingGeneratedValue = false;
  let pendingColumnAnno: { columnName?: string; nullable?: boolean | null; raw: string } | null = null;
  let pendingRelationAnno: { relationType: string; raw: string } | null = null;

  const entityStack: EntityFrame[] = [];
  let depth = 0;
  let pendingEntityFrame: EntityFrame | null = null;

  const seen = new Set<string>();

  function clearClassLevelPending(): void {
    pendingEntityAnno = false;
    pendingTableAnno = null;
    pendingNamedQueryAnnos = [];
  }

  function clearFieldLevelPending(): void {
    pendingIdAnno = false;
    pendingGeneratedValue = false;
    pendingColumnAnno = null;
    pendingRelationAnno = null;
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'entity-anno':
        pendingEntityAnno = true;
        break;

      case 'table-anno':
        pendingTableAnno = { tableName: ev.tableName, raw: ev.raw! };
        break;

      case 'named-query-anno':
        pendingNamedQueryAnnos.push({ queryName: ev.queryName, queryString: ev.queryString, raw: ev.raw! });
        break;

      case 'id-anno':
        pendingIdAnno = true;
        break;

      case 'generated-value-anno':
        pendingGeneratedValue = true;
        break;

      case 'column-anno':
        pendingColumnAnno = { columnName: ev.columnName, nullable: ev.nullable, raw: ev.raw! };
        break;

      case 'relation-anno':
        pendingRelationAnno = { relationType: ev.relationType!, raw: ev.raw! };
        break;

      case 'class-decl': {
        const className = ev.name!;

        if (pendingEntityAnno) {
          // Derive table name: from @Table(name=...) or default snake_case of class name
          const tableName = pendingTableAnno?.tableName ?? toSnakeCase(className);

          const key = `entity:${className}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              id: makeId(filePath, className, 'class'),
              name: className,
              kind: 'class',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `@Entity class ${className}`,
              summary: `Hibernate entity: ${className} (table: ${tableName})`,
              frameworkMeta: {
                hibernate_entity: true,
                table_name: tableName,
              },
            });
          }

          // Emit any @NamedQuery annotations on the class
          for (const nq of pendingNamedQueryAnnos) {
            const nqName = nq.queryName ?? `${className}.unnamed`;
            const nqKey = `namedquery:${nqName}`;
            if (!seen.has(nqKey)) {
              seen.add(nqKey);
              symbols.push({
                id: makeId(filePath, nqName, 'function'),
                name: nqName,
                kind: 'function',
                filePath,
                startByte: ev.pos,
                endByte: ev.pos,
                signature: `@NamedQuery(name = "${nqName}")`,
                summary: `Named JPQL query: ${nqName}`,
                frameworkMeta: {
                  hibernate_query: true,
                  ...(nq.queryString ? { query_string: nq.queryString } : {}),
                },
              });
            }
          }

          pendingEntityFrame = { name: className, tableName, entryDepth: 0 };
        } else {
          pendingEntityFrame = null;
        }

        clearClassLevelPending();
        break;
      }

      case 'field-decl': {
        const fieldName = ev.name!;
        const javaType = ev.javaType ?? 'Object';
        const top = entityStack[entityStack.length - 1];

        // Only emit field symbols when we are inside an @Entity class body
        if (!top) {
          clearFieldLevelPending();
          break;
        }

        if (pendingIdAnno || pendingColumnAnno || pendingRelationAnno) {
          if (pendingRelationAnno) {
            // Relationship field
            const { relationType, raw: annoRaw } = pendingRelationAnno;
            // Try to infer target entity from generic type (e.g. List<Order> → Order)
            const targetMatch = javaType.match(/<([A-Z]\w*)>/);
            const targetEntity = targetMatch ? targetMatch[1]! : javaType;
            const key = `relation:${top.name}.${fieldName}`;
            if (!seen.has(key)) {
              seen.add(key);
              symbols.push({
                id: makeId(filePath, `${top.name}.${fieldName}`, 'const'),
                name: `${top.name}.${fieldName}`,
                kind: 'const',
                filePath,
                startByte: ev.pos,
                endByte: ev.pos,
                signature: `${annoRaw} ${javaType} ${fieldName}`,
                summary: `${relationType} relationship: ${top.name} → ${targetEntity}`,
                frameworkMeta: {
                  relationship: relationType,
                  target_entity: targetEntity,
                },
              });
            }
          } else {
            // @Id or @Column field
            const columnName =
              pendingColumnAnno?.columnName ?? toSnakeCase(fieldName);
            const sqlType = inferSqlType(javaType);
            const nullable = pendingColumnAnno?.nullable ?? null;
            const key = `column:${top.name}.${fieldName}`;
            if (!seen.has(key)) {
              seen.add(key);
              const meta: Record<string, unknown> = {
                column_name: columnName,
                column_type: sqlType,
              };
              if (pendingIdAnno) meta['primary_key'] = true;
              if (pendingGeneratedValue) meta['generated'] = true;
              if (nullable !== null) meta['nullable'] = nullable;
              symbols.push({
                id: makeId(filePath, `${top.name}.${fieldName}`, 'const'),
                name: `${top.name}.${fieldName}`,
                kind: 'const',
                filePath,
                startByte: ev.pos,
                endByte: ev.pos,
                signature: `${pendingIdAnno ? '@Id ' : ''}${pendingColumnAnno?.raw ?? ''} ${javaType} ${fieldName}`.trim(),
                summary: `Column ${columnName} (${sqlType})${pendingIdAnno ? ' [PK]' : ''}`,
                frameworkMeta: meta,
              });
            }
          }
        }

        clearFieldLevelPending();
        break;
      }

      case 'open':
        depth++;
        if (pendingEntityFrame !== null) {
          pendingEntityFrame.entryDepth = depth;
          entityStack.push(pendingEntityFrame);
          pendingEntityFrame = null;
        }
        break;

      case 'close': {
        while (entityStack.length > 0) {
          const top = entityStack[entityStack.length - 1]!;
          if (top.entryDepth > depth) {
            entityStack.pop();
          } else {
            break;
          }
        }
        depth = Math.max(0, depth - 1);
        break;
      }
    }
  }

  return symbols;
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function detectPomXml(projectRoot: string): boolean {
  try {
    const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
    return (
      pom.includes('hibernate-core') ||
      pom.includes('jakarta.persistence') ||
      pom.includes('javax.persistence') ||
      pom.includes('hibernate-entitymanager') ||
      pom.includes('spring-boot-starter-data-jpa')
    );
  } catch {
    return false;
  }
}

function detectGradle(projectRoot: string): boolean {
  for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
    try {
      const content = readFileSync(join(projectRoot, buildFile), 'utf8');
      if (
        content.includes('hibernate-core') ||
        content.includes('jakarta.persistence') ||
        content.includes('javax.persistence') ||
        content.includes('data-jpa')
      ) {
        return true;
      }
    } catch {
      // file absent — try next
    }
  }
  return false;
}

function detectPersistenceXml(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'src/main/resources/META-INF/persistence.xml'));
}

// ─── Hibernate adapter ────────────────────────────────────────────────────────

export const hibernateAdapter: FrameworkAdapter = {
  name: 'hibernate',

  /** No new file extensions — `.java` and `.kt` handled by language handlers. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return (
      detectPomXml(projectRoot) ||
      detectGradle(projectRoot) ||
      detectPersistenceXml(projectRoot)
    );
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.java') || filePath.endsWith('.kt'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractHibernateSymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(hibernateAdapter);
logger.debug("Adapter 'hibernate' registered");
