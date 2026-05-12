/**
 * Fixture file for check_delete_safe tests.
 *
 * deleteMe       — exported, called in caller1 + caller2 (2 live references)
 * orphan         — not exported, no references anywhere → safe to delete
 * exportedNoRefs — exported, no internal references → external risk
 * testSubject    — exported, referenced only in test/utils.test.ts
 */

export function deleteMe(): void {
  // called by caller1 and caller2
}

function orphan(): void {
  // private, unreferenced — safe to delete
}

export function exportedNoRefs(): string {
  // exported but never called internally
  return 'exported';
}

export function testSubject(): boolean {
  // only referenced in test files
  return true;
}

// Suppress unused-variable warning for orphan
void orphan;
