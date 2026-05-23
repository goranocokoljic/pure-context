/**
 * XML language handler — regex-based, shallow extraction.
 *
 * Handles XML-family files (.xml, .xul, .svg, .plist).
 * Note: SVG and XML indexing is opt-in via config (xmlExtensions setting).
 * By default only .xml and .xul are indexed; .svg and .plist require opt-in.
 *
 * Symbols extracted (shallow by design):
 *   Root element tag               → kind: 'class', name: root tag name
 *   Elements with id="..."        → kind: 'const', name: id value
 *   XUL <command id="...">,
 *       <menuitem id="...">        → kind: 'const'
 *
 * Imports:
 *   <script src="...">            → ImportRecord
 *   <?xml-stylesheet href="...">  → ImportRecord
 *
 * Summary: nearest preceding XML comment <!-- description -->.
 */
import { createHash } from 'crypto';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';

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

// ─── Line utilities ───────────────────────────────────────────────────────────

interface LineInfo {
  text: string;
  startByte: number;
  endByte: number;
}

function buildLineIndex(source: Buffer): LineInfo[] {
  const text = source.toString('utf8');
  const lines: LineInfo[] = [];
  let byteOffset = 0;
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    lines.push({ text: line, startByte: byteOffset, endByte: byteOffset + lineBytes });
    byteOffset += lineBytes + 1; // +1 for \n
  }
  return lines;
}

/**
 * Find the nearest XML comment preceding lineIdx.
 * Looks for `<!-- ... -->` either inline on the preceding line or as a
 * multi-line block ending on the line just before lineIdx.
 */
function precedingXmlComment(lines: LineInfo[], lineIdx: number): string | null {
  let i = lineIdx - 1;
  // Skip blank lines
  while (i >= 0 && lines[i]!.text.trim() === '') i--;
  if (i < 0) return null;

  const above = lines[i]!.text;

  // Single-line comment: <!-- text -->
  const single = /<!--\s*(.*?)\s*-->/.exec(above);
  if (single) return trunc(single[1]!);

  // End of a multi-line comment block: ends with -->
  if (above.trimEnd().endsWith('-->')) {
    const docLines: string[] = [];
    while (i >= 0) {
      const t = lines[i]!.text;
      const commentStart = t.indexOf('<!--');
      const cleaned = t
        .replace(/<!--/, '')
        .replace(/-->/, '')
        .replace(/^\s*\*?\s*/, '')
        .trim();
      if (cleaned) docLines.unshift(cleaned);
      if (commentStart !== -1) break;
      i--;
    }
    if (docLines.length > 0) {
      const content = docLines.join(' ').trim();
      return trunc(content) || null;
    }
  }

  return null;
}

// ─── Symbol disambiguation ────────────────────────────────────────────────────

const GENERIC_XML_STEMS = new Set(['pom', 'index', 'default', 'config', 'settings']);

/**
 * Disambiguate an XML symbol name when the same root tag appears in many files.
 * For depth ≤ 2 elements whose tag name differs from the file-stem, append the
 * module identifier so `project` in `maven-core/pom.xml` becomes `project@maven-core`.
 */
function disambiguateXmlName(tagName: string, filePath: string, depth: number): string {
  if (depth > 2) return tagName;

  // Compute file-stem and parent directory name
  const parts = filePath.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1] ?? '';
  const dotIdx = filename.lastIndexOf('.');
  const stem = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;

  // Only disambiguate when the file lives inside at least one subdirectory.
  // Root-level files (e.g. the single top-level pom.xml) are unique by definition.
  if (parts.length < 2) return tagName;

  const parentDir = parts[parts.length - 2]!;

  // Choose disambiguator: use parent dir name when stem is generic
  const disambiguator = GENERIC_XML_STEMS.has(stem.toLowerCase())
    ? parentDir
    : stem;

  if (!disambiguator || disambiguator.toLowerCase() === tagName.toLowerCase()) {
    return tagName;
  }

  return `${tagName}@${disambiguator}`;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// Opening tag with optional attributes: <tagName ...
