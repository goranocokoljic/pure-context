/**
 * Vue Options-API / script-setup macro / Pinia store extraction (Phase 93,
 * Task 581 — V-4/V-5).
 *
 * Shared by the TypeScript AND JavaScript handlers: `.vue` <script> blocks
 * route to either handler depending on `lang`, and JS Vue apps (kurirfe,
 * origamicms-frontend) previously extracted ZERO symbols from Options-API
 * bodies (`export default { methods: {...} }`), `defineComponent({...})`
 * calls, and Pinia `defineStore` option stores.
 *
 * Gating (R3): the Options-API default-export case fires ONLY for symbols
 * whose filePath ends in `.vue` (the preprocessor passes the original .vue
 * path to the handler) — a plain `.ts`/`.js` `export default {...}` config
 * object must never sprout symbols. Pinia extraction fires in ANY JS/TS file:
 * `defineStore(...)` is unambiguous and stores live in plain stores/*.ts.
 *
 * All spans are tree-sitter node indices (UTF-16 char space) exactly like the
 * host handlers emit — the pipeline converts to true bytes once (Phase 90).
 */

import { createHash } from 'crypto';
import { basename } from 'path';
import type { SymbolRecord, SymbolKind, SyntaxNode } from '../core/types.js';

// ─── Naming (shared with the Vue adapter) ─────────────────────────────────────

/**
 * Convert kebab-case or camelCase filename stems to PascalCase.
 * 'my-component' → 'MyComponent'; 'userCard' → 'UserCard'
 */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Directory names that are generic containers, not component identities — an
 * `index.vue` directly under one of these keeps the name `Index` instead of
 * inheriting a meaningless parent name like `Pages`.
 */
const GENERIC_PARENT_DIRS = new Set(['pages', 'components', 'layouts', 'views', 'src', 'app']);

/**
 * Derive a component name from a .vue file path: PascalCase stem, Nuxt mode
 * suffixes stripped, `index.vue` named after its parent directory (V-9).
 */
export function componentNameFromVuePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  let stem = basename(normalized, '.vue');
  stem = stem.replace(/\.(client|server)$/, '');
  if (stem.toLowerCase() === 'index') {
    const parts = normalized.split('/');
    const parent = parts.length >= 2 ? parts[parts.length - 2]! : '';
    if (parent && !GENERIC_PARENT_DIRS.has(parent.toLowerCase())) {
      stem = parent;
    }
  }
  return toPascalCase(stem);
}

// ─── Internals ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

const FUNCTION_NODE_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

const VUE_LIFECYCLE_HOOKS = new Set([
  'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
  'beforeUnmount', 'unmounted', 'beforeDestroy', 'destroyed', 'activated',
  'deactivated', 'errorCaptured', 'serverPrefetch', 'setup', 'render',
]);

