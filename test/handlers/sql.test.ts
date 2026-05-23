import { describe, it, expect } from 'vitest';
import { sqlHandler } from '../../src/handlers/sql.js';
import { preprocessJinja, extractJinjaRefs } from '../../src/handlers/sql-jinja-preprocessor.js';
import type { Tree } from '../../src/core/types.js';

// ─── Inline SQL fixtures ───────────────────────────────────────────────────────

const PLAIN_DDL_SQL = `
CREATE TABLE orders (
  id          BIGINT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  amount      NUMERIC(12, 2)
);

CREATE OR REPLACE VIEW active_orders AS
SELECT * FROM orders WHERE status = 'active';

CREATE MATERIALIZED VIEW order_summary AS
SELECT customer_id, COUNT(*) AS order_count FROM orders GROUP BY 1;

CREATE OR REPLACE FUNCTION get_order_total(p_id BIGINT)
RETURNS NUMERIC AS $$
  SELECT SUM(amount) FROM order_items WHERE order_id = p_id;
$$ LANGUAGE sql;

CREATE PROCEDURE archive_orders(cutoff_date DATE)
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM orders WHERE created_at < cutoff_date;
END;
$$;
`.trimStart();

const CTE_SQL = `
WITH
  base AS (
    SELECT id, amount FROM orders
  ),
  totals AS (
    SELECT customer_id, SUM(amount) AS total FROM base GROUP BY 1
  )
SELECT * FROM totals;
`.trimStart();

const DBT_MODEL_SQL = `
SELECT
    o.id AS order_id,
    o.amount,
    c.first_name
FROM {{ ref('stg_orders') }} o
JOIN {{ ref('stg_customers') }} c ON o.customer_id = c.customer_id
WHERE o.amount > {{ var('min_amount', 0) }}
`.trimStart();

const DBT_SOURCE_SQL = `
SELECT
    id AS customer_id,
    first_name,
    email
FROM {{ source('raw', 'customers') }}
`.trimStart();

const DBT_MACRO_SQL = `
{% macro cents_to_dollars(column_name, scale=2) %}
    ({{ column_name }} / 100)::numeric(16, {{ scale }})
{% endmacro %}

{% macro generate_schema_name(custom_schema_name, node) %}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ target.schema }}_{{ custom_schema_name | trim }}
    {%- endif -%}
{% endmacro %}

{% test not_null_or_empty(model, column_name) %}
SELECT * FROM {{ model }} WHERE {{ column_name }} IS NULL
{% endtest %}
`.trimStart();

const DBT_SNAPSHOT_SQL = `
{% snapshot orders_snapshot %}

{{
    config(
      target_schema='snapshots',
      unique_key='id',
      strategy='timestamp',
      updated_at='updated_at',
    )
}}

SELECT * FROM {{ source('raw', 'orders') }}

{% endsnapshot %}
`.trimStart();

const NON_OPENAPI_YAML = `name: my-project\nversion: "1.0.0"\n`;

// ─── grammarPath ──────────────────────────────────────────────────────────────

describe('sqlHandler.grammarPath()', () => {
  it('returns null (no tree-sitter grammar)', () => {
    expect(sqlHandler.grammarPath()).toBeNull();
  });
});

// ─── extensions ───────────────────────────────────────────────────────────────

describe('sqlHandler.extensions()', () => {
  it('claims .sql', () => {
    expect(sqlHandler.extensions()).toContain('.sql');
  });
});

// ─── Plain SQL: DDL extraction ────────────────────────────────────────────────

