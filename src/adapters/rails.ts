/**
 * Rails framework adapter.
 *
 * Extracts model, controller, job, and route symbols from Ruby on Rails
 * applications using regex-based scanning on Ruby source text.
 *
 * Patterns recognised:
 *   class User < ApplicationRecord                  → model (rails_model)
 *   class UsersController < ApplicationController   → class (rails_controller)
 *   public def index inside controller              → view (rails_action)
 *   get '/users', to: 'users#index'                → route
 *   resources :posts                                → 5 CRUD routes
 *   namespace :api do ... end                       → applies /api prefix
 *   class UserMailerJob < ApplicationJob            → class (rails_job)
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

// ─── Class block finder ───────────────────────────────────────────────────────

interface ClassBlock {
  name: string;
  superclass: string;
  /** Full class body text (between class header and matching end). */
  body: string;
  /** Byte offset of the class keyword in the source string. */
  start: number;
}

/**
 * Find class declarations and their bodies using indentation-based `end`
 * matching. Works reliably for standard Rails file structure (one class per
 * file at indent 0).
 */
function findClassBlocks(sourceStr: string): ClassBlock[] {
  const CLASS_RE = /^([ \t]*)class\s+([\w:]+)(?:\s*<\s*([\w:]+))?[^\n]*/gm;
  const blocks: ClassBlock[] = [];
  let m: RegExpExecArray | null;

  while ((m = CLASS_RE.exec(sourceStr)) !== null) {
    const indent = m[1]!.length;
    const name = m[2]!;
    const superclass = m[3] ?? '';
    const start = m.index;
    const afterHeader = m.index + m[0].length;

    const body = extractIndentedBlock(sourceStr, afterHeader, indent);
    blocks.push({ name, superclass, body, start });
  }

  return blocks;
}

/**
 * Extract the body of a Ruby `do...end` or `class...end` block by finding the
 * `end` keyword at the same indentation level as the block opener.
 *
 * This handles the typical Rails file structure. It won't be perfect for
 * files with inline `if`/`unless` at the same indent — an acceptable
 * trade-off for a Phase 5 adapter.
 */
function extractIndentedBlock(
  sourceStr: string,
  afterHeader: number,
  indent: number,
): string {
  const remaining = sourceStr.slice(afterHeader);
  const END_RE = new RegExp(`^[ \\t]{${indent}}end\\b`, 'gm');
  const endMatch = END_RE.exec(remaining);
  return endMatch ? remaining.slice(0, endMatch.index) : remaining;
}

// ─── Model extraction ─────────────────────────────────────────────────────────

const MODEL_SUPERCLASSES = new Set([
  'ApplicationRecord',
  'ActiveRecord::Base',
  'ActiveModel::Model',
  'ActiveRecord::Base', // covered above; explicit for clarity
]);

const ASSOCIATION_RE = /^\s*(has_many|belongs_to|has_one)\s+:(\w+)/gm;

function extractModels(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  for (const cls of findClassBlocks(sourceStr)) {
    const base = cls.superclass.split('::').pop() ?? '';
    if (!MODEL_SUPERCLASSES.has(cls.superclass) && !MODEL_SUPERCLASSES.has(base)) continue;

    // Collect associations from the class body
    const associations: string[] = [];
    ASSOCIATION_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ASSOCIATION_RE.exec(cls.body)) !== null) {
      associations.push(am[2]!);
    }

    symbols.push({
      id: makeId(filePath, cls.name, 'model'),
      name: cls.name,
      kind: 'model',
      filePath,
      startByte: cls.start,
      endByte: 0,
      signature: `class ${cls.name} < ${cls.superclass}`,
      summary: `Rails model: ${cls.name}`,
      frameworkMeta: {
        rails_model: true,
        ...(associations.length ? { associations } : {}),
      },
    });
  }
  return symbols;
}

// ─── Controller extraction ────────────────────────────────────────────────────

const CONTROLLER_SUPERCLASSES = new Set([
  'ApplicationController',
  'ActionController::Base',
  'ActionController::API',
]);

function extractPublicMethodNames(classBody: string): string[] {
  // Split on the first standalone 'private' or 'protected' line (no args)
  const privateIdx = classBody.search(/^\s*(?:private|protected)\s*$/m);
  const publicPart = privateIdx >= 0 ? classBody.slice(0, privateIdx) : classBody;

  const names: string[] = [];
  const DEF_RE = /^\s+def\s+([a-z_]\w*)/gm;
  let m: RegExpExecArray | null;
  while ((m = DEF_RE.exec(publicPart)) !== null) {
    names.push(m[1]!);
  }
  return names;
}

