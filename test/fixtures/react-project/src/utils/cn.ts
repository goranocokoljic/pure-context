/**
 * Combine class names, filtering out falsy values.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Format a date value to a locale string.
 */
export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US');
}
