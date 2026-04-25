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

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Strip Haddock comment markers from a `haddock` node's text.
 * Handles `-- |`, `-- ^`, and block `{- | ... -}` forms.
 */
function stripHaddock(text: string): string {
  // Block haddock: {- | ... -}
  const block = text.match(/\{-\s*\|?\s*([\s\S]*?)\s*-\}/);
  if (block) {
    return block[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  // Line haddock: one or more `-- |` or `-- ^` lines
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*--\s*[\|^]?\s*/, ''))
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 200);
}

/**
 * Find the Haddock comment that precedes `node` inside a `declarations` block.
 *
 * The tree-sitter-haskell grammar places haddock nodes in two locations:
 * - Inside `declarations`: as a named sibling immediately before the
 *   next declaration.
 * - At root level: when the haddock precedes the very first declaration,
 *   it becomes a sibling of `declarations` itself (i.e., a child of the
 *   root `haskell` node).
 *
 * Strategy: check `previousNamedSibling`; if the node is the first
 * in `declarations`, also check `declarations.previousNamedSibling`.
 */
export function extractDocstring(node: SyntaxNode): string | null {
  const prev = node.previousNamedSibling;
  if (prev?.type === 'haddock') {
    return stripHaddock(prev.text) || null;
  }
  // `function` / `bind` nodes have their `@doc` before the `signature` sibling:
  //   haddock → signature → function
  // so we traverse one more step.
  if (prev?.type === 'signature') {
    const sigPrev = prev.previousNamedSibling;
    if (sigPrev?.type === 'haddock') {
      return stripHaddock(sigPrev.text) || null;
    }
    // The signature might itself be the first in declarations — check parent's prev
    if (!sigPrev && prev.parent?.type === 'declarations') {
      const parentPrev = prev.parent.previousNamedSibling;
      if (parentPrev?.type === 'haddock') {
        return stripHaddock(parentPrev.text) || null;
      }
    }
  }
  // First node in declarations → check parent's previous sibling
  if (!prev && node.parent?.type === 'declarations') {
    const parentPrev = node.parent.previousNamedSibling;
    if (parentPrev?.type === 'haddock') {
      return stripHaddock(parentPrev.text) || null;
    }
  }
  return null;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

/**
 * Extract the text of a `module` name node (e.g. `Data.Map.Strict`).
 */
function moduleText(node: SyntaxNode): string {
  return node.text;
}

/**
 * Walk the `declarations` node and emit symbols.
 *
 * Haskell-specific rules:
 * - `signature` nodes are NOT symbols; they provide the type annotation for
 *   the function/binding that follows. We collect them into `sigMap`.
 * - `function` and `bind` nodes with the same name may appear multiple times
 *   (multiple equations / pattern matching). We emit only the FIRST occurrence.
 * - `bind` without a preceding signature is a constant (`'const'`).
 * - Local bindings inside `where` clauses live in `local_binds` children —
 *   we never recurse into them.
 */
function walkDeclarations(
  declsNode: SyntaxNode,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  // First pass: build sigMap (name → signature text)
  const sigMap = new Map<string, string>();
  for (const node of declsNode.children) {
    if (!node.isNamed) continue;
    if (node.type === 'signature') {
      const varNode = node.children.find((c) => c.type === 'variable');
      if (varNode) {
        const name = sourceStr.slice(varNode.startIndex, varNode.endIndex);
        sigMap.set(name, trunc(sourceStr.slice(node.startIndex, node.endIndex)));
      }
    }
  }

  // Second pass: emit symbols
  const seen = new Set<string>(); // deduplicate multiple equations

  for (const node of declsNode.children) {
    if (!node.isNamed) continue;

    switch (node.type) {
      case 'signature':
      case 'haddock':
        // Not symbols themselves; used for context
        break;

      // ── Top-level function definition ──────────────────────────────────────
      case 'function': {
        const varNode = node.children.find((c) => c.type === 'variable');
        if (!varNode) break;
        const name = sourceStr.slice(varNode.startIndex, varNode.endIndex);
        if (seen.has(name)) break; // duplicate equation
        seen.add(name);
        const sig = sigMap.get(name) ?? trunc(`${name} = ...`);
        symbols.push({
          id: makeId(filePath, name, 'function'),
          name,
          kind: 'function',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      // ── Pattern binding (no-arg function or constant) ──────────────────────
      case 'bind': {
        const varNode = node.children.find((c) => c.type === 'variable');
        if (!varNode) break;
        const name = sourceStr.slice(varNode.startIndex, varNode.endIndex);
        if (seen.has(name)) break;
        seen.add(name);
        const hasSig = sigMap.has(name);
        const kind: SymbolKind = hasSig ? 'function' : 'const';
        const sig = sigMap.get(name) ?? trunc(sourceStr.slice(node.startIndex, node.endIndex));
        symbols.push({
          id: makeId(filePath, name, kind),
          name,
          kind,
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: sig,
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      // ── Algebraic data type ────────────────────────────────────────────────
      case 'data_type': {
        const nameNode = node.children.find((c) => c.type === 'name');
        if (!nameNode) break;
        const typeName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        const nodeText = sourceStr.slice(node.startIndex, node.endIndex);
        symbols.push({
          id: makeId(filePath, typeName, 'class'),
          name: typeName,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(nodeText.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
        });
        // Emit constructors
        const ctors = node.children.find((c) => c.type === 'data_constructors');
        if (ctors) {
          for (const ctor of ctors.children) {
            if (ctor.type !== 'data_constructor') continue;
            // Constructor name varies by form:
            //   prefix:   data Color = Red | ...      → child type 'prefix'
            //   record:   data User = User { ... }    → child type 'record' → grandchild 'constructor'
            const ctorChild =
              ctor.children.find((c) => c.type === 'prefix') ??
              ctor.children.find((c) => c.type === 'constructor') ??
              ctor.children.find((c) => c.type === 'record')?.children.find((c) => c.type === 'constructor');
            if (!ctorChild) continue;
            const ctorName = sourceStr.slice(ctorChild.startIndex, ctorChild.endIndex);
            const ctorText = sourceStr.slice(ctor.startIndex, ctor.endIndex);
            symbols.push({
              id: makeId(filePath, ctorName, 'const'),
              name: ctorName,
              kind: 'const',
              filePath,
              startByte: ctor.startIndex,
              endByte: ctor.endIndex,
              signature: trunc(ctorText.replace(/\s+/g, ' ')),
              summary: '',
            });
          }
        }
        break;
      }

      // ── Newtype ────────────────────────────────────────────────────────────
      case 'newtype': {
        const nameNode = node.children.find((c) => c.type === 'name');
        if (!nameNode) break;
        const name = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        const nodeText = sourceStr.slice(node.startIndex, node.endIndex);
        symbols.push({
          id: makeId(filePath, name, 'type'),
          name,
          kind: 'type',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(nodeText.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      // ── Type synonym (note: grammar spells it "synomym") ──────────────────
      case 'type_synomym': {
        const nameNode = node.children.find((c) => c.type === 'name');
        if (!nameNode) break;
        const name = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          id: makeId(filePath, name, 'type'),
          name,
          kind: 'type',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(sourceStr.slice(node.startIndex, node.endIndex)),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      // ── Typeclass definition ───────────────────────────────────────────────
      case 'class': {
        const nameNode = node.children.find((c) => c.type === 'name');
        if (!nameNode) break;
        const name = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        const nodeText = sourceStr.slice(node.startIndex, node.endIndex);
        symbols.push({
          id: makeId(filePath, name, 'interface'),
          name,
          kind: 'interface',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(nodeText.split('\n')[0]),
          summary: extractDocstring(node) ?? '',
        });
        break;
      }

      // ── Typeclass instance ─────────────────────────────────────────────────
      case 'instance': {
        const nameNode = node.children.find((c) => c.type === 'name');
        if (!nameNode) break;
        const baseName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        // Build "ClassName Type" from name + type_patterns
        const typePatterns = node.children.find((c) => c.type === 'type_patterns');
        const typeText = typePatterns
          ? sourceStr.slice(typePatterns.startIndex, typePatterns.endIndex).trim()
          : '';
        const instName = typeText ? `${baseName} ${typeText}` : baseName;
        symbols.push({
          id: makeId(filePath, instName, 'class'),
          name: instName,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: trunc(`instance ${instName}`),
          summary: extractDocstring(node) ?? '',
          frameworkMeta: { haskell_instance: true },
        });
        break;
      }

      default:
        break;
    }
  }
}

function extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const sourceStr = source.toString('utf8');
  const declsNode = tree.rootNode.children.find((c) => c.type === 'declarations');
  if (declsNode) {
    walkDeclarations(declsNode, sourceStr, filePath, symbols);
  }
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(tree: Tree, source: Buffer): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const sourceStr = source.toString('utf8');
  const importsNode = tree.rootNode.children.find((c) => c.type === 'imports');
  if (!importsNode) return imports;

  for (const node of importsNode.children) {
    if (node.type !== 'import') continue;

    // First `module` child is the imported module (keyword `import` is not a `module` node)
    const mainModuleNode = node.children.find((c) => c.type === 'module');
    if (!mainModuleNode) continue;
    const specifier = sourceStr.slice(mainModuleNode.startIndex, mainModuleNode.endIndex);

    // Imported names from import_list (if present and not a `hiding` list)
    const importList = node.children.find((c) => c.type === 'import_list');
    const isHiding = node.children.some((c) => c.type === 'hiding');
    const importedNames: string[] = [];
    if (importList && !isHiding) {
      for (const child of importList.children) {
        if (child.type === 'import_name') {
          importedNames.push(sourceStr.slice(child.startIndex, child.endIndex));
        }
      }
    }

    imports.push({
      sourceFile: '',
      specifier,
      resolvedPath: null,
      importedNames,
      isTypeOnly: false,
    });
  }

  return imports;
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const haskellHandler: LanguageHandler = {
  extensions: () => ['.hs', '.lhs'],
  grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-haskell.wasm'),
  extractSymbols,
  extractImports,
  extractDocstring,
};
