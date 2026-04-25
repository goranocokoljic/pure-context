/**
 * Django ORM adapter (Python ORM).
 *
 * Extracts model class and field-level schema metadata from Django ORM models
 * using regex and indentation-based scanning on Python source text. Complements
 * the general `django` adapter — that one extracts views/URLs/signals, this one
 * extracts database schema metadata (columns, relationships, managers, Meta).
 *
 * Patterns recognised:
 *   class Post(models.Model):                      → class  (django_model)
 *   title = models.CharField(max_length=200)       → const  (field_type, max_length)
 *   author = models.ForeignKey(User, ...)          → const  (relationship, target_model, on_delete)
 *   posts = models.ManyToManyField(Post, ...)      → const  (relationship)
 *   profile = models.OneToOneField(User, ...)      → const  (relationship)
 *   objects = PostManager()                        → const  (django_manager)
 *   class Meta: db_table / verbose_name / ordering → enriches parent model symbol
 *
 * Detection:
 *   - manage.py at project root
 *   - requirements.txt / pyproject.toml containing "django"
 *
 * File filter:
 *   - files named `models.py` (any directory depth)
 *   - files under a `models/` directory (e.g. `myapp/models/user.py`)
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
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

// ─── Django field → SQL type ──────────────────────────────────────────────────

const DJANGO_FIELD_TO_SQL: Record<string, string> = {
  AutoField: 'INTEGER',
  BigAutoField: 'BIGINT',
  SmallAutoField: 'INTEGER',
  IntegerField: 'INTEGER',
  SmallIntegerField: 'SMALLINT',
  PositiveIntegerField: 'INTEGER',
  PositiveSmallIntegerField: 'SMALLINT',
  BigIntegerField: 'BIGINT',
  FloatField: 'FLOAT',
  DecimalField: 'DECIMAL',
  CharField: 'VARCHAR',
  EmailField: 'VARCHAR',
  URLField: 'VARCHAR',
  SlugField: 'VARCHAR',
  FileField: 'VARCHAR',
  ImageField: 'VARCHAR',
  FilePathField: 'VARCHAR',
  IPAddressField: 'VARCHAR',
  GenericIPAddressField: 'VARCHAR',
  TextField: 'TEXT',
  BooleanField: 'BOOLEAN',
  NullBooleanField: 'BOOLEAN',
  DateField: 'DATE',
  DateTimeField: 'TIMESTAMP',
  TimeField: 'TIME',
  DurationField: 'INTERVAL',
  BinaryField: 'BLOB',
  JSONField: 'JSON',
  UUIDField: 'UUID',
};

// ─── Relationship fields ───────────────────────────────────────────────────────

const RELATIONSHIP_KIND: Record<string, string> = {
  ForeignKey: 'many_to_one',
  ManyToManyField: 'many_to_many',
  OneToOneField: 'one_to_one',
};

// ─── Model base classes that indicate a Django ORM model ──────────────────────

const MODEL_BASE_RE = new RegExp(
  [
    'models\\.Model',
    'Model',
    'MPTTModel',
    'TimeStampedModel',
    'AbstractUser',
    'AbstractBaseUser',
    'PolymorphicModel',
  ].join('|'),
);

function isDjangoModel(basesStr: string): boolean {
  return basesStr.split(',').some((b) => MODEL_BASE_RE.test(b.trim()));
}

// ─── App label from file path ─────────────────────────────────────────────────

/**
 * Infer the Django app label from the models file path.
 *
 * Examples:
 *   myapp/models.py          → myapp
 *   myapp/models/user.py     → myapp
 *   src/apps/myapp/models.py → myapp
 */
function appLabelFromPath(filePath: string): string {
  // Normalise to forward slashes
  const fp = filePath.replace(/\\/g, '/');
  const parts = fp.split('/');

  // Find 'models.py' or 'models/' in the path
  const modelsIdx = parts.findLastIndex((p) => p === 'models.py' || p === 'models');
  if (modelsIdx > 0) {
    return parts[modelsIdx - 1]!;
  }
  // Fallback: parent directory
  const dir = dirname(fp);
  return basename(dir) || '';
}

// ─── Continuation line joining ────────────────────────────────────────────────

