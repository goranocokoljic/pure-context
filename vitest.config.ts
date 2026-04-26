import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixtures/**', 'test/e2e/**'],
    // Run test files sequentially to avoid Windows file-lock conflicts
    // when multiple suites write to the same ~/.purecontext/indexes/ DB file.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
