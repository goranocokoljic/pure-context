import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function trunc(s: string, max = 120): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// ─── Comment extraction ───────────────────────────────────────────────────────

/**
 * Extract preceding # comments as a summary.
 * Walks backwards through named siblings collecting consecutive comment nodes.
 */
function extractPrecedingComment(node: SyntaxNode): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;

  while (prev && prev.type === 'comment') {
    const text = prev.text.replace(/^#+\s?/, '').trim();
    lines.unshift(text);
    prev = prev.previousNamedSibling;
  }

  if (lines.length === 0) return null;

  const joined = lines.join(' ');
  // Return up to first sentence break
  const match = joined.match(/^([^.!?]*[.!?]?)/);
  return ((match ? match[1]!.trim() : joined).slice(0, 200)) || null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const src = source.toString('utf8');
  const symbols: SymbolRecord[] = [];

  for (const node of tree.rootNode.children) {
    if (!node.isNamed) continue;

    // ── function_definition ──────────────────────────────────────────────────
    // Handles both: `function name() { ... }` and `name() { ... }`
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const name = nameNode.text.trim();
      if (!name) continue;

      const sig = trunc(`function ${name}()`);

      symbols.push({
        id: makeId(filePath, name, 'function'),
        name,
        kind: 'function',
        filePath,
        startByte: node.startIndex,
        endByte: node.endIndex,
        signature: sig,
        summary: extractPrecedingComment(node) ?? `Bash function: ${name}`,
      });
      continue;
    }

    // ── declaration_command — readonly/declare -g ────────────────────────────
    // `readonly VAR=value` or `declare -g VAR=value` → kind: 'const'
    if (node.type === 'declaration_command') {
      // First child is the keyword (readonly, declare, export, etc.)
      const keyword = node.children.find((c) => !c.isNamed)?.text ?? node.children[0]?.text ?? '';
      const isConst = keyword === 'readonly' || (
        keyword === 'declare' &&
        node.children.some((c) => c.text === '-g' || c.text === '-gr' || c.text === '-rg')
      );
      if (!isConst) continue;

      for (const child of node.children) {
        if (!child.isNamed || child.type !== 'variable_assignment') continue;
        const varNameNode = child.childForFieldName('name');
        if (!varNameNode) continue;
        const name = varNameNode.text.trim();
        if (!name) continue;

        const rawLine = src.slice(node.startIndex, node.endIndex).replace(/\s+/g, ' ').trim();
        symbols.push({
          id: makeId(filePath, name, 'const'),
          name,
          kind: 'const',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(rawLine),
          summary: extractPrecedingComment(node) ?? `Bash constant: ${name}`,
        });
      }
      continue;
    }
  }

  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extract `source ./file.sh` and `. ./file.sh` statements as ImportRecords.
 *
 * In the bash grammar these are `command` nodes where the command_name
 * text is "source" or ".".
 */
function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const src = source.toString('utf8');
  const imports: ImportRecord[] = [];

  function visitNode(node: SyntaxNode): void {
    if (node.type === 'command') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const cmd = nameNode.text.trim();
        if (cmd === 'source' || cmd === '.') {
          // First argument is the file path
          const argNode = node.children.find(
            (c) => c.isNamed && c.type !== 'command_name' && c !== nameNode,
          );
          if (argNode) {
            const specifier = argNode.text.trim().replace(/^["']|["']$/g, '');
            if (specifier) {
              imports.push({
                sourceFile: '',
                specifier,
                resolvedPath: specifier.startsWith('.') ? specifier : null,
                importedNames: [],
                isTypeOnly: false,
              });
            }
          }
        }
      }
    }
    // Walk into compound_statement and other block-level nodes
    for (const child of node.children) {
      if (child.isNamed) visitNode(child);
    }
  }

  for (const child of tree.rootNode.children) {
    visitNode(child);
  }

  // Deduplicate by specifier
  const seen = new Set<string>();
  return imports.filter((imp) => {
    if (seen.has(imp.specifier)) return false;
    seen.add(imp.specifier);
    return true;
  });
}

// ─── extractDocstring (implements LanguageHandler interface) ──────────────────

function extractDocstring(node: SyntaxNode): string | null {
  return extractPrecedingComment(node);
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const bashHandler: LanguageHandler = {
  extensions: () => ['.sh', '.bash', '.zsh', '.fish'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-bash.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
