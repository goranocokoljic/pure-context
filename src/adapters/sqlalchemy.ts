/**
 * SQLAlchemy adapter (Python ORM).
 *
 * Extracts model, column, relationship, and hybrid property symbols from
 * SQLAlchemy ORM models using regex and indentation-based scanning on Python
 * source text. Handles both SQLAlchemy 1.x and 2.0 declarative styles.
 *
 * Patterns recognised (SA 1.x):
 *   class User(Base):                             → class (sqlalchemy_model)
 *   __tablename__ = "users"                       → sets table_name
 *   id = Column(Integer, primary_key=True)        → const (primary_key: true)
 *   name = Column(String(100), nullable=False)    → const (column)
 *   orders = relationship("Order", ...)           → const (relationship)
 *
 * Patterns recognised (SA 2.0):
 *   id: Mapped[int] = mapped_column(primary_key=True)   → const (column)
 *   name: Mapped[str] = mapped_column(nullable=False)   → const (column)
 *
 * Other patterns:
 *   @hybrid_property def prop(self)               → const (hybrid_property)
 *
 * Detection:
 *   - requirements.txt containing sqlalchemy (case-insensitive)
 *   - pyproject.toml containing sqlalchemy (case-insensitive)
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
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

// ─── SA base class detection ──────────────────────────────────────────────────

/**
 * Base class names that indicate a SQLAlchemy declarative model.
 * Checked against each comma-separated element in a class's base list.
 */
const SA_BASE_CLASSES = new Set([
  'Base',
  'DeclarativeBase',
  'DeclarativeBaseNoMeta',
  'db.Model',        // Flask-SQLAlchemy
  'Model',
  'AbstractBase',
  'TimestampMixin',  // common mixin pattern (conservative — only matches if also inherits Base)
]);

function isSAModelClass(basesStr: string): boolean {
  return basesStr.split(',').some((b) => SA_BASE_CLASSES.has(b.trim()));
}

// ─── Python type → SQL type ───────────────────────────────────────────────────

const PYTHON_TO_SQL: Record<string, string> = {
  Integer: 'INTEGER',
  int: 'INTEGER',
  SmallInteger: 'SMALLINT',
  BigInteger: 'BIGINT',
  String: 'VARCHAR',
  str: 'VARCHAR',
  Text: 'TEXT',
  Boolean: 'BOOLEAN',
  bool: 'BOOLEAN',
  Float: 'FLOAT',
  float: 'FLOAT',
  Double: 'DOUBLE',
  Numeric: 'DECIMAL',
  Decimal: 'DECIMAL',
  DateTime: 'TIMESTAMP',
  Date: 'DATE',
  Time: 'TIME',
  Interval: 'INTERVAL',
  JSON: 'JSON',
  JSONB: 'JSONB',
  LargeBinary: 'BLOB',
  UUID: 'UUID',
  Enum: 'VARCHAR',
  ARRAY: 'ARRAY',
};

/**
 * Map a SQLAlchemy / Python type name to a SQL type string.
 * Strips call arguments (e.g. String(100) → String) and
 * Optional[] wrappers before lookup.
 */
function inferSqlType(rawType: string): string {
  const base = rawType.trim()
    .replace(/\s*\([^)]*\)/, '')           // String(100) → String
    .replace(/^Optional\[(.+)\]$/, '$1')   // Optional[str] → str
    .replace(/^List\[(.+)\]$/, '$1')       // List[str] → str
    .replace(/\[.*\]$/, '');               // strip remaining generics
  return PYTHON_TO_SQL[base] ?? base.toUpperCase();
}

// ─── Continuation line joining ────────────────────────────────────────────────

/**
 * When a statement spans multiple lines (open parens > closed), collect
 * continuation lines and join them into a single string.
 *
 * Returns [joinedLine, lastConsumedIndex].
 * lastConsumedIndex is the index of the last line that was appended into the
 * joined result (the caller should advance to lastConsumedIndex + 1).
 */