const OPEN_TAG_RE = /<(\w[\w:.-]*)((?:\s+[^>]*)?)\s*\/?>/;
// id attribute value
const ID_ATTR_RE = /\bid\s*=\s*["']([^"']+)["']/;
// script src attribute
const SCRIPT_SRC_RE = /<script(?:[^>]*)\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i;
// xml-stylesheet href
const STYLESHEET_HREF_RE = /<\?xml-stylesheet[^?]*\bhref\s*=\s*["']([^"']+)["'][^?]*\?>/i;
// XML declaration and DOCTYPE — skip these
const XML_DECL_RE = /^<\?xml\b|^<!DOCTYPE\b|^<!--/;

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
  const text = source.toString('utf8');
  const lines = buildLineIndex(source);
  const symbols: SymbolRecord[] = [];
  const seenIds = new Set<string>();

  // ── Find root element ─────────────────────────────────────────────────────
  // The root element is the first non-declaration, non-comment opening tag.
  let rootFound = false;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.text.trim();
    if (!lineText || XML_DECL_RE.test(lineText)) continue;

    const tagMatch = OPEN_TAG_RE.exec(lineText);
    if (tagMatch && !rootFound) {
      const tagName = tagMatch[1]!;
      rootFound = true;
      const disambiguated = disambiguateXmlName(tagName, filePath, 1);
      // Include bare tag name in bodySnippet so FTS still matches plain `project` queries
      const bodySnippet = disambiguated !== tagName ? tagName : undefined;
      symbols.push({
        id: makeId(filePath, disambiguated, 'class'),
        name: disambiguated,
        kind: 'class',
        filePath,
        startByte: lines[i]!.startByte,
        endByte: lines[lines.length - 1]!.endByte,
        signature: trunc(`<${tagName}>`),
        summary: precedingXmlComment(lines, i) ?? `XML root element: ${tagName}`,
        ...(bodySnippet && { bodySnippet }),
      });
    }

    if (rootFound) break;
  }

  // ── Find id-attributed elements ───────────────────────────────────────────
  // Scan full text for all elements with id= attributes
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.text;
    const idMatch = ID_ATTR_RE.exec(lineText);
    if (!idMatch) continue;

    const idValue = idMatch[1]!;
    if (seenIds.has(idValue)) continue;
    seenIds.add(idValue);

    // Extract the tag name from this line
    const tagMatch = /<(\w[\w:.-]*)/.exec(lineText);
    const tagName = tagMatch ? tagMatch[1]! : 'element';

    symbols.push({
      id: makeId(filePath, idValue, 'const'),
      name: idValue,
      kind: 'const',
      filePath,
      startByte: lines[i]!.startByte,
      endByte: lines[i]!.endByte,
      signature: trunc(`<${tagName} id="${idValue}">`),
      summary: precedingXmlComment(lines, i) ?? `XML element: ${idValue}`,
    });
  }

  // Suppress unused variable warning — text is used implicitly via lines
  void text;
  return symbols;
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(_tree: Tree, source: Buffer): ImportRecord[] {
  const lines = buildLineIndex(source);
  const imports: ImportRecord[] = [];

  for (const { text } of lines) {
    // <script src="...">
    const scriptMatch = SCRIPT_SRC_RE.exec(text);
    if (scriptMatch) {
      const src = scriptMatch[1]!;
      const isExternal = /^https?:\/\//.test(src);
      imports.push({
        sourceFile: '',
        specifier: src,
        resolvedPath: isExternal ? null : src,
        importedNames: [],
        isTypeOnly: false,
      });
      continue;
    }

    // <?xml-stylesheet href="...">
    const styleMatch = STYLESHEET_HREF_RE.exec(text);
    if (styleMatch) {
      const href = styleMatch[1]!;
      const isExternal = /^https?:\/\//.test(href);
      imports.push({
        sourceFile: '',
        specifier: href,
        resolvedPath: isExternal ? null : href,
        importedNames: [],
        isTypeOnly: false,
      });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return imports.filter((imp) => {
    if (seen.has(imp.specifier)) return false;
    seen.add(imp.specifier);
    return true;
  });
}

// ─── extractDocstring ─────────────────────────────────────────────────────────

function extractDocstring(_node: SyntaxNode): string | null {
  return null; // regex-based, no tree-sitter nodes
}

// ─── Handler export ───────────────────────────────────────────────────────────

export const xmlHandler: LanguageHandler = {
  extensions: () => ['.xml', '.xul'],
  grammarPath: () => null, // no pre-built WASM; uses regex extraction
  extractSymbols,
  extractImports,
  extractDocstring,
};
