/** Recursive function — calls itself, creating a cycle */
export function recursiveFunc(n: number): number {
  if (n <= 0) return 0;
  return recursiveFunc(n - 1);
}
