/**
 * Helpers for get_test_coverage_map fixture.
 */

/** Formats a date as YYYY-MM-DD. Covered. */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Slugifies text. NOT covered. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
}
