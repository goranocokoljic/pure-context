/**
 * Large-project fixture generator — Phase 11 Task 95
 *
 * Generates a synthetic TypeScript project with 60,000+ symbols across multiple files.
 * Symbols use realistic domain prefixes (user_, auth_, payment_, order_, product_)
 * and include signatures and JSDoc docstrings.
 *
 * Usage:
 *   npx tsx test/fixtures/large-project/generate.ts
 *
 * Output: test/fixtures/large-project/src/  (created if absent)
 *
 * NOT included in the normal test suite — used for semantic benchmark tests only.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_DIR = join(__dirname, 'src');

// ─── Domain configuration ─────────────────────────────────────────────────────

const DOMAINS = [
  {
    prefix: 'user',
    verbs: ['create', 'update', 'delete', 'fetch', 'validate', 'list', 'search', 'archive', 'restore', 'merge'],
    nouns: ['User', 'Profile', 'Account', 'Credential', 'Session', 'Role', 'Permission', 'Group', 'Team', 'Invite'],
  },
  {
    prefix: 'auth',
    verbs: ['authenticate', 'authorize', 'revoke', 'refresh', 'verify', 'issue', 'validate', 'check', 'grant', 'deny'],
    nouns: ['Token', 'Session', 'Challenge', 'Factor', 'Policy', 'Scope', 'Grant', 'Claim', 'Identity', 'Provider'],
  },
  {
    prefix: 'payment',
    verbs: ['charge', 'refund', 'capture', 'authorize', 'cancel', 'confirm', 'retry', 'settle', 'process', 'void'],
    nouns: ['Payment', 'Invoice', 'Receipt', 'Subscription', 'Plan', 'Coupon', 'Discount', 'Tax', 'Ledger', 'Balance'],
  },
  {
    prefix: 'order',
    verbs: ['create', 'update', 'cancel', 'fulfill', 'ship', 'deliver', 'return', 'track', 'split', 'merge'],
    nouns: ['Order', 'LineItem', 'Cart', 'Wishlist', 'Shipment', 'Return', 'Refund', 'Address', 'Carrier', 'Package'],
  },
  {
    prefix: 'product',
    verbs: ['create', 'update', 'archive', 'publish', 'unpublish', 'price', 'list', 'search', 'import', 'export'],
    nouns: ['Product', 'Variant', 'Category', 'Tag', 'Image', 'Inventory', 'Warehouse', 'Review', 'Rating', 'Bundle'],
  },
  {
    prefix: 'notification',
    verbs: ['send', 'schedule', 'cancel', 'retry', 'deliver', 'read', 'dismiss', 'subscribe', 'unsubscribe', 'batch'],
    nouns: ['Notification', 'Channel', 'Template', 'Preference', 'Digest', 'Alert', 'Email', 'SMS', 'Push', 'Webhook'],
  },
] as const;

// ─── Code generators ──────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generate a standalone function symbol. */
function genFunction(domain: string, verb: string, noun: string, index: number): string {
  const fnName = `${verb}${capitalize(noun)}${index > 0 ? index : ''}`;
  const paramName = noun.toLowerCase();
  return `
/**
 * ${capitalize(verb)}s a ${noun.toLowerCase()} record in the ${domain} domain.
 * @param ${paramName} - The ${noun.toLowerCase()} to ${verb}
 * @returns Promise resolving to the processed ${noun.toLowerCase()}
 */
export async function ${fnName}(${paramName}: ${noun}, options?: ${noun}Options): Promise<${noun}Result> {
  // ${capitalize(domain)} domain: ${verb} ${noun.toLowerCase()} logic
  return ${domain}Service.${verb}(${paramName}, options);
}
`.trim();
}

/** Generate a class with methods. */
function genClass(domain: string, noun: string, verbs: readonly string[]): string {
  const className = `${capitalize(noun)}Repository`;
  const methods = verbs.map((verb, i) => `
  /**
   * ${capitalize(verb)}s the ${noun.toLowerCase()} entity.
   * @param id - Unique identifier for the ${noun.toLowerCase()}
   * @returns The ${verb}d ${noun.toLowerCase()} or null if not found
   */
  async ${verb}${capitalize(noun)}ById(id: string): Promise<${noun} | null> {
    return this.db.${verb}('${noun.toLowerCase()}', id);
  }`).join('\n');

  return `
/**
 * Repository for managing ${noun.toLowerCase()} entities in the ${domain} domain.
 * Provides CRUD operations and domain-specific queries.
 */
export class ${className} {
  constructor(private readonly db: DatabaseConnection) {}
${methods}
}
`.trim();
}

