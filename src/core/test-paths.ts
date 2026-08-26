/**
 * Shared test-file path classification (Task 549).
 *
 * Before this module the codebase carried FIVE private near-copies of
 * `isTestFile` (test-mapper, change-synthesis, check-delete-safe,
 * find-untested-symbols, symbol-risk) — and the resolvers had none at all,
 * which let production files grow dependency edges into test source sets
 * (28.6% of edges on the report's Android corpus). One predicate, one place.
 *
 * Union of the conventions the five copies covered, plus the JVM/Gradle and
 * .NET source-set layouts the 1.18.0 report demanded:
 *  - directory segments: test, tests, spec, specs, __tests__,
 *    androidTest, testFixtures (case-insensitive)
 *  - .NET sibling test projects: any directory segment ending in
 *    `.test`/`.tests` (Foo.Tests/, Bar.Test/)
 *  - filename suffixes: `.test.<ext>` / `.spec.<ext>` / `_test.<ext>`
 *    / `_spec.<ext>` (covers x.test.ts, x.spec.js, x_test.go)
 *  - filename prefixes: `test_` / `spec_` (Python convention)
 */

const TEST_DIR_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'androidtest',
  'testfixtures',
]);

/** True when the path is a test file / lives in a test source set. */
export function isTestFilePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');

  // Filename suffix: .test.ts, .spec.tsx, _test.go, _spec.rb, …
  if (/[._](?:test|spec)\.[a-z]+$/i.test(norm)) return true;

  const segments = norm.split('/');
  const filename = segments[segments.length - 1] ?? '';

  // Python convention: test_foo.py / spec_foo.py
  if (/^(?:test|spec)_/.test(filename)) return true;

  // Directory segments (everything except the filename itself).
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = (segments[i] ?? '').toLowerCase();
    if (TEST_DIR_SEGMENTS.has(seg)) return true;
    // .NET sibling test-project convention: Foo.Tests/, Bar.Test/
    if (seg.endsWith('.tests') || seg.endsWith('.test')) return true;
  }

  return false;
}