describe('sqlHandler — plain SQL DDL', () => {
  const buf = Buffer.from(PLAIN_DDL_SQL);
  const syms = () => sqlHandler.extractSymbols(null as unknown as Tree, buf, 'schema/ddl.sql');

  it('extracts CREATE TABLE orders as class', () => {
    const s = syms().find((x) => x.name === 'orders' && x.kind === 'class');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.filePath).toBe('schema/ddl.sql');
  });

  it('extracts CREATE VIEW active_orders as class', () => {
    const s = syms().find((x) => x.name === 'active_orders');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.signature).toContain('VIEW');
  });

  it('extracts CREATE MATERIALIZED VIEW order_summary as class', () => {
    const s = syms().find((x) => x.name === 'order_summary');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.signature).toContain('MATERIALIZED VIEW');
  });

  it('extracts CREATE FUNCTION get_order_total as function', () => {
    const s = syms().find((x) => x.name === 'get_order_total');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
    expect(s!.signature).toContain('FUNCTION');
  });

  it('extracts CREATE PROCEDURE archive_orders as function', () => {
    const s = syms().find((x) => x.name === 'archive_orders');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
    expect(s!.signature).toContain('PROCEDURE');
  });

  it('generates deterministic 16-char hex IDs', () => {
    const s = syms().find((x) => x.name === 'orders');
    expect(s!.id).toHaveLength(16);
    expect(s!.id).toMatch(/^[0-9a-f]+$/);
    const s2 = syms().find((x) => x.name === 'orders');
    expect(s2!.id).toBe(s!.id);
  });

  it('startByte is > 0 for non-first symbol', () => {
    const s = syms().find((x) => x.name === 'active_orders');
    expect(s!.startByte).toBeGreaterThan(0);
  });
});

// ─── CTE extraction ───────────────────────────────────────────────────────────

describe('sqlHandler — CTE extraction', () => {
  const buf = Buffer.from(CTE_SQL);
  const syms = () => sqlHandler.extractSymbols(null as unknown as Tree, buf, 'query.sql');

  it('extracts first CTE "base" as const', () => {
    const s = syms().find((x) => x.name === 'base');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('const');
    expect(s!.signature).toContain('base');
  });

  it('extracts chained CTE "totals" as const', () => {
    const s = syms().find((x) => x.name === 'totals');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('const');
  });
});

// ─── dbt model file (SELECT-only) ────────────────────────────────────────────

describe('sqlHandler — dbt model (SELECT-only)', () => {
  it('emits one model symbol named after the file stem', () => {
    const buf = Buffer.from(DBT_MODEL_SQL);
    const syms = sqlHandler.extractSymbols(null as unknown as Tree, buf, 'models/marts/orders.sql');
    expect(syms).toHaveLength(1);
    const s = syms[0];
    expect(s.name).toBe('orders');
    expect(s.kind).toBe('function');
    expect(s.signature).toContain('dbt model orders');
    expect(s.frameworkMeta).toMatchObject({ isDbtModel: true });
  });

  it('uses the correct file stem when path has no directory', () => {
    const buf = Buffer.from(DBT_SOURCE_SQL);
    const syms = sqlHandler.extractSymbols(
      null as unknown as Tree,
      buf,
      'stg_customers.sql',
    );
    expect(syms[0].name).toBe('stg_customers');
  });

  it('emits file stem AND CTE symbols when a dbt model has CTEs', () => {
    const sql = `
with

source as (
    select * from {{ source('ecom', 'raw_orders') }}
),

renamed as (
    select id as order_id from source
)

select * from renamed
`.trimStart();
    const buf = Buffer.from(sql);
    const syms = sqlHandler.extractSymbols(null as unknown as Tree, buf, 'models/staging/stg_orders.sql');
    const names = syms.map((s) => s.name);
    expect(names).toContain('stg_orders');
    expect(names).toContain('source');
    expect(names).toContain('renamed');
    const stem = syms.find((s) => s.name === 'stg_orders')!;
    expect(stem.kind).toBe('function');
    expect(stem.frameworkMeta).toMatchObject({ isDbtModel: true });
  });
});

// ─── dbt macro file ───────────────────────────────────────────────────────────

describe('sqlHandler — dbt macro file', () => {
  const buf = Buffer.from(DBT_MACRO_SQL);
  const syms = () =>
    sqlHandler.extractSymbols(null as unknown as Tree, buf, 'macros/utils.sql');

  it('extracts macro cents_to_dollars as function', () => {
    const s = syms().find((x) => x.name === 'cents_to_dollars');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
    expect(s!.signature).toContain('macro cents_to_dollars');
  });

  it('extracts macro generate_schema_name as function', () => {
    const s = syms().find((x) => x.name === 'generate_schema_name');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
  });

  it('extracts test not_null_or_empty as function', () => {
    const s = syms().find((x) => x.name === 'not_null_or_empty');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
    expect(s!.signature).toContain('test not_null_or_empty');
  });
});