function extractControllers(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  for (const cls of findClassBlocks(sourceStr)) {
    const base = cls.superclass.split('::').slice(-2).join('::');
    if (
      !CONTROLLER_SUPERCLASSES.has(cls.superclass) &&
      !CONTROLLER_SUPERCLASSES.has(base)
    ) {
      continue;
    }

    symbols.push({
      id: makeId(filePath, cls.name, 'class'),
      name: cls.name,
      kind: 'class',
      filePath,
      startByte: cls.start,
      endByte: 0,
      signature: `class ${cls.name} < ${cls.superclass}`,
      summary: `Rails controller: ${cls.name}`,
      frameworkMeta: { rails_controller: true },
    });

    // Public methods are actions (request handlers)
    for (const methodName of extractPublicMethodNames(cls.body)) {
      const qualName = `${cls.name}#${methodName}`;
      symbols.push({
        id: makeId(filePath, qualName, 'view'),
        name: qualName,
        kind: 'view',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `def ${methodName}`,
        summary: `Rails controller action: ${qualName}`,
        frameworkMeta: { rails_action: true },
      });
    }
  }
  return symbols;
}

// ─── Job extraction ───────────────────────────────────────────────────────────

const JOB_SUPERCLASSES = new Set([
  'ApplicationJob',
  'ActiveJob::Base',
]);

