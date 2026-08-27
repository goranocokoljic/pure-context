import { describe, it, expect } from 'vitest';
import { splitVueSFC } from '../../src/adapters/vue-preprocessor.js';
import { ParseError } from '../../src/core/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('splitVueSFC', () => {

  // ── Basic extraction ────────────────────────────────────────────────────────

  it('returns [] for a template-only SFC (no script block)', () => {
    const sfc = buf('<template><p>Hello</p></template>');
    expect(splitVueSFC(sfc, 'Foo.vue')).toEqual([]);
  });

  it('extracts a plain <script> block as javascript', () => {
    const sfc = buf('<template></template>\n<script>\nexport default {}\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('javascript');
    expect(blocks[0]!.content.toString()).toContain('export default {}');
  });

  it('extracts <script setup> as javascript when no lang', () => {
    const sfc = buf('<script setup>\nconst x = 1\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('javascript');
  });

  // ── Language detection ──────────────────────────────────────────────────────

  it('detects lang="ts" as typescript', () => {
    const sfc = buf('<script lang="ts">\nconst x: number = 1\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('typescript');
  });

  it('detects lang="tsx" as tsx (JSX-capable grammar, not plain typescript)', () => {
    // The fixture contains literal JSX — the plain TS grammar cannot parse it,
    // so the block must route to the tsx handler (Phase 93, V-6).
    const sfc = buf('<script lang="tsx">\nconst x = <div />\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('tsx');
  });

  it('detects lang with single quotes', () => {
    const sfc = buf("<script lang='ts'>\nconst x = 1\n</script>");
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('typescript');
  });

  it('treats lang="js" as javascript', () => {
    const sfc = buf('<script lang="js">\nconst x = 1\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('javascript');
  });

  it('is case-insensitive for lang value', () => {
    const sfc = buf('<script lang="TS">\nconst x = 1\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('typescript');
  });

  // ── Both <script> and <script setup> ───────────────────────────────────────

  it('returns both blocks when <script> and <script setup> are present', () => {
    const sfc = buf(
      '<script lang="ts">\nimport { ref } from "vue"\n</script>\n' +
      '<script setup lang="ts">\nconst count = ref(0)\n</script>'
    );
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.content.toString()).toContain('import { ref }');
    expect(blocks[1]!.content.toString()).toContain('const count');
  });

  // ── Byte offset correctness ─────────────────────────────────────────────────

  it('offsetInOriginal points to content start after the opening tag', () => {
    const prefix = '<template><p>hi</p></template>\n';
    const openTag = '<script lang="ts">';
    const content = '\nconst x = 1\n';
    const sfc = buf(prefix + openTag + content + '</script>');

    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);

    const expectedOffset = Buffer.byteLength(prefix + openTag, 'utf8');
    expect(blocks[0]!.offsetInOriginal).toBe(expectedOffset);
  });

  it('computes correct byte offset with multi-byte chars before script block', () => {
    // 3-byte UTF-8 characters (e.g. CJK)
    const chineseTemplate = '<template>你好世界</template>\n';
    const openTag = '<script lang="ts">';
    const content = 'export const greeting = "hi"';
    const sfc = buf(chineseTemplate + openTag + content + '</script>');

    const blocks = splitVueSFC(sfc, 'Foo.vue');
    const expectedOffset = Buffer.byteLength(chineseTemplate + openTag, 'utf8');
    expect(blocks[0]!.offsetInOriginal).toBe(expectedOffset);

    // Verify the offset actually points into the original buffer correctly
    const slice = sfc.slice(blocks[0]!.offsetInOriginal);
    expect(slice.toString('utf8').startsWith(content)).toBe(true);
  });

  it('content buffer matches the raw inner text byte-for-byte', () => {
    const inner = '\nexport const PI = 3.14\n';
    const sfc = buf(`<script lang="ts">${inner}</script>`);
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.content.toString('utf8')).toBe(inner);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('handles empty script block', () => {
    const sfc = buf('<script lang="ts"></script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString()).toBe('');
  });

  it('returns [] for style-only SFC', () => {
    const sfc = buf('<style>.btn { color: red; }</style>');
    expect(splitVueSFC(sfc, 'Foo.vue')).toEqual([]);
  });

  it('ignores template and style blocks, only returns script blocks', () => {
    const sfc = buf(
      '<template><div>hello</div></template>\n' +
      '<script lang="ts">\nconst x = 1\n</script>\n' +
      '<style>.foo { color: red; }</style>'
    );
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString()).toContain('const x = 1');
  });

  // ── Embedded "<script" that is NOT a top-level SFC tag ──────────────────────
  // Real top-level <script> blocks start at column 0; "<script" appearing
  // mid-line (regex literals, JS strings, indented template markup) must not be
  // counted as a tag.

  it('ignores a <script regex literal inside the script body', () => {
    // Mirrors a real component (TextEditor.vue): a regex that matches <script>…</script>.
    const sfc = buf(
      '<script setup>\n' +
      '  const scriptRegex = /<script\\b[^>]*>[\\s\\S]*?<\\/script\\b[^>]*>/g\n' +
      '  const el = document.createElement("script")\n' +
      '</script>',
    );
    const blocks = splitVueSFC(sfc, 'TextEditor.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString('utf8')).toContain('scriptRegex');
  });

  it('ignores indented <script> HTML strings inside the script body', () => {
    // Mirrors Sudoku.vue: JS strings that build HTML containing <script> tags,
    // indented and with closes escaped as <\/script> to survive Vue's compiler.
    const sfc = buf(
      '<script setup>\n' +
      '  const html = `\n' +
      '        <script type="text/javascript" src="/a.js"><\\/script>\n' +
      '        <script>window.go()<\\/script>\n' +
      '  `\n' +
      '  useGame(html)\n' +
      '</script>',
    );
    const blocks = splitVueSFC(sfc, 'Sudoku.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString('utf8')).toContain('useGame');
  });

  // ── Error cases ─────────────────────────────────────────────────────────────

  it('throws ParseError for unclosed <script> tag', () => {
    const sfc = buf('<script lang="ts">\nconst x = 1\n');
    expect(() => splitVueSFC(sfc, 'Bad.vue')).toThrow(ParseError);
  });

  it('extra </script> close tag no longer kills the file — matching block extracted', () => {
    const sfc = buf('<script lang="ts">const x = 1</script></script>');
    const blocks = splitVueSFC(sfc, 'Odd.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString('utf8')).toBe('const x = 1');
  });

  it('ParseError message includes the file path', () => {
    const sfc = buf('<script lang="ts">const x = 1');
    expect(() => splitVueSFC(sfc, 'src/Bad.vue')).toThrow(/src\/Bad\.vue/);
  });

  // ── Splitter resilience (Phase 93, Task 578) ───────────────────────────────

  it('parses a generic="..." attribute containing > (quote-aware attrs)', () => {
    const sfc = buf(
      '<script setup lang="ts" generic="T extends Record<string, any>">\n' +
      'const props = defineProps<{ items: T[] }>()\n' +
      'export function pick(t: T) { return t }\n' +
      '</script>',
    );
    const blocks = splitVueSFC(sfc, 'Generic.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('typescript');
    expect(blocks[0]!.content.toString('utf8')).toContain('defineProps');
    // Offset still points exactly at the content start
    const slice = sfc.slice(blocks[0]!.offsetInOriginal);
    expect(slice.toString('utf8').startsWith('\nconst props')).toBe(true);
  });

  it('a JSON-LD <script> inside <template> does not kill the real script block', () => {
    const sfc = buf(
      '<template>\n' +
      '  <div>\n' +
      '    <script type="application/ld+json">{"@type":"Article"}</script>\n' +
      '  </div>\n' +
      '</template>\n' +
      '<script setup lang="ts">\n' +
      'const title = "hello"\n' +
      '</script>',
    );
    const blocks = splitVueSFC(sfc, 'Article.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.toString('utf8')).toContain('const title');
  });

  it('still throws for a truly unterminated column-0 <script> open', () => {
    const sfc = buf('<template><p>x</p></template>\n<script setup>\nconst x = 1\n');
    expect(() => splitVueSFC(sfc, 'Bad.vue')).toThrow(ParseError);
  });
});