/**
 * Collect continuation lines when a statement has unbalanced open parentheses.
 * Returns [joinedLine, lastConsumedIndex].
 */
function joinContinuationLines(
  lines: string[],
  startIdx: number,
  classIndent: number,
): [string, number] {
  let joined = lines[startIdx]!;
  let lastConsumed = startIdx;

  let depth =
    (joined.match(/\(/g)?.length ?? 0) - (joined.match(/\)/g)?.length ?? 0);

  let idx = startIdx + 1;
  while (depth > 0 && idx < lines.length) {
    const nextLine = lines[idx]!;
    const stripped = nextLine.trimStart();

    if (stripped === '' || stripped.startsWith('#')) {
      idx++;
      continue;
    }

    const currentIndent = nextLine.length - stripped.length;
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

// ─── Field parsing ────────────────────────────────────────────────────────────

interface FieldInfo {
  fieldName: string;
  djangoType: string;
  sqlType: string;
  maxLength: number | null;
  null_: boolean | null;
  blank: boolean | null;
  primaryKey: boolean;
}

/**
 * Parse a `fieldname = models.SomeField(...)` assignment.
 * Returns null if the line doesn't match a known Django field type.
 */
function parseField(line: string): FieldInfo | null {
  // Match: fieldname = models.FIELDTYPE(args) or fieldname = FIELDTYPE(args)
  const m = /^\s*(\w+)\s*=\s*(?:models\.)?([A-Z][a-zA-Z]+)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(line);
  if (!m) return null;

  const fieldName = m[1]!;
  const djangoType = m[2]!;
  const args = m[3]!;

  const sqlType = DJANGO_FIELD_TO_SQL[djangoType];
  if (!sqlType) return null;  // Not a known field type

  // max_length
  let maxLength: number | null = null;
  const mlM = /\bmax_length\s*=\s*(\d+)/.exec(args);
  if (mlM) maxLength = parseInt(mlM[1]!, 10);

  // null
  let null_: boolean | null = null;
  const nullM = /\bnull\s*=\s*(True|False)\b/.exec(args);
  if (nullM) null_ = nullM[1] === 'True';

  // blank
  let blank: boolean | null = null;
  const blankM = /\bblank\s*=\s*(True|False)\b/.exec(args);
  if (blankM) blank = blankM[1] === 'True';

  // primary_key
  const primaryKey = /\bprimary_key\s*=\s*True\b/.test(args);

  return { fieldName, djangoType, sqlType, maxLength, null_, blank, primaryKey };
}

// ─── Relationship parsing ─────────────────────────────────────────────────────

interface RelationshipInfo {
  fieldName: string;
  relKind: string;      // 'many_to_one' | 'many_to_many' | 'one_to_one'
  djangoType: string;   // 'ForeignKey' | 'ManyToManyField' | 'OneToOneField'
  targetModel: string;
  onDelete: string | null;
}

/**
 * Parse a `fieldname = models.ForeignKey(Target, ...)` assignment.
 */
function parseRelationship(line: string): RelationshipInfo | null {
  const m = /^\s*(\w+)\s*=\s*(?:models\.)?(ForeignKey|ManyToManyField|OneToOneField)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(line);
  if (!m) return null;

  const fieldName = m[1]!;
  const djangoType = m[2]!;
  const relKind = RELATIONSHIP_KIND[djangoType]!;
  const args = m[3]!;

  // First positional arg is the target model (class name or 'self' or quoted string)
  const targetM = /^\s*(?:'([^']+)'|"([^"]+)"|(\w+))/.exec(args.trim());
  const targetModel = targetM?.[1] ?? targetM?.[2] ?? targetM?.[3] ?? 'Unknown';

  // on_delete
  let onDelete: string | null = null;
  const odM = /\bon_delete\s*=\s*(?:models\.)?(\w+)/.exec(args);
  if (odM) onDelete = odM[1]!;

  return { fieldName, relKind, djangoType, targetModel, onDelete };
}

// ─── Manager parsing ──────────────────────────────────────────────────────────

/**
 * Detect a custom manager assignment: `objects = SomeManager(...)`.
 * We match any `name = Something(...)` where the Something ends with `Manager`
 * or `QuerySet`, excluding `models.*Field` patterns already handled above.
 */
function parseManager(line: string): string | null {
  const m = /^\s*(\w+)\s*=\s*(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*(?:Manager|QuerySet))\s*\(/.exec(line);
  if (!m) return null;
  return m[1]!;
}

// ─── Meta class parsing ───────────────────────────────────────────────────────

interface MetaInfo {
  dbTable: string | null;
  verboseName: string | null;
  ordering: string | null;
}

/**
 * Scan lines inside a `class Meta:` inner class.
 * Returns once indentation drops back to bodyIndent (model body indent).
 * Returns [MetaInfo, lastConsumedIndex].
 */
function parseMeta(
  lines: string[],
  startIdx: number,    // index of the `class Meta:` line
  bodyIndent: number,  // indent of class body lines (classIndent + 4)
): [MetaInfo, number] {
  const info: MetaInfo = { dbTable: null, verboseName: null, ordering: null };

  // Determine Meta body indent from the first non-blank line after class Meta:
  let metaBodyIndent = bodyIndent + 4;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const stripped = lines[j]!.trimStart();
    if (stripped === '' || stripped.startsWith('#')) continue;
    metaBodyIndent = lines[j]!.length - stripped.length;
    break;
  }

  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = line.trimStart();

    if (stripped === '' || stripped.startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - stripped.length;
    if (indent <= bodyIndent) break;  // Left Meta body

    // db_table
    const dtM = /^\s*db_table\s*=\s*['"]([^'"]+)['"]/.exec(line);
    if (dtM) { info.dbTable = dtM[1]!; i++; continue; }

    // verbose_name
    const vnM = /^\s*verbose_name\s*=\s*['"]([^'"]+)['"]/.exec(line);
    if (vnM) { info.verboseName = vnM[1]!; i++; continue; }

    // ordering
    const ordM = /^\s*ordering\s*=\s*(\[[^\]]*\])/.exec(line);
    if (ordM) { info.ordering = ordM[1]!; i++; continue; }

    i++;
  }

  return [info, i - 1];
}

