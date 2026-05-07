/**
 * dbt Context Provider — enriches indexed SQL model symbols with schema.yml
 * descriptions, tags, column metadata, and doc block content.
 *
 * Detection: presence of `dbt_project.yml` in the project root.
 * Enrichment: walk all schema.yml / schema.yaml files under models/, parse
 * per-model metadata, update symbols.summary and symbols.framework_meta,
 * and write full column data to provider_metadata.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';
import * as yaml from 'js-yaml';
import type Database from 'better-sqlite3';
import type { ContextProvider, EnrichmentResult } from '../core/types.js';
import { logger } from '../core/logger.js';
import { registerProvider } from './provider-registry.js';

// ─── Sentinel ─────────────────────────────────────────────────────────────────
// Summaries that are identical to the symbol signature are "auto-generated"
// and safe to replace with a human-readable description from schema.yml.
// Any other non-empty summary is treated as a human-written docstring and
// left untouched.
const AUTO_GENERATED_PREFIX = '[auto]';

// ─── YAML shape types ─────────────────────────────────────────────────────────

interface DbtColumn {
  name: string;
  description?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  data_type?: string;
}

interface DbtModel {
  name: string;
  description?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  columns?: DbtColumn[];
}

interface DbtSourceTable {
  name: string;
  description?: string;
  columns?: DbtColumn[];
}

interface DbtSource {
  name: string;
  description?: string;
  tables?: DbtSourceTable[];
}

interface DbtSchemaDoc {
  version?: number;
  models?: DbtModel[];
  sources?: DbtSource[];
}

// ─── Parsed model metadata ────────────────────────────────────────────────────

export interface DbtModelMeta {
  name: string;
  description: string;
  tags: string[];
  meta: Record<string, unknown>;
  columns: Array<{
    name: string;
    description: string;
    tags: string[];
    dataType?: string;
    meta?: Record<string, unknown>;
  }>;
  docBlock?: string;
}

// ─── Helper: recursive file walk ─────────────────────────────────────────────

function walkFiles(dir: string, exts: Set<string>, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, exts, results);
    } else if (exts.has(extname(entry).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

// ─── Schema.yml parsing ───────────────────────────────────────────────────────

/**
 * Parse a single schema.yml file and return per-model metadata records.
 */
export function parseSchemaFile(filePath: string): DbtModelMeta[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    logger.warn(`dbt-provider: cannot read ${filePath}`);
    return [];
  }

  // Handle multi-document YAML by loading only the first document
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    logger.warn(`dbt-provider: YAML parse error in ${filePath}: ${err}`);
    return [];
  }

  if (!doc || typeof doc !== 'object') return [];
  const schema = doc as DbtSchemaDoc;
  const results: DbtModelMeta[] = [];

  for (const model of schema.models ?? []) {
    results.push({
      name: model.name,
      description: model.description ?? '',
      tags: model.tags ?? [],
      meta: model.meta ?? {},
      columns: (model.columns ?? []).map((col) => ({
        name: col.name,
        description: col.description ?? '',
        tags: col.tags ?? [],
        dataType: col.data_type,
        meta: col.meta,
      })),
    });
  }

  // Also surface source table descriptions as pseudo-model entries
  for (const source of schema.sources ?? []) {
    for (const table of source.tables ?? []) {
      results.push({
        name: `${source.name}.${table.name}`,
        description: table.description ?? source.description ?? '',
        tags: [],
        meta: {},
        columns: (table.columns ?? []).map((col) => ({
          name: col.name,
          description: col.description ?? '',
          tags: [],
        })),
      });
    }
  }

  return results;
}

// ─── Doc block parsing ────────────────────────────────────────────────────────

/**
 * Extract `{% docs model_name %}...{% enddocs %}` blocks from .md files.
 * Returns a map of model_name → doc text.
 */
export function parseDocBlocks(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  const mdFiles = walkFiles(dir, new Set(['.md']));
  const DOC_BLOCK_RE = /\{%-?\s*docs\s+(\w+)\s*-?%\}([\s\S]*?)\{%-?\s*enddocs\s*-?%\}/g;

  for (const file of mdFiles) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = DOC_BLOCK_RE.exec(content)) !== null) {
      const modelName = match[1]!.trim();
      const docText = match[2]!.trim();
      result.set(modelName, docText);
    }
  }

  return result;
}

// ─── DB operations ────────────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  summary: string;
  signature: string;
  framework_meta: string | null;
}

/**
 * Upsert a row in provider_metadata.
 */
function upsertProviderMetadata(
  db: Database.Database,
  repoId: string,
  entityKey: string,
  metadata: unknown,
): void {
  db.prepare(`
    INSERT INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
    VALUES (?, 'dbt', ?, ?, ?)
    ON CONFLICT(repo_id, provider_name, entity_key) DO UPDATE SET
      metadata   = excluded.metadata,
      updated_at = excluded.updated_at
  `).run(repoId, entityKey, JSON.stringify(metadata), Date.now());
}

