/**
 * Allow-list of C++ registration macros whose first argument is a symbol name.
 * Extend this table to add project-specific macro families without touching the handler.
 *
 * Pattern semantics:
 *   - string: exact macro name match
 *   - RegExp: regex tested against the macro name
 *
 * argKind: 'identifier' → first argument is an identifier (e.g. FunctionAbs)
 *          'string'     → first argument is a string literal (e.g. "Abs")
 *          'any'        → try identifier first, then string literal
 */

export interface MacroRegistryEntry {
  pattern: string | RegExp;
  argKind: 'identifier' | 'string' | 'any';
  symbolKind: 'function' | 'class' | 'type';
}

export const MACRO_REGISTRY: MacroRegistryEntry[] = [
  // ── ClickHouse ───────────────────────────────────────────────────────────────
  { pattern: 'FUNCTION_REGISTER',              argKind: 'identifier', symbolKind: 'function' },
  { pattern: 'FUNCTION_FORWARD_DECLARE',       argKind: 'identifier', symbolKind: 'function' },
  { pattern: 'DECLARE_AGGREGATE_FUNCTION',     argKind: 'identifier', symbolKind: 'function' },
  { pattern: /^REGISTER_FUNCTION$/,            argKind: 'identifier', symbolKind: 'function' },
  { pattern: /^REGISTER_AGGREGATE_FUNCTION$/,  argKind: 'identifier', symbolKind: 'function' },

  // ── Folly ────────────────────────────────────────────────────────────────────
  { pattern: 'FOLLY_DEFINE_KERNEL',   argKind: 'identifier', symbolKind: 'class'    },
  { pattern: 'DEFINE_FOLLY_FUTURE',   argKind: 'identifier', symbolKind: 'type'     },
  { pattern: 'FOLLY_CLASS_INIT',      argKind: 'identifier', symbolKind: 'class'    },
  { pattern: 'FOLLY_DECLARE_REUSED',  argKind: 'identifier', symbolKind: 'function' },

  // ── TensorFlow ───────────────────────────────────────────────────────────────
  { pattern: 'REGISTER_OP',             argKind: 'string',     symbolKind: 'function' },
  { pattern: /^REGISTER_KERNEL_BUILDER$/, argKind: 'any',      symbolKind: 'function' },
  { pattern: /^TF_CALL_ALL_TYPES$/,     argKind: 'identifier', symbolKind: 'function' },
];

/** Returns the matching registry entry for a macro name, or null if not in the allow-list. */
export function findMacroEntry(macroName: string): MacroRegistryEntry | null {
  for (const entry of MACRO_REGISTRY) {
    if (typeof entry.pattern === 'string') {
      if (entry.pattern === macroName) return entry;
    } else {
      if (entry.pattern.test(macroName)) return entry;
    }
  }
  return null;
}