// ─── Guard ────────────────────────────────────────────────────────────────────

function hasDjangoImport(sourceStr: string): boolean {
  return /from\s+django\b/.test(sourceStr) || /import\s+django\b/.test(sourceStr);
}

// ─── Main extraction ──────────────────────────────────────────────────────────

function extractDjangoOrmSymbols(source: string, filePath: string): SymbolRecord[] {
  if (!hasDjangoImport(source)) return [];

  const appLabel = appLabelFromPath(filePath);
  const symbols: SymbolRecord[] = [];
  const lines = source.split('\n');
  const n = lines.length;

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    const classM = /^(\s*)class\s+(\w+)\s*\(([^)]+)\)\s*:/.exec(line);

    if (!classM || !isDjangoModel(classM[3]!)) {
      i++;
      continue;
    }

    const classIndent = classM[1]!.length;
    const className = classM[2]!;
    const basesStr = classM[3]!;

    // Default table name: app_modelname (Django convention)
    let tableName = appLabel ? `${appLabel}_${className.toLowerCase()}` : className.toLowerCase();

    const classSymbol: SymbolRecord = {
      id: makeId(filePath, className, 'class'),
      name: className,
      kind: 'class',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `class ${className}(${basesStr.trim()})`,
      summary: `Django model: ${className} (table: ${tableName})`,
      frameworkMeta: {
        django_model: true,
        table_name: tableName,
        app_label: appLabel,
      },
    };
    symbols.push(classSymbol);

    i++;

    while (i < n) {
      const bodyLine = lines[i]!;
      const stripped = bodyLine.trimStart();

      if (stripped === '' || stripped.startsWith('#')) {
        i++;
        continue;
      }

      const currentIndent = bodyLine.length - stripped.length;
      if (currentIndent <= classIndent) break;  // Left class body

      // ── Inner Meta class ───────────────────────────────────────────────────
      if (/^\s*class\s+Meta\s*:/.test(bodyLine)) {
        const [metaInfo, lastConsumed] = parseMeta(lines, i, classIndent + 1);
        if (metaInfo.dbTable) {
          tableName = metaInfo.dbTable;
          (classSymbol.frameworkMeta as Record<string, unknown>)['table_name'] = tableName;
          classSymbol.summary = `Django model: ${className} (table: ${tableName})`;
        }
        if (metaInfo.verboseName) {
          (classSymbol.frameworkMeta as Record<string, unknown>)['verbose_name'] = metaInfo.verboseName;
        }
        if (metaInfo.ordering) {
          (classSymbol.frameworkMeta as Record<string, unknown>)['ordering'] = metaInfo.ordering;
        }
        i = lastConsumed + 1;
        continue;
      }

      // Merge continuation lines (multi-line field definitions)
      const [joined, lastConsumed] = joinContinuationLines(lines, i, classIndent);
      const stmt = joined.trimStart();

      // ── Relationship fields ────────────────────────────────────────────────
      const rel = parseRelationship(joined);
      if (rel) {
        const meta: Record<string, unknown> = {
          relationship: rel.relKind,
          target_model: rel.targetModel,
        };
        if (rel.onDelete) meta['on_delete'] = rel.onDelete;
        symbols.push({
          id: makeId(filePath, `${className}.${rel.fieldName}`, 'const'),
          name: `${className}.${rel.fieldName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `${rel.djangoType}: ${className}.${rel.fieldName} → ${rel.targetModel}`,
          frameworkMeta: meta,
        });
        i = lastConsumed + 1;
        continue;
      }

      // ── Regular field ──────────────────────────────────────────────────────
      const field = parseField(joined);
      if (field) {
        const meta: Record<string, unknown> = {
          field_type: field.djangoType,
          column_type: field.sqlType,
        };
        if (field.maxLength !== null) meta['max_length'] = field.maxLength;
        if (field.null_ !== null) meta['null'] = field.null_;
        if (field.blank !== null) meta['blank'] = field.blank;
        if (field.primaryKey) meta['primary_key'] = true;
        symbols.push({
          id: makeId(filePath, `${className}.${field.fieldName}`, 'const'),
          name: `${className}.${field.fieldName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `Field ${field.fieldName} (${field.djangoType})`,
          frameworkMeta: meta,
        });
        i = lastConsumed + 1;
        continue;
      }

      // ── Custom manager ─────────────────────────────────────────────────────
      const managerName = parseManager(joined);
      if (managerName) {
        symbols.push({
          id: makeId(filePath, `${className}.${managerName}`, 'const'),
          name: `${className}.${managerName}`,
          kind: 'const',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: stmt.slice(0, 120),
          summary: `Manager: ${className}.${managerName}`,
          frameworkMeta: { django_manager: true },
        });
        i = lastConsumed + 1;
        continue;
      }

      i = lastConsumed + 1;
    }
    // i already points past the class body
  }

  return symbols;
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function detectManagePy(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'manage.py'));
}

