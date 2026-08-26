import { createHash } from 'crypto';
import { basename, extname } from 'path';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';
import { preprocessJinja, extractJinjaRefs } from './sql-jinja-preprocessor.js';

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip optional quoting characters from a SQL identifier. */
function stripQuotes(ident: string): string {
  return ident.replace(/^[`"[]|[`"\]]$/g, '');
}

/** Strip schema prefix from a qualified name, returning the local part. */
function localName(qualifiedName: string): string {
  const stripped = stripQuotes(qualifiedName);
  const parts = stripped.split('.');
  return parts[parts.length - 1] ?? stripped;
}

/**
 * Convert a string index into a byte offset within the same string encoded
 * as UTF-8. For ASCII-only SQL this is a no-op, but handles Unicode correctly.
 */
function stringIndexToByteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

// ─── DDL / macro extraction ───────────────────────────────────────────────────

interface SqlMatch {
  name: string;
  kind: SymbolKind;
  signature: string;
  startByte: number;
}

function extractDdlMatches(preprocessed: string): SqlMatch[] {
  const matches: SqlMatch[] = [];

  // CREATE [OR REPLACE] [TEMP[ORARY]] (MATERIALIZED VIEW | TABLE | VIEW) [IF NOT EXISTS] name
  // Name may carry a psql-extension schema placeholder prefix (`@extschema@.name`,
  // used by TimescaleDB and other PGXS extension scripts) — localName strips it.
  const createDdlRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(MATERIALIZED\s+VIEW|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:@\w+@\.)?[`"[]?\w[\w.$]*[`"\]]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = createDdlRe.exec(preprocessed)) !== null) {
    const ddlType = m[1].replace(/\s+/g, ' ').toUpperCase(); // e.g. 'MATERIALIZED VIEW' | 'TABLE' | 'VIEW'
    const name = localName(m[2]);
    const kind: SymbolKind = 'class';
    matches.push({
      name,
      kind,
      signature: `CREATE ${ddlType} ${name}`,
      startByte: stringIndexToByteOffset(preprocessed, m.index),
    });
  }

  // CREATE [OR REPLACE] FUNCTION / PROCEDURE name
  const createFnRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:@\w+@\.)?[`"[]?\w[\w.$]*[`"\]]?)/gi;
  while ((m = createFnRe.exec(preprocessed)) !== null) {
    const name = localName(m[1]);
    const kind: SymbolKind = 'function';
    // determine FUNCTION vs PROCEDURE from the keyword
    const keyword = /PROCEDURE/i.test(m[0]) ? 'PROCEDURE' : 'FUNCTION';
    matches.push({
      name,
      kind,
      signature: `CREATE ${keyword} ${name}`,
      startByte: stringIndexToByteOffset(preprocessed, m.index),
    });
  }

  // WITH cte_name AS (  — first CTE in a WITH clause
  const firstCteRe = /\bWITH\s+(\w+)\s+AS\s*\(/gi;
  while ((m = firstCteRe.exec(preprocessed)) !== null) {
    matches.push({
      name: m[1],
      kind: 'const',
      signature: `WITH ${m[1]} AS (...)`,
      startByte: stringIndexToByteOffset(preprocessed, m.index),
    });
  }

  // ,  cte_name  AS  (  — chained CTEs after the first
  const chainedCteRe = /,\s*(\w+)\s+AS\s*\(/gi;
  while ((m = chainedCteRe.exec(preprocessed)) !== null) {
    matches.push({
      name: m[1],
      kind: 'const',
      signature: `WITH ${m[1]} AS (...)`,
      startByte: stringIndexToByteOffset(preprocessed, m.index),
    });
  }

  return matches;
}

function extractMacroMatches(originalText: string): SqlMatch[] {
  const matches: SqlMatch[] = [];
  let m: RegExpExecArray | null;

  // {% macro name(...) %}
  const macroRe = /\{%-?\s*macro\s+([\w_]+)\s*\(/gi;
  while ((m = macroRe.exec(originalText)) !== null) {
    const name = m[1];
    matches.push({
      name,
      kind: 'function',
      signature: `macro ${name}(...)`,
      startByte: stringIndexToByteOffset(originalText, m.index),
    });
  }

  // {% test name(...) %}
  const testRe = /\{%-?\s*test\s+([\w_]+)\s*\(/gi;
  while ((m = testRe.exec(originalText)) !== null) {
    const name = m[1];
    matches.push({
      name,
      kind: 'function',
      signature: `test ${name}(...)`,
      startByte: stringIndexToByteOffset(originalText, m.index),
    });
  }

  // {% snapshot name %}
  const snapshotRe = /\{%-?\s*snapshot\s+([\w_]+)/gi;
  while ((m = snapshotRe.exec(originalText)) !== null) {
    const name = m[1];
    matches.push({
      name,
      kind: 'class',
      signature: `snapshot ${name}`,
      startByte: stringIndexToByteOffset(originalText, m.index),
    });
  }

  return matches;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const sqlHandler: LanguageHandler = {
  extensions(): string[] {
    return ['.sql'];
  },

  grammarPath(): null {
    // No tree-sitter grammar — SQL is parsed directly with regex.
    return null;
  },

  extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
    const originalText = source.toString('utf8');
    const preprocessed = preprocessJinja(source).toString('utf8');

    const ddlMatches = extractDdlMatches(preprocessed);
    const macroMatches = extractMacroMatches(originalText);
    const allMatches = [...ddlMatches, ...macroMatches];

    // Detect dbt model files: they use {{ ref(...) }} or {{ source(...) }} Jinja refs.
    // Always emit the file stem for these so the model is findable by name even when
    // the file also contains CTE symbols (e.g. stg_orders.sql has WITH source AS ...).
    const isDbtModel = /\{\{-?\s*(?:ref|source)\s*\(/i.test(originalText);
    const stem = basename(filePath, extname(filePath));

    if (allMatches.length > 0) {
      const records: SymbolRecord[] = allMatches.map((match) => ({
        id: makeId(filePath, match.name, match.kind),
        name: match.name,
        kind: match.kind,
        filePath,
        startByte: match.startByte,
        endByte: match.startByte + Buffer.byteLength(match.name, 'utf8'),
        signature: match.signature.slice(0, 120),
        summary: match.signature.slice(0, 200),
      }));
      if (isDbtModel) {
        records.push({
          id: makeId(filePath, stem, 'function'),
          name: stem,
          kind: 'function',
          filePath,
          startByte: 0,
          endByte: source.length,
          signature: `dbt model ${stem}`,
          summary: `dbt model ${stem}`,
          frameworkMeta: { isDbtModel: true },
        });
      }
      return records;
    }

    if (isDbtModel) {
      return [
        {
          id: makeId(filePath, stem, 'function'),
          name: stem,
          kind: 'function',
          filePath,
          startByte: 0,
          endByte: source.length,
          signature: `dbt model ${stem}`,
          summary: `dbt model ${stem}`,
          frameworkMeta: { isDbtModel: true },
        },
      ];
    }

    return [];
  },

  extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
    const refs = extractJinjaRefs(source);
    return refs.map((ref) => ({
      sourceFile: '', // overridden by file-processor
      specifier: ref.specifier,
      resolvedPath: ref.resolvedPath,
      importedNames: [],
      isTypeOnly: false,
    }));
  },

  extractDocstring(_node: SyntaxNode): string | null {
    return null;
  },
};