// ─── dbt snapshot ─────────────────────────────────────────────────────────────

describe('sqlHandler — dbt snapshot', () => {
  it('extracts snapshot as class', () => {
    const buf = Buffer.from(DBT_SNAPSHOT_SQL);
    const syms = sqlHandler.extractSymbols(
      null as unknown as Tree,
      buf,
      'snapshots/orders_snapshot.sql',
    );
    const s = syms.find((x) => x.name === 'orders_snapshot');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.signature).toContain('snapshot orders_snapshot');
  });
});

// ─── Jinja preprocessing ──────────────────────────────────────────────────────

describe('preprocessJinja()', () => {
  it('replaces {{ ref("model") }} with SQL string literal', () => {
    const input = `SELECT * FROM {{ ref('stg_orders') }}`;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).toContain("'stg_orders'");
    expect(result).not.toContain('{{');
  });

  it('replaces {{ source("schema", "table") }} with schema.table literal', () => {
    const input = `SELECT * FROM {{ source('raw', 'customers') }}`;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).toContain("'raw.customers'");
    expect(result).not.toContain('{{');
  });

  it('removes {% if %}…{% endif %} blocks', () => {
    const input = `SELECT 1 {% if target.name == 'prod' %} , 2 {% endif %}`;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).not.toContain('{%');
    expect(result).toContain('SELECT 1');
  });

  it('removes {% set %} tags', () => {
    const input = `{% set my_var = 'foo' %}\nSELECT 1`;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).not.toContain('{%');
    expect(result).toContain('SELECT 1');
  });

  it('removes {# Jinja comments #}', () => {
    const input = `{# this is a comment #}\nSELECT 1`;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).not.toContain('{#');
    expect(result).toContain('SELECT 1');
  });

  it('produces output that does not contain Jinja syntax', () => {
    const input = DBT_MODEL_SQL;
    const result = preprocessJinja(Buffer.from(input)).toString('utf8');
    expect(result).not.toMatch(/\{\{|\}\}|\{%|%\}/);
  });
});

// ─── Import extraction ────────────────────────────────────────────────────────

describe('sqlHandler.extractImports() — ref() calls', () => {
  it('extracts ref() calls as import records', () => {
    const buf = Buffer.from(DBT_MODEL_SQL);
    const imports = sqlHandler.extractImports(null as unknown as Tree, buf);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('stg_orders');
    expect(specifiers).toContain('stg_customers');
  });

  it('extracts source() calls as schema.table specifiers', () => {
    const buf = Buffer.from(DBT_SOURCE_SQL);
    const imports = sqlHandler.extractImports(null as unknown as Tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('raw.customers');
    expect(imports[0].resolvedPath).toBeNull();
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('returns empty array for plain SQL with no Jinja refs', () => {
    const buf = Buffer.from(PLAIN_DDL_SQL);
    const imports = sqlHandler.extractImports(null as unknown as Tree, buf);
    expect(imports).toHaveLength(0);
  });
});

// ─── extractJinjaRefs ─────────────────────────────────────────────────────────

describe('extractJinjaRefs()', () => {
  it('extracts multiple ref() calls', () => {
    const buf = Buffer.from(DBT_MODEL_SQL);
    const refs = extractJinjaRefs(buf);
    const specifiers = refs.map((r) => r.specifier);
    expect(specifiers).toContain('stg_orders');
    expect(specifiers).toContain('stg_customers');
  });

  it('sets resolvedPath to null for all refs', () => {
    const buf = Buffer.from(DBT_SOURCE_SQL);
    const refs = extractJinjaRefs(buf);
    expect(refs.every((r) => r.resolvedPath === null)).toBe(true);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('sqlHandler.extractDocstring()', () => {
  it('always returns null', () => {
    expect(sqlHandler.extractDocstring(null as unknown as any)).toBeNull();
  });
});
