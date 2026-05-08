import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const out = `export const VERSION = '${pkg.version}';\n`;
writeFileSync(join(__dirname, '../src/version.ts'), out);
console.log(`version.ts updated to ${pkg.version}`);
