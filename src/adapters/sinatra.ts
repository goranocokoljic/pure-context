/**
 * Sinatra framework adapter.
 *
 * Extracts route symbols from Sinatra applications using regex-based scanning
 * on Ruby source text.
 *
 * Patterns recognised:
 *   get '/users' do ... end              → classic-style route
 *   post '/users', to: 'users#create'   → route with options
 *   class MyApp < Sinatra::Base
 *     get '/items' do ... end            → modular-style route
 *   end
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
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

// ─── Route extraction ─────────────────────────────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

/**
 * Matches Sinatra route declarations in both classic and modular style:
 *   get '/path' do
 *   post "/path", ...
 *   delete '/path/with/:param' do
 *
 * Captures: (1) http method, (2) path string
 */
const ROUTE_RE = new RegExp(
  `\\b(${HTTP_METHODS.join('|')})\\s+['"](([^'"]*))['"]`,
  'gi',
);

function extractRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(sourceStr)) !== null) {
    const httpMethod = m[1]!.toUpperCase();
    const routePath = m[2]!;
    const name = `${httpMethod} ${routePath}`;
    symbols.push({
      id: makeId(filePath, name, 'route'),
      name,
      kind: 'route',
      filePath,
      startByte: m.index,
      endByte: 0,
      signature: `${m[1]!} '${routePath}'`,
      summary: `Sinatra route: ${name}`,
      frameworkMeta: {
        sinatra_route: true,
        http_method: httpMethod,
        route_path: routePath,
      },
    });
  }

  return symbols;
}

// ─── Sinatra adapter ──────────────────────────────────────────────────────────

export const sinatraAdapter: FrameworkAdapter = {
  name: 'sinatra',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // Check Gemfile
    const gemfilePath = join(projectRoot, 'Gemfile');
    if (existsSync(gemfilePath)) {
      try {
        const content = readFileSync(gemfilePath, 'utf8');
        if (/gem\s+['"]sinatra['"]/m.test(content)) return true;
      } catch {
        // fall through to next check
      }
    }

    // Shallow scan of root-level .rb files for require 'sinatra'
    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.rb')) continue;
        try {
          const content = readFileSync(join(projectRoot, entry.name), 'utf8');
          if (/require\s+['"]sinatra['"]/m.test(content)) return true;
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore readdir failures
    }

    return false;
  },

  fileFilter(filePath: string): boolean {
    return filePath.endsWith('.rb');
  },

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractRoutes(source.toString('utf8'), filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(sinatraAdapter);
logger.debug("Adapter 'sinatra' registered");