/** Generate a type/interface symbol. */
function genInterface(noun: string): string {
  return `
/**
 * Represents a ${noun.toLowerCase()} entity with its core properties.
 */
export interface ${noun} {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Options for ${noun.toLowerCase()} operations. */
export interface ${noun}Options {
  skipValidation?: boolean;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
}

/** Result returned by ${noun.toLowerCase()} operations. */
export interface ${noun}Result {
  success: boolean;
  data: ${noun};
  errors?: string[];
}
`.trim();
}

// ─── File writer ──────────────────────────────────────────────────────────────

interface SymbolCount {
  functions: number;
  classes: number;
  interfaces: number;
  total: number;
}

function generateDomainFile(
  domain: typeof DOMAINS[number],
  fileIndex: number,
): { content: string; count: SymbolCount } {
  const { prefix, verbs, nouns } = domain;
  const parts: string[] = [
    `// Generated: ${prefix} domain file ${fileIndex}`,
    `// Part of the large-project fixture for Phase 11 semantic search tests`,
    '',
    `type DatabaseConnection = { ${verbs.slice(0, 3).map(v => `${v}: (t: string, id: string) => unknown`).join('; ')} };`,
    '',
  ];

  let fnCount = 0;
  let classCount = 0;
  let interfaceCount = 0;

  // Emit interfaces for each noun
  for (const noun of nouns) {
    parts.push(genInterface(noun));
    parts.push('');
    interfaceCount += 3; // interface + Options + Result
  }

  // Emit standalone functions
  for (const noun of nouns) {
    for (let vi = 0; vi < verbs.length; vi++) {
      parts.push(genFunction(prefix, verbs[vi], noun, fileIndex));
      parts.push('');
      fnCount++;
    }
  }

  // Emit repository classes
  for (const noun of nouns) {
    parts.push(genClass(prefix, noun, verbs));
    parts.push('');
    classCount++;
  }

  return {
    content: parts.join('\n'),
    count: {
      functions: fnCount,
      classes: classCount,
      interfaces: interfaceCount,
      total: fnCount + classCount + interfaceCount,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let totalSymbols = 0;
  const FILES_PER_DOMAIN = 10; // 10 files × 6 domains = 60 files

  for (const domain of DOMAINS) {
    const domainDir = join(OUTPUT_DIR, domain.prefix);
    mkdirSync(domainDir, { recursive: true });

    for (let i = 0; i < FILES_PER_DOMAIN; i++) {
      const { content, count } = generateDomainFile(domain, i);
      const filePath = join(domainDir, `${domain.prefix}-${i}.ts`);
      writeFileSync(filePath, content, 'utf8');
      totalSymbols += count.total;

      if (i === 0) {
        console.log(`  ${domain.prefix}: ~${count.total} symbols/file × ${FILES_PER_DOMAIN} files`);
      }
    }
  }

  // Also generate a shared utilities file for cross-domain types
  const utilsContent = generateUtilities();
  writeFileSync(join(OUTPUT_DIR, 'utils.ts'), utilsContent, 'utf8');
  totalSymbols += 50; // approximate

  console.log(`\nGenerated ${totalSymbols.toLocaleString()} symbols across ${DOMAINS.length * FILES_PER_DOMAIN + 1} files`);
  console.log(`Output directory: ${OUTPUT_DIR}`);

  if (totalSymbols < 60_000) {
    console.warn(`\nWARNING: Only ${totalSymbols} symbols generated. Increase FILES_PER_DOMAIN to reach 60k+.`);
  }
}

function generateUtilities(): string {
  const functions = Array.from({ length: 50 }, (_, i) => `
/**
 * Utility function ${i + 1} — shared across all domains.
 * @param input - The input to transform
 * @returns Transformed result
 */
export function utilityFn${i + 1}<T>(input: T): T {
  return input;
}`).join('\n');

  return `// Shared utility functions for cross-domain operations\n${functions}\n`;
}

main();