interface ObjectEntry {
  /** Bare key name (quotes stripped). */
  name: string;
  /** The pair / method_definition node (used for spans + signatures). */
  node: SyntaxNode;
  /** The value node for pairs, the method_definition itself for methods. */
  value: SyntaxNode | null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

/** Enumerate the named entries of an object-literal node. */
function objectEntries(obj: SyntaxNode, sourceStr: string): ObjectEntry[] {
  const entries: ObjectEntry[] = [];
  for (const child of obj.children) {
    if (child.type === 'pair') {
      const key = child.children[0];
      if (!key) continue;
      if (key.type !== 'property_identifier' && key.type !== 'string') continue;
      const name = stripQuotes(sourceStr.slice(key.startIndex, key.endIndex));
      const value = child.children[child.children.length - 1] ?? null;
      entries.push({ name, node: child, value });
    } else if (child.type === 'method_definition') {
      const nameNode = child.children.find(
        (c) => c.type === 'property_identifier' || c.type === 'string',
      );
      if (!nameNode) continue;
      const name = stripQuotes(sourceStr.slice(nameNode.startIndex, nameNode.endIndex));
      entries.push({ name, node: child, value: child });
    }
  }
  return entries;
}

/** One-line signature: the entry node's text up to its statement body. */
function entrySignature(node: SyntaxNode, sourceStr: string): string {
  let end = node.endIndex;
  const body = findDescendantShallow(node, 'statement_block');
  if (body) end = body.startIndex;
  return sourceStr.slice(node.startIndex, end).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Breadth-limited search for the first node of a type (2 levels deep). */
function findDescendantShallow(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const c of node.children) {
    if (c.type === type) return c;
    for (const cc of c.children) {
      if (cc.type === type) return cc;
    }
  }
  return null;
}

/** Collect all descendants of a type (bounded depth-first walk). */
function collectDescendants(node: SyntaxNode, type: string, out: SyntaxNode[], depth = 0): void {
  if (depth > 12) return;
  for (const c of node.children) {
    if (c.type === type) out.push(c);
    collectDescendants(c, type, out, depth + 1);
  }
}

function isFunctionValued(entry: ObjectEntry): boolean {
  if (entry.node.type === 'method_definition') return true;
  return !!entry.value && FUNCTION_NODE_TYPES.has(entry.value.type);
}

function pushSymbol(
  symbols: SymbolRecord[],
  filePath: string,
  name: string,
  kind: SymbolKind,
  node: SyntaxNode,
  sourceStr: string,
  summary: string,
  frameworkMeta?: Record<string, unknown>,
): void {
  symbols.push({
    id: makeId(filePath, name, kind),
    name,
    kind,
    filePath,
    startByte: node.startIndex,
    endByte: node.endIndex,
    signature: entrySignature(node, sourceStr),
    summary,
    ...(frameworkMeta ? { frameworkMeta } : {}),
  });
}

// ─── Options-API default export ───────────────────────────────────────────────

/**
 * Given the node of a `export default …` expression, return the options
 * object literal when the export is an Options-API component:
 *   export default { ... }
 *   export default defineComponent({ ... })
 *   export default defineNuxtComponent({ ... })
 *   export default Vue.extend({ ... })        (Vue 2)
 * Returns null otherwise.
 */
export function resolveOptionsObject(exprNode: SyntaxNode, sourceStr: string): SyntaxNode | null {
  if (exprNode.type === 'object') return exprNode;
  if (exprNode.type === 'call_expression') {
    const callee = exprNode.children[0];
    if (!callee) return null;
    const calleeText = sourceStr.slice(callee.startIndex, callee.endIndex);
    if (
      calleeText !== 'defineComponent' &&
      calleeText !== 'defineNuxtComponent' &&
      calleeText !== 'Vue.extend'
    ) {
      return null;
    }
    const args = exprNode.children.find((c) => c.type === 'arguments');
    const obj = args?.children.find((c) => c.type === 'object');
    return obj ?? null;
  }
  return null;
}

/** Read an explicit `name: 'X'` string entry from the options object. */
function explicitComponentName(entries: ObjectEntry[], sourceStr: string): string | null {
  const nameEntry = entries.find((e) => e.name === 'name');
  if (nameEntry?.value && nameEntry.value.type === 'string') {
    const n = stripQuotes(sourceStr.slice(nameEntry.value.startIndex, nameEntry.value.endIndex));
    if (n) return n;
  }
  return null;
}

/**
 * Extract method/computed/watch/lifecycle/props/data symbols from an
 * Options-API options object. `componentName` qualifies every symbol
 * (`ComponentName.methodName`).
 */
export function extractVueOptionsSymbols(
  optionsObj: SyntaxNode,
  sourceStr: string,
  filePath: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const entries = objectEntries(optionsObj, sourceStr);
  const componentName =
    explicitComponentName(entries, sourceStr) ?? componentNameFromVuePath(filePath);

  // Summaries are LABEL-ONLY — they must not repeat the qualified name. A
  // summary like "Vue method AiTagRecommender.suggestions" made every name
  // word count twice (name + summary match) and the members displaced their
  // own parent component at rank 1 (measured on origamicms-frontend, P@1
  // 28→12 before this correction). Class methods have empty summaries and
  // never had this problem.
  for (const entry of entries) {
    switch (entry.name) {
      case 'methods':
      case 'computed':
      case 'watch': {
        if (!entry.value || entry.value.type !== 'object') break;
        const label =
          entry.name === 'methods' ? 'Vue Options API method'
          : entry.name === 'computed' ? 'Vue computed property'
          : 'Vue watcher';
        for (const member of objectEntries(entry.value, sourceStr)) {
          const qualified = `${componentName}.${member.name}`;
          pushSymbol(
            symbols, filePath, qualified, 'method', member.node, sourceStr,
            label, { vue_options: entry.name },
          );
        }
        break;
      }

      case 'props': {
        if (!entry.value) break;
        if (entry.value.type === 'object') {
          for (const member of objectEntries(entry.value, sourceStr)) {
            const qualified = `${componentName}.${member.name}`;
            pushSymbol(
              symbols, filePath, qualified, 'property', member.node, sourceStr,
              'Vue prop', { vue_options: 'props' },
            );
          }
        } else if (entry.value.type === 'array') {
          for (const el of entry.value.children) {
            if (el.type !== 'string') continue;
            const propName = stripQuotes(sourceStr.slice(el.startIndex, el.endIndex));
            if (!propName) continue;
            const qualified = `${componentName}.${propName}`;
            pushSymbol(
              symbols, filePath, qualified, 'property', el, sourceStr,
              'Vue prop', { vue_options: 'props' },
            );
          }
        }
        break;
      }

      case 'data': {
        // data() { return { count: 0, ... } } — emit a property per return key
        if (!isFunctionValued(entry)) break;
        const fnNode = entry.node.type === 'method_definition' ? entry.node : entry.value!;
        const body = findDescendantShallow(fnNode, 'statement_block')
          ?? fnNode.children.find((c) => c.type === 'statement_block') ?? null;
        if (!body) break;
        const ret = body.children.find((c) => c.type === 'return_statement');
        if (!ret) break;
        let retVal = ret.children.find((c) => c.type === 'object' || c.type === 'parenthesized_expression');
        if (retVal?.type === 'parenthesized_expression') {
          retVal = retVal.children.find((c) => c.type === 'object');
        }
        if (!retVal || retVal.type !== 'object') break;
        for (const member of objectEntries(retVal, sourceStr)) {
          const qualified = `${componentName}.${member.name}`;
          pushSymbol(
            symbols, filePath, qualified, 'property', member.node, sourceStr,
            'Vue data property', { vue_options: 'data' },
          );
        }
        break;
      }

      default: {
        // Lifecycle hooks + setup/render as direct function-valued entries
        if (VUE_LIFECYCLE_HOOKS.has(entry.name) && isFunctionValued(entry)) {
          const qualified = `${componentName}.${entry.name}`;
          pushSymbol(
            symbols, filePath, qualified, 'method', entry.node, sourceStr,
            'Vue lifecycle hook', { vue_options: 'lifecycle' },
          );
        }
        break;
      }
    }
  }

  return symbols;
}

// ─── Pinia defineStore ────────────────────────────────────────────────────────

export interface PiniaExtraction {
  storeId: string | null;
  symbols: SymbolRecord[];
}

/**
 * Given the call_expression node of `defineStore('id', {...})`, extract
 * `method` symbols for `actions:` / `getters:` entries, qualified by the
 * store const name (`useAuthStore.logout`). Setup-style stores (function
 * second arg) yield no extra symbols here. Returns the store id string so the
 * caller can stamp `frameworkMeta.pinia_store_id` on the store const symbol
 * (FTS token — serviceName precedent).
 */
export function extractPiniaStoreSymbols(
  callNode: SyntaxNode,
  storeConstName: string,
  sourceStr: string,
  filePath: string,
): PiniaExtraction {
  const callee = callNode.children[0];
  if (!callee || sourceStr.slice(callee.startIndex, callee.endIndex) !== 'defineStore') {
    return { storeId: null, symbols: [] };
  }
  const args = callNode.children.find((c) => c.type === 'arguments');
  if (!args) return { storeId: null, symbols: [] };

  const argNodes = args.children.filter((c) => c.type !== '(' && c.type !== ')' && c.type !== ',');
  const idNode = argNodes.find((c) => c.type === 'string');
  const storeId = idNode ? stripQuotes(sourceStr.slice(idNode.startIndex, idNode.endIndex)) : null;

  const symbols: SymbolRecord[] = [];
  const storeMeta = (entryKind: string): Record<string, unknown> => ({
    pinia_entry: entryKind,
    ...(storeId ? { pinia_store_id: storeId } : {}),
  });
  // Summaries are label + store id only — never the qualified name (see the
  // Options-API note above; the store id is legitimate query vocabulary:
  // "auth store logout").
  const storeSuffix = storeId ? ` (store '${storeId}')` : '';

  const optionsObj = argNodes.find((c) => c.type === 'object');
  if (optionsObj) {
    for (const entry of objectEntries(optionsObj, sourceStr)) {
      if (entry.name !== 'actions' && entry.name !== 'getters') continue;
      if (!entry.value || entry.value.type !== 'object') continue;
      const label = entry.name === 'actions' ? 'Pinia action' : 'Pinia getter';
      for (const member of objectEntries(entry.value, sourceStr)) {
        const qualified = `${storeConstName}.${member.name}`;
        pushSymbol(
          symbols, filePath, qualified, 'method', member.node, sourceStr,
          `${label}${storeSuffix}`, storeMeta(entry.name),
        );
      }
    }
  }

  // Setup-style store: defineStore('id', () => { ... }) — the composition
  // body's top-level functions are the store's actions and its consts its
  // state/getters. They are NOT top-level tree nodes, so the normal
  // declaration pass never sees them (kurirfe: every store is setup-style and
  // every store action ranked None before this).
  const setupFn = argNodes.find((c) => FUNCTION_NODE_TYPES.has(c.type));
  const setupBody = setupFn?.children.find((c) => c.type === 'statement_block');
  if (setupBody) {
    for (const stmt of setupBody.children) {
      if (stmt.type === 'function_declaration') {
        const nameNode = stmt.children.find((c) => c.type === 'identifier');
        if (!nameNode) continue;
        const memberName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
        pushSymbol(
          symbols, filePath, `${storeConstName}.${memberName}`, 'method', stmt, sourceStr,
          `Pinia action${storeSuffix}`, storeMeta('actions'),
        );
      } else if (stmt.type === 'lexical_declaration') {
        for (const child of stmt.children) {
          if (child.type !== 'variable_declarator') continue;
          const nameNode = child.children.find((c) => c.type === 'identifier');
          if (!nameNode) continue;
          const memberName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
          const isFn = child.children.some((c) => FUNCTION_NODE_TYPES.has(c.type));
          pushSymbol(
            symbols, filePath, `${storeConstName}.${memberName}`,
            isFn ? 'method' : 'property', child, sourceStr,
            isFn ? `Pinia action${storeSuffix}` : `Pinia state${storeSuffix}`,
            storeMeta(isFn ? 'actions' : 'state'),
          );
        }
      }
    }
  }

  return { storeId, symbols };
}

// ─── Script-setup macros: defineProps / defineEmits ──────────────────────────

/**
 * Extract `property` symbols from a `defineProps(...)` / `defineEmits(...)`
 * call in a script-setup block. Handles the runtime forms (object literal /
 * string array) and the type-argument form (`defineProps<{ title: string }>()`
 * via property_signature members; emit names via string literal types).
 * `withDefaults(defineProps<...>(), {...})` unwraps to the inner call.
 */
export function extractSetupMacroSymbols(
  callNode: SyntaxNode,
  sourceStr: string,
  filePath: string,
): SymbolRecord[] {
  const callee = callNode.children[0];
  if (!callee) return [];
  const calleeText = sourceStr.slice(callee.startIndex, callee.endIndex);

  if (calleeText === 'withDefaults') {
    const args = callNode.children.find((c) => c.type === 'arguments');
    const inner = args?.children.find((c) => c.type === 'call_expression');
    return inner ? extractSetupMacroSymbols(inner, sourceStr, filePath) : [];
  }

  if (calleeText !== 'defineProps' && calleeText !== 'defineEmits') return [];
  const isProps = calleeText === 'defineProps';
  const componentName = componentNameFromVuePath(filePath);
  const label = isProps ? 'Vue prop' : 'Vue emit';
  const metaKey = isProps ? 'define_props' : 'define_emits';
  const symbols: SymbolRecord[] = [];

  const seen = new Set<string>();
  const emit = (name: string, node: SyntaxNode): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const qualified = `${componentName}.${name}`;
    // Label-only summary — never the qualified name (see Options-API note).
    pushSymbol(
      symbols, filePath, qualified, 'property', node, sourceStr,
      label, { vue_options: metaKey },
    );
  };

