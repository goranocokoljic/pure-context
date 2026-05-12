/**
 * helpers.ts — general-purpose string and date utilities.
 */

/**
 * Format a JavaScript Date into a human-readable date string (YYYY-MM-DD).
 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a string to a URL-friendly slug.
 * Lowercases, removes non-alphanumeric characters, collapses hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Truncate a string to the given maximum length, appending an ellipsis when
 * the text exceeds the limit.
 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
