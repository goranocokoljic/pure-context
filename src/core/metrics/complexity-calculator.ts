/**
 * complexity-calculator.ts
 *
 * Token-based code quality metrics for individual symbol source snippets.
 * Operates on raw source text — no tree-sitter traversal required for the
 * basic metrics (cyclomatic, return count, line count, param count, nesting).
 * Cognitive complexity uses a brace-tracking nesting heuristic.
 *
 * All calculations are language-agnostic heuristics and intentionally fast:
 * they run inline during the indexing pipeline (zero extra I/O, no async).
 */

import type { ComplexityMetrics } from '../types.js';
import type { SymbolKind } from '../types.js';

// Symbol kinds where complexity is meaningful to calculate.
// Excluded: const, type, interface, enum — they have no logic branches.
const MEASURABLE_KINDS = new Set<SymbolKind>([
  'function',
  'method',
  'class',
  'composable',
  'hook',
  'middleware',
  'decorator',
  'component',
  'route',
]);

export function shouldCalculateMetrics(kind: SymbolKind): boolean {
  return MEASURABLE_KINDS.has(kind);
}

/**
 * Calculate complexity metrics from a source snippet.
 * `source` should be the raw UTF-8 text of the symbol (no external context).
 */
export function calculateComplexity(source: string): ComplexityMetrics {
  const lineCount = countLines(source);
  const cleaned = stripCommentsAndStrings(source);

  return {
    lineCount,
    cyclomaticComplexity: calcCyclomatic(cleaned),
    cognitiveComplexity: calcCognitive(cleaned),
    paramCount: calcParamCount(cleaned),
    returnCount: calcReturnCount(cleaned),
    nestingDepth: calcNestingDepth(cleaned),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countLines(source: string): number {
  // +1 because splitting "a\nb" yields 2 elements for 2 lines
  return source.split('\n').length;
}

/**
 * Strip string literals and line/block comments to avoid false positives
 * when scanning for decision keywords and operators.
 *
 * We replace matched regions with whitespace of the same length so that
 * character offsets (used for brace counting) remain valid.
 */
function stripCommentsAndStrings(source: string): string {
  let result = '';
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // Line comment //
    if (ch === '/' && source[i + 1] === '/') {
      // Consume to end of line
      while (i < len && source[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && source[i + 1] === '*') {
      result += '  '; // consume '/*'
      i += 2;
      while (i < len) {
        if (source[i] === '*' && source[i + 1] === '/') {
          result += '  ';
          i += 2;
          break;
        }
        result += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Hash comment (Python, Ruby, Bash, etc.)
    if (ch === '#') {
      while (i < len && source[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      result += '"';
      i++;
      while (i < len) {
        const sc = source[i];
        if (sc === '\\') {
          result += '  ';
          i += 2;
          continue;
        }
        if (sc === '"') {
          result += '"';
          i++;
          break;
        }
        result += sc === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      result += "'";
      i++;
      while (i < len) {
        const sc = source[i];
        if (sc === '\\') {
          result += '  ';
          i += 2;
          continue;
        }
        if (sc === "'") {
          result += "'";
          i++;
          break;
        }
        result += sc === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Template literal / backtick string
    if (ch === '`') {
      result += '`';
      i++;
      while (i < len) {
        const sc = source[i];
        if (sc === '\\') {
          result += '  ';
          i += 2;
          continue;
        }
        if (sc === '`') {
          result += '`';
          i++;
          break;
        }
        // Skip over ${...} interpolations by just passing chars through —
        // they contain code we want to analyse, so we keep them as-is
        result += sc;
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ─── Cyclomatic complexity ────────────────────────────────────────────────────

// Decision-point keywords and operators.
// We use word-boundary checks for keywords to avoid matching substrings.
const CYCLOMATIC_KEYWORD_RE =
  /\b(if|else\s+if|elif|for|while|do\s+{|case|catch|rescue|except|unless|until)\b/g;
const CYCLOMATIC_OPERATOR_RE = /&&|\|\||\?\s*[^:]/g;

function calcCyclomatic(cleaned: string): number {
  // Start at 1 (the function body itself is one path)
  let count = 1;

  CYCLOMATIC_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CYCLOMATIC_KEYWORD_RE.exec(cleaned)) !== null) {
    count++;
    // Prevent infinite loops on zero-width matches
    if (m[0].length === 0) CYCLOMATIC_KEYWORD_RE.lastIndex++;
  }

  CYCLOMATIC_OPERATOR_RE.lastIndex = 0;
  while ((m = CYCLOMATIC_OPERATOR_RE.exec(cleaned)) !== null) {
    count++;
    if (m[0].length === 0) CYCLOMATIC_OPERATOR_RE.lastIndex++;
  }

  return count;
}

// ─── Cognitive complexity ─────────────────────────────────────────────────────

/**
 * Simplified SonarSource cognitive complexity:
 * - Structural keywords increment (1 + current nesting level) and increase nesting.
 * - `else`, `catch`, `finally` increment by 1 (no nesting increase).
 * - Boolean operators `&&` and `||` each increment by 1 (flat).
 * - Nesting is tracked by matching `{` / `}` pairs.
 *
 * This is a heuristic — perfect SonarSource compliance requires an AST
 * (especially for implicit-block languages and arrow functions).
 */
function calcCognitive(cleaned: string): number {
  let complexity = 0;
  let nesting = 0;
  let i = 0;
  const len = cleaned.length;

  const tryMatch = (keyword: string): boolean => {
    if (cleaned.startsWith(keyword, i)) {
      // Ensure it's a whole token (not a substring)
      const after = cleaned[i + keyword.length];
      if (after === undefined || !/\w/.test(after)) {
        return true;
      }
    }
    return false;
  };

  while (i < len) {
    const ch = cleaned[i];

    // Structural keywords that add nesting
    if (/[a-z]/.test(ch)) {
      if (
        tryMatch('if') ||
        tryMatch('elif') ||
        tryMatch('for') ||
        tryMatch('while') ||
        tryMatch('switch') ||
        tryMatch('do') ||
        tryMatch('rescue') ||
        tryMatch('except') ||
        tryMatch('unless') ||
        tryMatch('until')
      ) {
        complexity += 1 + nesting;
        nesting++;
        // Skip past the keyword
        while (i < len && /\w/.test(cleaned[i])) i++;
        continue;
      }
      // Flat increment keywords (no nesting change)
      if (tryMatch('else') || tryMatch('catch') || tryMatch('finally')) {
        complexity += 1;
        while (i < len && /\w/.test(cleaned[i])) i++;
        continue;
      }
    }

    // Boolean operators — flat +1 each
    if (ch === '&' && cleaned[i + 1] === '&') {
      complexity++;
      i += 2;
      continue;
    }
    if (ch === '|' && cleaned[i + 1] === '|') {
      complexity++;
      i += 2;
      continue;
    }

    // Track nesting via braces
    if (ch === '{') {
      // Don't increase nesting here — it's controlled by keywords above.
      // However, bare `{` (object literals, etc.) should not affect it.
      i++;
      continue;
    }
    if (ch === '}') {
      if (nesting > 0) nesting--;
      i++;
      continue;
    }

    i++;
  }

  return complexity;
}

// ─── Param count ──────────────────────────────────────────────────────────────

function calcParamCount(cleaned: string): number {
  // Find the first balanced parameter list ( ... )
  const start = cleaned.indexOf('(');
  if (start === -1) return 0;

  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '(') depth++;
    else if (cleaned[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return 0;

  const paramList = cleaned.slice(start + 1, end).trim();
  if (!paramList) return 0;

  // Count top-level commas (not inside nested parens/brackets/braces)
  let commas = 0;
  let nest = 0;
  for (const c of paramList) {
    if (c === '(' || c === '[' || c === '{') nest++;
    else if (c === ')' || c === ']' || c === '}') nest--;
    else if (c === ',' && nest === 0) commas++;
  }
  return commas + 1;
}

// ─── Return count ─────────────────────────────────────────────────────────────

const RETURN_RE = /\breturn\b/g;

function calcReturnCount(cleaned: string): number {
  RETURN_RE.lastIndex = 0;
  let count = 0;
  while (RETURN_RE.exec(cleaned) !== null) count++;
  return count;
}

// ─── Nesting depth ────────────────────────────────────────────────────────────

function calcNestingDepth(cleaned: string): number {
  let current = 0;
  let max = 0;
  for (const ch of cleaned) {
    if (ch === '{') {
      current++;
      if (current > max) max = current;
    } else if (ch === '}') {
      if (current > 0) current--;
    }
  }
  return max;
}