function joinContinuationLines(
  lines: string[],
  startIdx: number,
  classIndent: number,
): [string, number] {
  let joined = lines[startIdx]!;
  let lastConsumed = startIdx;

  const openCount = (joined.match(/\(/g)?.length ?? 0);
  const closeCount = (joined.match(/\)/g)?.length ?? 0);
  let depth = openCount - closeCount;

  let idx = startIdx + 1;
  while (depth > 0 && idx < lines.length) {
    const nextLine = lines[idx]!;
    const stripped = nextLine.trimStart();

    // Skip blank lines and comments — don't treat them as continuation
    if (stripped === '' || stripped.startsWith('#')) {
      idx++;
      continue;
    }

    const currentIndent = nextLine.length - stripped.length;
    // Reached the end of the current class body or file scope
    if (currentIndent <= classIndent) break;

    joined += ' ' + stripped;
    lastConsumed = idx;
    depth +=
      (stripped.match(/\(/g)?.length ?? 0) -
      (stripped.match(/\)/g)?.length ?? 0);
    idx++;
  }

  return [joined, lastConsumed];
}

// ─── Column parsing ───────────────────────────────────────────────────────────

interface ColumnInfo {
  fieldName: string;
  columnType: string;
  primaryKey: boolean;
  nullable: boolean | null;
}

/** Parse a SQLAlchemy 1.x `fieldname = Column(...)` assignment. */
function parseColumn(line: string): ColumnInfo | null {
  // Allow one level of nested parens, e.g. Column(String(100), nullable=False)
  const m = /^\s*(\w+)\s*=\s*Column\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(line);
  if (!m) return null;

  const fieldName = m[1]!;
  const args = m[2]!;

  // First positional arg is the type (unless it starts with ForeignKey/keyword)
  const typeMatch = /^([A-Za-z_]\w*(?:\s*\([^)]*\))?)\s*(?:,|$)/.exec(args.trim());
  let rawType = typeMatch?.[1] ?? '';
  if (/^ForeignKey\b/i.test(rawType) || /^\w+=/.test(rawType)) rawType = '';
  const columnType = rawType ? inferSqlType(rawType) : 'UNKNOWN';

  const primaryKey = /\bprimary_key\s*=\s*True\b/.test(args);

  let nullable: boolean | null = null;
  const nullM = /\bnullable\s*=\s*(True|False)\b/.exec(args);
  if (nullM) nullable = nullM[1] === 'True';

  return { fieldName, columnType, primaryKey, nullable };
}

/** Parse a SQLAlchemy 2.0 `fieldname: Mapped[Type] = mapped_column(...)` assignment. */
function parseMappedColumn(line: string): ColumnInfo | null {
  // Allow one level of nested brackets in Mapped[...] (e.g. Optional[str], List["X"])
  // and one level of nested parens in mapped_column(...) args (e.g. String(100)).
  const MAPPED_TYPE = '([^\\[\\]]*(?:\\[[^\\[\\]]*\\][^\\[\\]]*)*)';
  const MC_ARGS = '([^()]*(?:\\([^()]*\\)[^()]*)*)';
  const full = new RegExp(
    `^\\s*(\\w+)\\s*:\\s*Mapped\\[${MAPPED_TYPE}\\]\\s*=\\s*mapped_column\\s*\\(${MC_ARGS}\\)`,
  ).exec(line);
  if (full) {
    const fieldName = full[1]!;
    const mappedType = full[2]!;
    const args = full[3]!;

    // Prefer explicit SA type in mapped_column args, else use Mapped type annotation
    const typeMatch = /^([A-Za-z_]\w*(?:\s*\([^)]*\))?)\s*(?:,|$)/.exec(args.trim());
    let rawType = typeMatch?.[1] ?? '';
    // Ignore keyword-only args and ForeignKey as type
    if (
      !rawType ||
      /^(?:primary_key|nullable|unique|index|default|server_default|ForeignKey)\b/i.test(rawType)
    ) {
      rawType = mappedType;
    }
    const columnType = inferSqlType(rawType);

    const primaryKey = /\bprimary_key\s*=\s*True\b/.test(args);

    let nullable: boolean | null = null;
    const nullM = /\bnullable\s*=\s*(True|False)\b/.exec(args);
    if (nullM) nullable = nullM[1] === 'True';

    return { fieldName, columnType, primaryKey, nullable };
  }

  // Bare annotation without mapped_column: fieldname: Mapped[Type]
  const bare = /^\s*(\w+)\s*:\s*Mapped\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]\s*$/.exec(line);
  if (bare) {
    return {
      fieldName: bare[1]!,
      columnType: inferSqlType(bare[2]!),
      primaryKey: false,
      nullable: null,
    };
  }

  return null;
}

