import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve grammars/ relative to the compiled output location (dist/core/ → ../../grammars/)
export const GRAMMARS_DIR = resolve(__dirname, '../../grammars');
