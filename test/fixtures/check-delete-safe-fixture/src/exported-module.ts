/**
 * Fixture for filePath mode tests.
 * Three exported symbols with no internal references — used to verify that
 * check_delete_safe in filePath mode checks all symbols in the file.
 */

export function alpha(): void {}

export function beta(): string {
  return 'beta';
}

export function gamma(n: number): number {
  return n * 2;
}