// ─── Relationship parsing ─────────────────────────────────────────────────────

interface RelationshipInfo {
  fieldName: string;
  target: string;
  backPopulates: string | null;
}

/** Parse a `fieldname = relationship("Target", ...)` assignment. */
function parseRelationship(line: string): RelationshipInfo | null {
  const m = /^\s*(\w+)\s*=\s*relationship\s*\(\s*['"]([^'"]+)['"]/.exec(line);
  if (!m) return null;

  const fieldName = m[1]!;
  const target = m[2]!;

  let backPopulates: string | null = null;
  const bpM = /\bback_populates\s*=\s*['"]([^'"]+)['"]/.exec(line);
  if (bpM) backPopulates = bpM[1]!;

  return { fieldName, target, backPopulates };
}

// ─── Guard: only scan files that import sqlalchemy ────────────────────────────

function hasSQLAlchemyImport(source: string): boolean {
  return /\bsqlalchemy\b/i.test(source) || /\bfrom\s+flask_sqlalchemy\b/.test(source);
}

// ─── Main extraction ──────────────────────────────────────────────────────────

function extractSQLAlchemySymbols(source: string, filePath: string): SymbolRecord[] {
  if (!hasSQLAlchemyImport(source)) return [];

  const symbols: SymbolRecord[] = [];
  const lines = source.split('\n');
  const n = lines.length;

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    const classM = /^(\s*)class\s+(\w+)\s*\(([^)]+)\)\s*:/.exec(line);

    if (!classM || !isSAModelClass(classM[3]!)) {
      i++;
      continue;
    }

    const classIndent = classM[1]!.length;
    const className = classM[2]!;
    const basesStr = classM[3]!;

    // Push class symbol now; we'll mutate table_name and summary once we've seen __tablename__
    let tableName = className.toLowerCase();
    const classSymbol: SymbolRecord = {
      id: makeId(filePath, className, 'class'),
      name: className,
      kind: 'class',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `class ${className}(${basesStr.trim()})`,
      summary: `SQLAlchemy model: ${className} (table: ${tableName})`,
      frameworkMeta: {
        sqlalchemy_model: true,
        table_name: tableName,
      },
    };
    symbols.push(classSymbol);

    i++;
    let pendingHybrid = false;

    while (i < n) {
      const bodyLine = lines[i]!;
      const stripped = bodyLine.trimStart();

      // Blank lines and comments
      if (stripped === '' || stripped.startsWith('#')) {
        i++;
        continue;
      }

      const currentIndent = bodyLine.length - stripped.length;
      // Left the class body
      if (currentIndent <= classIndent) break;

      // Merge continuation lines so multi-line Column(...) / relationship(...) are handled
      const [joined, lastConsumed] = joinContinuationLines(lines, i, classIndent);
      const stmt = joined.trimStart();

      // ── __tablename__ ────────────────────────────────────────────────────────
      const tableM = /^__tablename__\s*=\s*['"]([^'"]+)['"]/.exec(stmt);
      if (tableM) {
        tableName = tableM[1]!;
        (classSymbol.frameworkMeta as Record<string, unknown>)['table_name'] = tableName;
        classSymbol.summary = `SQLAlchemy model: ${className} (table: ${tableName})`;
        pendingHybrid = false;
        i = lastConsumed + 1;
        continue;
      }

      // ── @hybrid_property decorator ────────────────────────────────────────────
      if (/^@hybrid_property\b/.test(stmt)) {
        pendingHybrid = true;
        i = lastConsumed + 1;
        continue;
      }

      // ── Other decorators (reset hybrid pending) ───────────────────────────────
      if (stmt.startsWith('@')) {
        pendingHybrid = false;
        i = lastConsumed + 1;
        continue;
      }

      // ── def after @hybrid_property ────────────────────────────────────────────
      if (pendingHybrid) {
        const defM = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(stmt);
        if (defM && defM[1] !== '__init__') {
          const propName = defM[1]!;
          symbols.push({
            id: makeId(filePath, `${className}.${propName}`, 'const'),
            name: `${className}.${propName}`,
            kind: 'const',
            filePath,
            startByte: 0,
            endByte: 0,
            signature: `@hybrid_property def ${propName}(self)`,
            summary: `Hybrid property: ${className}.${propName}`,
            frameworkMeta: { hybrid_property: true },
          });
        }
        pendingHybrid = false;
        i = lastConsumed + 1;
        continue;
      }

      // ── SA 2.0 mapped_column ──────────────────────────────────────────────────
      const mappedCol = parseMappedColumn(joined);
      if (mappedCol) {
        const meta: Record<string, unknown> = {
          column_name: mappedCol.fieldName,
          column_type: mappedCol.columnType,
        };
        if (mappedCol.primaryKey) meta['primary_key'] = true;
        if (mappedCol.nullable !== null) meta['nullable'] = mappedCol.nullable;
        symbols.push({
          id: makeId(filePath, `${className}.${mappedCol.fieldName}`, 'const'),
          name: `${className}.${mappedCol.fieldName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `Column ${mappedCol.fieldName} (${mappedCol.columnType})${mappedCol.primaryKey ? ' [PK]' : ''}`,
          frameworkMeta: meta,
        });
        i = lastConsumed + 1;
        continue;
      }

      // ── SA 1.x Column() ───────────────────────────────────────────────────────
      const col = parseColumn(joined);
      if (col) {
        const meta: Record<string, unknown> = {
          column_name: col.fieldName,
          column_type: col.columnType,
        };
        if (col.primaryKey) meta['primary_key'] = true;
        if (col.nullable !== null) meta['nullable'] = col.nullable;
        symbols.push({
          id: makeId(filePath, `${className}.${col.fieldName}`, 'const'),
          name: `${className}.${col.fieldName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `Column ${col.fieldName} (${col.columnType})${col.primaryKey ? ' [PK]' : ''}`,
          frameworkMeta: meta,
        });
        i = lastConsumed + 1;
        continue;
      }

      // ── relationship() ────────────────────────────────────────────────────────
      const rel = parseRelationship(joined);
      if (rel) {
        const meta: Record<string, unknown> = {
          relationship: rel.target,
        };
        if (rel.backPopulates) meta['back_populates'] = rel.backPopulates;
        symbols.push({
          id: makeId(filePath, `${className}.${rel.fieldName}`, 'const'),
          name: `${className}.${rel.fieldName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `Relationship: ${className}.${rel.fieldName} → ${rel.target}`,
          frameworkMeta: meta,
        });
        i = lastConsumed + 1;
        continue;
      }

      i = lastConsumed + 1;
    }
    // i already points past the class body — outer loop continues from here
  }

  return symbols;
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function detectRequirementsTxt(projectRoot: string): boolean {
  try {
    const content = readFileSync(join(projectRoot, 'requirements.txt'), 'utf8');
    return /\bsqlalchemy\b/i.test(content);
  } catch {
    return false;
  }
}

function detectPyprojectToml(projectRoot: string): boolean {
  try {
    const content = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8');
    return /\bsqlalchemy\b/i.test(content);
  } catch {
    return false;
  }
}

function detectSetupPy(projectRoot: string): boolean {
  try {
    const content = readFileSync(join(projectRoot, 'setup.py'), 'utf8');
    return /\bsqlalchemy\b/i.test(content);
  } catch {
    return false;
  }
}

// ─── SQLAlchemy adapter ───────────────────────────────────────────────────────

export const sqlalchemyAdapter: FrameworkAdapter = {
  name: 'sqlalchemy',

  /** No new file extensions — `.py` files are handled by the Python handler. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return (
      detectRequirementsTxt(projectRoot) ||
      detectPyprojectToml(projectRoot) ||
      detectSetupPy(projectRoot)
    );
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean => filePath.endsWith('.py'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractSQLAlchemySymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(sqlalchemyAdapter);
logger.debug("Adapter 'sqlalchemy' registered");