function extractJobs(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  for (const cls of findClassBlocks(sourceStr)) {
    const base = cls.superclass.split('::').pop() ?? '';
    if (!JOB_SUPERCLASSES.has(cls.superclass) && !JOB_SUPERCLASSES.has(base)) continue;
    symbols.push({
      id: makeId(filePath, cls.name, 'class'),
      name: cls.name,
      kind: 'class',
      filePath,
      startByte: cls.start,
      endByte: 0,
      signature: `class ${cls.name} < ${cls.superclass}`,
      summary: `Rails job: ${cls.name}`,
      frameworkMeta: { rails_job: true },
    });
  }
  return symbols;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

/** Rails resource routes: [HTTP method, path suffix, action name] */
const RESOURCE_ROUTES: [string, string, string][] = [
  ['GET',    '',          'index'],
  ['POST',   '',          'create'],
  ['GET',    '/:id',      'show'],
  ['PUT',    '/:id',      'update'],
  ['DELETE', '/:id',      'destroy'],
];

/** Rails singular resource routes */
const SINGULAR_RESOURCE_ROUTES: [string, string, string][] = [
  ['GET',    '',      'show'],
  ['POST',   '',      'create'],
  ['PUT',    '',      'update'],
  ['DELETE', '',      'destroy'],
];

const ROUTE_METHOD_RE = new RegExp(
  `\\b(${HTTP_METHODS.join('|')})\\s+['"]([^'"]+)['"]`,
  'gi',
);
const RESOURCES_RE = /\bresources\s+:(\w+)/g;
const RESOURCE_RE = /\bresource\s+:(\w+)/g; // singular

interface NamespaceBlock {
  prefix: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Locate all `namespace :name do...end` blocks in `sourceStr`.
 * Uses indentation-based `end` matching: finds the `end` at the same column
 * as the `namespace` keyword.
 */
function findNamespaceBlocks(sourceStr: string): NamespaceBlock[] {
  const blocks: NamespaceBlock[] = [];
  const NS_RE = /^([ \t]*)namespace\s+:(\w+)\s+do\b[^\n]*/gm;
  // Collect all matches first to avoid lastIndex corruption during recursion
  const matches: RegExpExecArray[] = [];
  let gm: RegExpExecArray | null;
  NS_RE.lastIndex = 0;
  while ((gm = NS_RE.exec(sourceStr)) !== null) matches.push(gm);

  for (const m of matches) {
    const indent = m[1]!.length;
    const prefix = m[2]!;
    const start = m.index;
    const afterHeader = m.index + m[0].length;

    const body = extractIndentedBlock(sourceStr, afterHeader, indent);
    const end = afterHeader + body.length;
    blocks.push({ prefix, body, start, end });
  }
  return blocks;
}

function extractRoutes(
  sourceStr: string,
  filePath: string,
  prefixStack: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Pre-collect namespace blocks so we can exclude their ranges from the outer scan
  const namespaces = findNamespaceBlocks(sourceStr);
  const isInsideNamespace = (index: number): boolean =>
    namespaces.some((n) => index >= n.start && index < n.end);

  // ── HTTP method routes ───────────────────────────────────────────────────
  ROUTE_METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_METHOD_RE.exec(sourceStr)) !== null) {
    if (isInsideNamespace(m.index)) continue;
    const httpMethod = m[1]!.toUpperCase();
    const routePath = m[2]!;
    const fullPath = prefixStack + routePath;
    const name = `${httpMethod} ${fullPath}`;
    symbols.push({
      id: makeId(filePath, name, 'route'),
      name,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `${m[1]!} '${fullPath}', ...`,
      summary: `Rails route: ${name}`,
      frameworkMeta: { rails_route: true, http_method: httpMethod, route_path: fullPath },
    });
  }

  // ── resources :name → 5 CRUD routes ─────────────────────────────────────
  RESOURCES_RE.lastIndex = 0;
  while ((m = RESOURCES_RE.exec(sourceStr)) !== null) {
    if (isInsideNamespace(m.index)) continue;
    const resourceName = m[1]!;
    const basePath = `${prefixStack}/${resourceName}`;
    for (const [httpMethod, suffix] of RESOURCE_ROUTES) {
      const fullPath = basePath + suffix;
      const name = `${httpMethod} ${fullPath}`;
      symbols.push({
        id: makeId(filePath, name, 'route'),
        name,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `resources :${resourceName} → ${httpMethod} ${fullPath}`,
        summary: `Rails resource route: ${name}`,
        frameworkMeta: {
          rails_route: true,
          http_method: httpMethod,
          route_path: fullPath,
          rails_resource: true,
        },
      });
    }
  }

  // ── resource :name (singular) → 4 routes ────────────────────────────────
  RESOURCE_RE.lastIndex = 0;
  while ((m = RESOURCE_RE.exec(sourceStr)) !== null) {
    if (isInsideNamespace(m.index)) continue;
    const resourceName = m[1]!;
    const basePath = `${prefixStack}/${resourceName}`;
    for (const [httpMethod, suffix] of SINGULAR_RESOURCE_ROUTES) {
      const fullPath = basePath + suffix;
      const name = `${httpMethod} ${fullPath}`;
      symbols.push({
        id: makeId(filePath, name, 'route'),
        name,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `resource :${resourceName} → ${httpMethod} ${fullPath}`,
        summary: `Rails singular resource route: ${name}`,
        frameworkMeta: {
          rails_route: true,
          http_method: httpMethod,
          route_path: fullPath,
          rails_resource: true,
        },
      });
    }
  }

  // ── namespace blocks — recurse with prefix ───────────────────────────────
  for (const ns of namespaces) {
    const childSymbols = extractRoutes(
      ns.body,
      filePath,
      `${prefixStack}/${ns.prefix}`,
    );
    symbols.push(...childSymbols);
  }

  return symbols;
}

// ─── Rails adapter ────────────────────────────────────────────────────────────

export const railsAdapter: FrameworkAdapter = {
  name: 'rails',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    const gemfilePath = join(projectRoot, 'Gemfile');
    if (!existsSync(gemfilePath)) return false;
    try {
      const content = readFileSync(gemfilePath, 'utf8');
      return /^\s*gem\s+['"]rails['"]/m.test(content);
    } catch {
      return false;
    }
  },

  fileFilter(filePath: string): boolean {
    if (!filePath.endsWith('.rb')) return false;
    return (
      /app[\\/]models[\\/]/.test(filePath) ||
      /app[\\/]controllers[\\/]/.test(filePath) ||
      /app[\\/]jobs[\\/]/.test(filePath) ||
      filePath.endsWith('config/routes.rb') ||
      filePath.endsWith('config\\routes.rb')
    );
  },

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    if (/app[\\/]models[\\/]/.test(filePath)) {
      return extractModels(sourceStr, filePath);
    }
    if (/app[\\/]controllers[\\/]/.test(filePath)) {
      return extractControllers(sourceStr, filePath);
    }
    if (/app[\\/]jobs[\\/]/.test(filePath)) {
      return extractJobs(sourceStr, filePath);
    }
    if (filePath.endsWith('routes.rb')) {
      return extractRoutes(sourceStr, filePath, '');
    }
    return [];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(railsAdapter);
logger.debug("Adapter 'rails' registered");