  // Runtime forms
  const args = callNode.children.find((c) => c.type === 'arguments');
  const objArg = args?.children.find((c) => c.type === 'object');
  if (objArg) {
    for (const member of objectEntries(objArg, sourceStr)) emit(member.name, member.node);
  }
  const arrArg = args?.children.find((c) => c.type === 'array');
  if (arrArg) {
    for (const el of arrArg.children) {
      if (el.type === 'string') emit(stripQuotes(sourceStr.slice(el.startIndex, el.endIndex)), el);
    }
  }

  // Type-argument form
  const typeArgs = callNode.children.find((c) => c.type === 'type_arguments');
  if (typeArgs) {
    if (isProps) {
      const sigs: SyntaxNode[] = [];
      collectDescendants(typeArgs, 'property_signature', sigs);
      for (const sig of sigs) {
        const nameNode = sig.children.find((c) => c.type === 'property_identifier');
        if (nameNode) emit(sourceStr.slice(nameNode.startIndex, nameNode.endIndex), sig);
      }
    } else {
      // defineEmits<{(e: 'save'): void}> / defineEmits<{'save': [id: number]}>
      // — every string literal inside the type is an emit name.
      const literals: SyntaxNode[] = [];
      collectDescendants(typeArgs, 'literal_type', literals);
      for (const lit of literals) {
        const s = lit.children.find((c) => c.type === 'string');
        if (s) emit(stripQuotes(sourceStr.slice(s.startIndex, s.endIndex)), lit);
      }
      if (literals.length === 0) {
        const sigs: SyntaxNode[] = [];
        collectDescendants(typeArgs, 'property_signature', sigs);
        for (const sig of sigs) {
          const nameNode = sig.children.find(
            (c) => c.type === 'property_identifier' || c.type === 'string',
          );
          if (nameNode) emit(stripQuotes(sourceStr.slice(nameNode.startIndex, nameNode.endIndex)), sig);
        }
      }
    }
  }