/**
 * Update summary and framework_meta on a symbol, and keep FTS5 in sync.
 * Only overwrites summary if it is empty or equals the signature (auto-generated).
 */
function enrichSymbol(
  db: Database.Database,
  repoId: string,
  symbol: SymbolRow,
  model: DbtModelMeta,
): boolean {
  const isAutoSummary =
    !symbol.summary ||
    symbol.summary === symbol.signature ||
    symbol.summary.startsWith(AUTO_GENERATED_PREFIX);

  const newSummary = isAutoSummary && model.description ? model.description : symbol.summary;

  // Merge new framework_meta on top of existing
  const existing: Record<string, unknown> = symbol.framework_meta
    ? (JSON.parse(symbol.framework_meta) as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = {
    ...existing,
    dbt_tags: model.tags,
    dbt_meta: model.meta,
    columns: model.columns.map((c) => ({ name: c.name, description: c.description, tags: c.tags })),
  };
  if (model.docBlock) {
    merged['dbt_doc'] = model.docBlock;
  }

  db.prepare(`
    UPDATE symbols
    SET summary        = ?,
        framework_meta = ?
    WHERE repo_id = ? AND id = ?
  `).run(newSummary, JSON.stringify(merged), repoId, symbol.id);

  // Keep FTS5 index in sync
  const fileStem = symbol.name; // good enough for FTS — full stem computed inside insertSymbols
  const tagTokens = model.tags.join(' ');
  db.prepare('DELETE FROM fts_symbols WHERE symbol_id = ? AND repo_id = ?').run(symbol.id, repoId);
  db.prepare('INSERT INTO fts_symbols (symbol_id, repo_id, content) VALUES (?, ?, ?)').run(
    symbol.id,
    repoId,
    `${symbol.name} ${fileStem} ${symbol.signature} ${newSummary} ${tagTokens}`,
  );

  return true;
}

// ─── Provider implementation ──────────────────────────────────────────────────

class DbtProvider implements ContextProvider {
  readonly name = 'dbt';
  readonly description = 'Enriches dbt models with schema.yml descriptions and column metadata';

  async detect(projectRoot: string): Promise<boolean> {
    return existsSync(join(projectRoot, 'dbt_project.yml'));
  }

  async enrich(repoId: string, projectRoot: string, db: Database.Database): Promise<EnrichmentResult> {
    const modelsDir = join(projectRoot, 'models');

    // 1. Collect all schema.yml / schema.yaml files under models/
    const schemaFiles = walkFiles(modelsDir, new Set(['.yml', '.yaml']));
    const modelMetaMap = new Map<string, DbtModelMeta>();

    for (const schemaFile of schemaFiles) {
      const models = parseSchemaFile(schemaFile);
      for (const m of models) {
        modelMetaMap.set(m.name, m);
      }
    }

    // 2. Parse doc blocks from .md files under models/
    const docBlocks = parseDocBlocks(modelsDir);
    for (const [modelName, docText] of docBlocks) {
      const meta = modelMetaMap.get(modelName);
      if (meta) {
        meta.docBlock = docText;
        // If model has no description yet, use the doc block text
        if (!meta.description) {
          meta.description = docText;
        }
      }
    }

    if (modelMetaMap.size === 0) {
      logger.debug('dbt-provider: no schema.yml models found — nothing to enrich');
      return { symbolsEnriched: 0, metadataAdded: { modelsFound: 0 } };
    }

    // 3. For each model, find matching symbol(s) in the DB and enrich them
    let symbolsEnriched = 0;

    const updateTx = db.transaction(() => {
      for (const [modelName, meta] of modelMetaMap) {
        // SQL models are indexed as 'function' with name = file stem (e.g. "orders")
        // Source pseudo-entries (source.table) won't match symbol names — skip them gracefully
        const rows = db.prepare<[string, string], SymbolRow>(`
          SELECT id, name, summary, signature, framework_meta
          FROM symbols
          WHERE repo_id = ? AND name = ?
        `).all(repoId, modelName);

        for (const row of rows) {
          try {
            enrichSymbol(db, repoId, row, meta);
            symbolsEnriched++;
          } catch (err) {
            logger.warn(`dbt-provider: failed to enrich symbol '${row.name}': ${err}`);
          }
        }

        // 4. Write full column metadata to provider_metadata
        try {
          upsertProviderMetadata(db, repoId, modelName, {
            description: meta.description,
            tags: meta.tags,
            meta: meta.meta,
            columns: meta.columns,
            docBlock: meta.docBlock,
          });
        } catch (err) {
          logger.warn(`dbt-provider: failed to write provider_metadata for '${modelName}': ${err}`);
        }
      }
    });

    updateTx();

    logger.info(`dbt-provider: enriched ${symbolsEnriched} symbols from ${modelMetaMap.size} models`);
    return {
      symbolsEnriched,
      metadataAdded: {
        modelsFound: modelMetaMap.size,
        docBlocksFound: docBlocks.size,
      },
    };
  }
}

// ─── Self-register ────────────────────────────────────────────────────────────

export const dbtProvider = new DbtProvider();
registerProvider(dbtProvider);
