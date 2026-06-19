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

  it('detects lang="tsx" as typescript', () => {
    const sfc = buf('<script lang="tsx">\nconst x = <div />\n</script>');
    const blocks = splitVueSFC(sfc, 'Foo.vue');
    expect(blocks[0]!.language).toBe('typescript');
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

  it('throws ParseError for extra </script> close tag', () => {
    const sfc = buf('<script lang="ts">const x = 1</script></script>');
    expect(() => splitVueSFC(sfc, 'Bad.vue')).toThrow(ParseError);
  });

  it('ParseError message includes the file path', () => {
    const sfc = buf('<script lang="ts">const x = 1');
    expect(() => splitVueSFC(sfc, 'src/Bad.vue')).toThrow(/src\/Bad\.vue/);
  });
});
