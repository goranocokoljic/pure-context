/**
 * find-implementations.ts
 *
 * MCP tool: find_implementations
 *
 * Find all concrete implementations of a TypeScript interface or abstract class,
 * and all method overrides for a given base method.
 *
 * Detection strategy (two-pass):
 *  1. Name-based: search class symbols whose signature contains
 *     `implements InterfaceName` or `extends ClassName` via LIKE on symbols.signature.
 *  2. Import-based: any file that imports the interface's file is also scanned
 *     for classes that match, catching cases where the name-based pass missed due
 *     to signature truncation.
 *
 * `implementedMethods` / `missingMethods` are computed by comparing the method
 * symbols stored under the interface name against those stored under the
 * implementing class name.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import {
  findClassImplementations,
  getMethodNamesForSymbol,
  extractInterfaceMethodNames,
} from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import { byteOffsetToLine } from './symbol-lines.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getFileContent } from '../../core/db/file-store.js';

export const name = 'find_implementations';

export const description =
  'Find all concrete implementations of a TypeScript interface or abstract class, ' +
  'and all method overrides for a given base method. ' +
  'Returns implementing classes with their implemented and missing methods. ' +
  'Use search_symbols to find the symbolId for an interface or abstract class first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .describe('Symbol ID of the interface or abstract class to search for'),
  includeAbstract: z
    .boolean()
    .optional()
    .describe(
      'Include abstract subclasses in results (default false). ' +
      'When true, abstract classes that extend the target are included alongside concrete implementations.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of implementations to return (default 50)'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImplementationRecord {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
  implementedMethods: string[];
  missingMethods: string[];
}

interface FindImplementationsOutput {
  interfaceName: string;
  interfaceFilePath: string;
  implementations: ImplementationRecord[];
  totalFound: number;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 1-based line number from a byte offset (consolidated impl, Phase 90). */
const byteToLine = byteOffsetToLine;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  includeAbstract?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, includeAbstract = false, limit = 50 } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Look up the target interface / abstract class
    const target = getSymbolById(db, repoId, symbolId);
    if (!target) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found in repo "${repoId}".`,
            }),
          },
        ],
        isError: true,
      };
    }

    if (target.kind !== 'interface' && target.kind !== 'class') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Symbol "${target.name}" has kind "${target.kind}". ` +
                'find_implementations only works with interface or class symbols.',
            }),
          },
        ],
        isError: true,
      };
    }

    // Get interface/abstract-class method names.
    // Interface methods are NOT indexed as separate symbols by the TypeScript handler,
    // so we extract them from the raw file content using the target's byte range.
    // For abstract classes, the indexed method symbols are used as fallback.
    let interfaceMethods: string[];
    const targetFileContent = getFileContent(db, repoId, target.filePath);
    if (targetFileContent) {
      interfaceMethods = extractInterfaceMethodNames(
        targetFileContent,
        target.startByte,
        target.endByte,
      );
    } else {
      // Fallback to indexed method symbols (works for abstract classes)
      interfaceMethods = getMethodNamesForSymbol(db, repoId, target.name, target.filePath);
    }

    // Find all classes/interfaces that implement or extend this target
    const implementors = findClassImplementations(
      db,
      repoId,
      target.name,
      target.filePath,
      includeAbstract,
      limit,
    );

    // Build ImplementationRecord for each implementor
    const implementations: ImplementationRecord[] = [];

    for (const impl of implementors) {
      // Get the implementing class's method stems
      const classMethods = getMethodNamesForSymbol(db, repoId, impl.name, impl.filePath);
      const classMethodSet = new Set(classMethods);

      const implementedMethods = interfaceMethods.filter((m) => classMethodSet.has(m));
      const missingMethods = interfaceMethods.filter((m) => !classMethodSet.has(m));

      // Compute startLine from file content
      let startLine = 1;
      const fileContent = getFileContent(db, repoId, impl.filePath);
      if (fileContent) {
        startLine = byteToLine(fileContent, impl.startByte);
      }

      implementations.push({
        symbolId: impl.id,
        name: impl.name,
        kind: impl.kind,
        filePath: impl.filePath,
        startLine,
        signature: impl.signature,
        summary: impl.summary,
        implementedMethods,
        missingMethods,
      });
    }

    const responseText = JSON.stringify(implementations);
    const output: FindImplementationsOutput = {
      interfaceName: target.name,
      interfaceFilePath: target.filePath,
      implementations,
      totalFound: implementations.length,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
