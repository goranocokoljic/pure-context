/**
 * dbt Jinja template preprocessing for SQL files.
 *
 * Strips/replaces Jinja template syntax so the resulting text is valid SQL
 * that can be parsed for symbol extraction. The original source is always
 * stored in the file cache — this preprocessed form is only used internally
 * for symbol extraction.
 */

// ─── Import record helpers ────────────────────────────────────────────────────

export interface JinjaRef {
  /** Raw specifier, e.g. 'stg_orders' or 'raw.customers' */
  specifier: string;
  /** Always null for dbt refs — resolved by the dbt provider later */
  resolvedPath: null;
}

/**
 * Extract all `{{ ref('model') }}` and `{{ source('schema', 'table') }}` calls
 * from the *original* (unprocessed) SQL source.
 */
export function extractJinjaRefs(source: Buffer): JinjaRef[] {
  const text = source.toString('utf8');
  const refs: JinjaRef[] = [];

  // {{ ref('model_name') }}  or  {{ ref("model_name") }}
  const refRe = /\{\{-?\s*ref\s*\(\s*(['"])([^'"]+)\1\s*\)\s*-?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(text)) !== null) {
    refs.push({ specifier: m[2], resolvedPath: null });
  }

  // {{ source('schema', 'table') }}
  const sourceRe =
    /\{\{-?\s*source\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)\s*-?\}\}/g;
  while ((m = sourceRe.exec(text)) !== null) {
    refs.push({ specifier: `${m[2]}.${m[4]}`, resolvedPath: null });
  }

  return refs;
}

// ─── Jinja preprocessor ───────────────────────────────────────────────────────

/**
 * Replace Jinja template syntax with valid SQL equivalents:
 *
 *  1. `{# comment #}`                    → removed
 *  2. `{{ ref('model') }}`               → `'model'`
 *  3. `{{ source('schema', 'table') }}`  → `'schema.table'`
 *  4. `{% for … %}…{% endfor %}`         → removed
 *  5. `{% if … %}…{% endif %}`           → removed
 *  6. `{% set … %}`                      → removed (single tag, no body)
 *  7. All remaining `{% … %}`            → removed
 *  8. `{{ any_other_expr }}`             → `'expr'` (safe placeholder)
 */
export function preprocessJinja(source: Buffer): Buffer {
  let text = source.toString('utf8');

  // 1. Jinja comments
  text = text.replace(/\{#[\s\S]*?#\}/g, '');

  // 2. {{ ref('model') }}
  text = text.replace(
    /\{\{-?\s*ref\s*\(\s*(['"])([^'"]+)\1\s*\)\s*-?\}\}/g,
    (_full, _q, name: string) => `'${name}'`,
  );

  // 3. {{ source('schema', 'table') }}
  text = text.replace(
    /\{\{-?\s*source\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)\s*-?\}\}/g,
    (_full, _q1, schema: string, _q2, table: string) => `'${schema}.${table}'`,
  );

  // 4. {% for … %}…{% endfor %} — remove entire block
  text = text.replace(/\{%-?\s*for\b[\s\S]*?\{%-?\s*endfor\s*-?%\}/gi, '');

  // 5. {% if … %}…{% endif %} — remove entire block
  text = text.replace(/\{%-?\s*if\b[\s\S]*?\{%-?\s*endif\s*-?%\}/gi, '');

  // 6–7. All remaining block/statement tags
  text = text.replace(/\{%-?[^%]*?-?%\}/g, '');

  // 8. Remaining {{ … }} expressions → safe string placeholder
  text = text.replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (_full, expr: string) => {
    const safe = expr.replace(/'/g, '').trim().slice(0, 32);
    return `'${safe}'`;
  });

  return Buffer.from(text, 'utf8');
}
