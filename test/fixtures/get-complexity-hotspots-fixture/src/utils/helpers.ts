/**
 * helpers.ts — medium complexity utility functions.
 */

// Medium complexity (CC ≈ 5)
export function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

// Low complexity (CC ≈ 3)
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Medium complexity (CC ≈ 4)
export function parseQueryString(qs: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!qs || qs === '?') return result;
  const cleaned = qs.startsWith('?') ? qs.slice(1) : qs;
  for (const pair of cleaned.split('&')) {
    const [key, val] = pair.split('=');
    if (key) result[decodeURIComponent(key)] = decodeURIComponent(val ?? '');
  }
  return result;
}