  return symbols;
}

// ─── Handler integration helper ───────────────────────────────────────────────

/**
 * One-call integration point for the TS/JS handlers, run per top-level node.
 * Returns extra symbols for:
 *   - `export default <options>` in .vue-derived blocks (Options API)
 *   - bare `defineProps(...)` / `defineEmits(...)` expression statements and
 *     `const props = defineProps(...)` declarators in .vue-derived blocks
 *   - `const useX = defineStore(...)` in ANY file (Pinia; also stamps
 *     pinia_store_id onto the already-pushed store const symbol)
 */
export function extractVueExtras(
  node: SyntaxNode,
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  const isVueBlock = filePath.endsWith('.vue');

  // export default <options object / defineComponent(...)>
  if (isVueBlock && node.type === 'export_statement') {
    for (const child of node.children) {
      if (child.type === 'object' || child.type === 'call_expression') {
        const optionsObj = resolveOptionsObject(child, sourceStr);
        if (optionsObj) symbols.push(...extractVueOptionsSymbols(optionsObj, sourceStr, filePath));
        break;
      }
    }
  }

  // Bare defineProps(...) / defineEmits(...) expression statement
  if (isVueBlock && node.type === 'expression_statement') {
    const call = node.children.find((c) => c.type === 'call_expression');
    if (call) symbols.push(...extractSetupMacroSymbols(call, sourceStr, filePath));
  }

  // Declarator-bound forms: const props = defineProps(...) | const useX = defineStore(...)
  const decl = node.type === 'export_statement'
    ? node.children.find((c) => c.type === 'lexical_declaration')
    : node.type === 'lexical_declaration' ? node : null;
  if (decl) {
    for (const child of decl.children) {
      if (child.type !== 'variable_declarator') continue;
      const nameNode = child.children.find((c) => c.type === 'identifier');
      const call = child.children.find((c) => c.type === 'call_expression');
      if (!nameNode || !call) continue;
      const constName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);

      if (isVueBlock) {
        symbols.push(...extractSetupMacroSymbols(call, sourceStr, filePath));
      }

      const pinia = extractPiniaStoreSymbols(call, constName, sourceStr, filePath);
      if (pinia.storeId !== null || pinia.symbols.length > 0) {
        symbols.push(...pinia.symbols);
        // Stamp the store id onto the already-extracted store const symbol so
        // buildFtsContent indexes it (serviceName precedent).
        if (pinia.storeId) {
          const constSym = symbols.find(
            (s) => s.name === constName && (s.kind === 'const' || s.kind === 'function'),
          );
          if (constSym) {
            constSym.frameworkMeta = { ...constSym.frameworkMeta, pinia_store_id: pinia.storeId };
          }
        }
      }
    }
  }
}