function detectRequirementsTxt(projectRoot: string): boolean {
  try {
    const content = readFileSync(join(projectRoot, 'requirements.txt'), 'utf8');
    return /^\s*[Dd]jango\b/m.test(content);
  } catch {
    return false;
  }
}

function detectPyprojectToml(projectRoot: string): boolean {
  try {
    const content = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8');
    return /["']django\b/i.test(content);
  } catch {
    return false;
  }
}

// ─── Django ORM adapter ───────────────────────────────────────────────────────

export const djangoOrmAdapter: FrameworkAdapter = {
  name: 'django-orm',

  /** No new file extensions — `.py` files are handled by the Python handler. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return (
      detectManagePy(projectRoot) ||
      detectRequirementsTxt(projectRoot) ||
      detectPyprojectToml(projectRoot)
    );
  },

  // ── File routing ───────────────────────────────────────────────────────────

  /**
   * Only scan model files:
   *   - any file named `models.py`
   *   - any `.py` file inside a `models/` directory
   */
  fileFilter: (filePath: string): boolean => {
    if (!filePath.endsWith('.py')) return false;
    const fp = filePath.replace(/\\/g, '/');
    return basename(fp) === 'models.py' || /\/models\/[^/]+\.py$/.test(fp);
  },

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractDjangoOrmSymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(djangoOrmAdapter);
logger.debug("Adapter 'django-orm' registered");
