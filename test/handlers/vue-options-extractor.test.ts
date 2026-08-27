/**
 * Phase 93 (Task 581) — Options API / defineComponent / Pinia extraction.
 *
 * V-4: Options-API bodies extracted zero symbols (origamicms-frontend: 174/254
 * SFCs are Options API, 0.03× symbol ratio). V-5: Pinia store actions were
 * unfindable (kurirfe: 6/25 ground-truth targets are store actions).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, _resetForTesting, parseFile } from '../../src/core/parse-dispatcher.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { processFile } from '../../src/core/file-processor.js';
import { vueAdapter } from '../../src/adapters/vue.js';
import type { SymbolRecord } from '../../src/core/types.js';

beforeAll(async () => {
  _resetForTesting();
  await initParser();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
});

async function vueSymbols(sfc: string, filePath = 'components/user-card.vue'): Promise<SymbolRecord[]> {
  const { symbols } = await processFile(filePath, Buffer.from(sfc, 'utf8'), [vueAdapter]);
  return symbols;
}

async function tsSymbols(src: string, filePath = 'src/plain.ts'): Promise<SymbolRecord[]> {
  const tree = await parseFile(Buffer.from(src, 'utf8'), typescriptHandler);
  return typescriptHandler.extractSymbols(tree, Buffer.from(src, 'utf8'), filePath);
}

// ─── Options API (export default { ... }) ────────────────────────────────────

describe('Options API extraction — .vue blocks', () => {
  const OPTIONS_SFC = `<template><div/></template>
<script>
export default {
  props: {
    title: { type: String, required: true },
    count: Number,
  },
  data() {
    return {
      items: [],
      loading: false,
    }
  },
  computed: {
    itemCount() { return this.items.length },
  },
  watch: {
    loading(val) { console.log(val) },
  },
  mounted() { this.fetchItems() },
  methods: {
    fetchItems() { return fetch('/api/items') },
    async saveItem(item) { await fetch('/api/items', { method: 'POST' }) },
  },
}
</script>`;

  it('emits method symbols for methods: entries, qualified by component name', async () => {
    const names = (await vueSymbols(OPTIONS_SFC)).map((s) => s.name);
    expect(names).toContain('UserCard.fetchItems');
    expect(names).toContain('UserCard.saveItem');
  });

  it('emits method symbols for computed/watch/lifecycle entries', async () => {
    const syms = await vueSymbols(OPTIONS_SFC);
    const byName = new Map(syms.map((s) => [s.name, s]));
    expect(byName.get('UserCard.itemCount')?.kind).toBe('method');
    expect(byName.get('UserCard.loading')?.kind).toBe('method');
    expect(byName.get('UserCard.mounted')?.kind).toBe('method');
  });

  it('emits property symbols for props keys and data() return keys', async () => {
    const syms = await vueSymbols(OPTIONS_SFC);
    const props = syms.filter((s) => s.kind === 'property').map((s) => s.name);
    expect(props).toContain('UserCard.title');
    expect(props).toContain('UserCard.count');
    expect(props).toContain('UserCard.items');
    expect(props).toContain('UserCard.loading');
  });

  it('symbols carry real spans (value node), not 0..length', async () => {
    const syms = await vueSymbols(OPTIONS_SFC);
    const m = syms.find((s) => s.name === 'UserCard.fetchItems')!;
    expect(m.startByte).toBeGreaterThan(0);
    expect(m.endByte).toBeGreaterThan(m.startByte);
    expect(m.signature).toContain('fetchItems');
  });

  it('defineComponent({ ... }) is extracted the same way', async () => {
    const sfc = `<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({
  methods: {
    reload() { location.reload() },
  },
})
</script>`;
    const names = (await vueSymbols(sfc, 'components/toolbar.vue')).map((s) => s.name);
    expect(names).toContain('Toolbar.reload');
  });

  it('an explicit name: entry overrides the filename-derived component name', async () => {
    const sfc = `<script>
export default {
  name: 'FancyWidget',
  methods: {
    spin() {},
  },
}
</script>`;
    const syms = await vueSymbols(sfc, 'components/widget.vue');
    const names = syms.map((s) => s.name);
    expect(names).toContain('FancyWidget.spin');
    // The adapter's component symbol also honours the Options-API name (V-12)
    expect(names).toContain('FancyWidget');
  });

  it('Vue.extend({ ... }) (Vue 2) is extracted too', async () => {
    const sfc = `<script>
import Vue from 'vue'
export default Vue.extend({
  methods: {
    legacyThing() {},
  },
})
</script>`;
    const names = (await vueSymbols(sfc, 'components/legacy.vue')).map((s) => s.name);
    expect(names).toContain('Legacy.legacyThing');
  });
});

// ─── R3 gate: plain TS/JS unchanged ──────────────────────────────────────────

describe('R3 gate — plain .ts files are unchanged', () => {
  it('a plain .ts export default config object sprouts NO symbols', async () => {
    const src = `export default {
  methods: {
    notAVueMethod() {},
  },
  props: { fake: String },
}
`;
    const syms = await tsSymbols(src, 'src/some.config.ts');
    expect(syms).toEqual([]);
  });

  it('a plain .ts defineComponent-free file is byte-identical to pre-93 output', async () => {
    const src = `export function realFn(): number { return 1 }
export const REAL_CONST = 2
`;
    const syms = await tsSymbols(src, 'src/util.ts');
    expect(syms.map((s) => `${s.kind}:${s.name}`)).toEqual(['function:realFn', 'const:REAL_CONST']);
  });
});

// ─── Pinia ───────────────────────────────────────────────────────────────────

describe('Pinia defineStore extraction (any JS/TS file)', () => {
  const STORE_TS = `import { defineStore } from 'pinia'
export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null }),
  getters: {
    isLoggedIn: (state) => state.user !== null,
  },
  actions: {
    async login(credentials) { this.user = await api.login(credentials) },
    logout() { this.user = null },
  },
})
`;

  it('emits method symbols for actions and getters, qualified by the store const', async () => {
    const syms = await tsSymbols(STORE_TS, 'stores/auth.ts');
    const byName = new Map(syms.map((s) => [s.name, s]));
    expect(byName.get('useAuthStore.login')?.kind).toBe('method');
    expect(byName.get('useAuthStore.logout')?.kind).toBe('method');
    expect(byName.get('useAuthStore.isLoggedIn')?.kind).toBe('method');
  });

  it('summaries carry the store id; the store const gets pinia_store_id meta', async () => {
    const syms = await tsSymbols(STORE_TS, 'stores/auth.ts');
    const action = syms.find((s) => s.name === 'useAuthStore.logout')!;
    expect(action.summary).toContain("'auth'");
    const storeConst = syms.find((s) => s.name === 'useAuthStore')!;
    expect(storeConst.frameworkMeta?.['pinia_store_id']).toBe('auth');
  });

  it('a setup-style store extracts its inner functions as actions (kurirfe class)', async () => {
    const src = `import { defineStore } from 'pinia'
export const useCartStore = defineStore('cart', () => {
  const items = ref([])
  const addQuickly = (i) => { items.value.push(i) }
  function addItem(i) { items.value.push(i) }
  return { items, addItem, addQuickly }
})
`;
    const syms = await tsSymbols(src, 'stores/cart.ts');
    const store = syms.find((s) => s.name === 'useCartStore')!;
    expect(store).toBeDefined();
    expect(store.frameworkMeta?.['pinia_store_id']).toBe('cart');
    const byName = new Map(syms.map((s) => [s.name, s]));
    expect(byName.get('useCartStore.addItem')?.kind).toBe('method');
    expect(byName.get('useCartStore.addQuickly')?.kind).toBe('method');
    expect(byName.get('useCartStore.items')?.kind).toBe('property');
  });

  it('member summaries never repeat the qualified name (rank-theft guard)', async () => {
    const syms = await tsSymbols(STORE_TS, 'stores/auth.ts');
    const action = syms.find((s) => s.name === 'useAuthStore.logout')!;
    expect(action.summary).not.toContain('useAuthStore');
    expect(action.summary).not.toContain('logout');
  });

  it('works in a .js file through the JavaScript handler (kurirfe class)', async () => {
    const src = `export const useUserStore = defineStore('user', {
  actions: {
    refreshProfile() {},
  },
})
`;
    const tree = await parseFile(Buffer.from(src, 'utf8'), javascriptHandler);
    const syms = javascriptHandler.extractSymbols(tree, Buffer.from(src, 'utf8'), 'store/user.js');
    expect(syms.map((s) => s.name)).toContain('useUserStore.refreshProfile');
  });
});

// ─── Script-setup macros ─────────────────────────────────────────────────────

describe('defineProps / defineEmits (script setup)', () => {
  it('runtime object form emits property symbols per prop', async () => {
    const sfc = `<script setup>
const props = defineProps({
  title: String,
  disabled: { type: Boolean, default: false },
})
</script>`;
    const syms = await vueSymbols(sfc, 'components/fancy-button.vue');
    const props = syms.filter((s) => s.kind === 'property').map((s) => s.name);
    expect(props).toContain('FancyButton.title');
    expect(props).toContain('FancyButton.disabled');
  });

  it('type-argument form emits property symbols per prop', async () => {
    const sfc = `<script setup lang="ts">
const props = defineProps<{ items: string[]; max?: number }>()
</script>`;
    const syms = await vueSymbols(sfc, 'components/item-list.vue');
    const props = syms.filter((s) => s.kind === 'property').map((s) => s.name);
    expect(props).toContain('ItemList.items');
    expect(props).toContain('ItemList.max');
  });

  it('defineEmits array + type forms emit property symbols per event', async () => {
    const runtime = `<script setup>
const emit = defineEmits(['save', 'cancel'])
</script>`;
    let syms = await vueSymbols(runtime, 'components/edit-form.vue');
    let names = syms.map((s) => s.name);
    expect(names).toContain('EditForm.save');
    expect(names).toContain('EditForm.cancel');

    const typed = `<script setup lang="ts">
const emit = defineEmits<{ (e: 'submit', id: number): void }>()
</script>`;
    syms = await vueSymbols(typed, 'components/edit-form.vue');
    names = syms.map((s) => s.name);
    expect(names).toContain('EditForm.submit');
  });

  it('bare defineProps expression statement (no const binding) still extracts', async () => {
    const sfc = `<script setup>
defineProps(['modelValue'])
</script>`;
    const syms = await vueSymbols(sfc, 'components/toggle.vue');
    expect(syms.map((s) => s.name)).toContain('Toggle.modelValue');
  });
});
