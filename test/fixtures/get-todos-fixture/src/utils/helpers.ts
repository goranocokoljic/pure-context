// OPTIMIZE: this function is called in a tight loop
export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

/* BUG: does not handle unicode characters */
export function truncate(text: string, maxLength: number): string {
  return text.slice(0, maxLength);
}

// XXX: remove this before production
export const DEBUG_MODE = true;

export function formatDate(date: Date): string {
  // NOTE: using ISO format for consistency
  return date.toISOString();
}
