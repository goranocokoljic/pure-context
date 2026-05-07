/**
 * Global test setup — runs once per worker before any test file executes.
 *
 * web-tree-sitter is compiled with Emscripten. Its module-level IIFE does:
 *
 *   var document = "object" == typeof window
 *     ? { currentScript: window.document.currentScript }
 *     : null;
 *
 * In Node.js, `window` is normally undefined so `document` becomes null.
 * However, some tests call `vi.stubGlobal('window', { location: {...} })`
 * without providing a `.document` property. If those stubs leak into later
 * tests (before `unstubGlobals: true` restores them), web-tree-sitter's IIFE
 * sees `typeof window === 'object'` and crashes on `window.document.currentScript`.
 *
 * This setup file guards both cases:
 *  1. `window` undefined  → no action needed; tree-sitter handles it.
 *  2. `window` defined but missing `.document` → add a stub so the access
 *     returns `null` rather than throwing.
 */
const g = globalThis as Record<string, unknown>;
if (typeof g['window'] === 'object' && g['window'] !== null) {
  const win = g['window'] as Record<string, unknown>;
  if (win['document'] === undefined) {
    win['document'] = { currentScript: null };
  }
}
