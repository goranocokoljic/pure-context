/**
 * Phase 101 (Task 630): import-record shapes the symbol-edge builder relies on.
 *  - TS/JS `export … from` statements are recorded (barrel edges + re-export chains);
 *  - Go records the package binding: alias → `* as x`, dot import → `*`, plain → [].
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { goHandler } from '../../src/handlers/go.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import type { LanguageHandler } from '../../src/core/types.js';

async function imports(handler: LanguageHandler, source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, handler);
  return handler.extractImports(tree, buf);
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('TypeScript re-exports as import records', () => {
  it('export { a, b as c } from → names are the SOURCE names', async () => {
    const recs = await imports(typescriptHandler, `export { a, b as c } from './lib';`);
    expect(recs).toEqual([{ sourceFile: '', specifier: './lib', resolvedPath: null, importedNames: ['a', 'b'], isTypeOnly: false }]);
  });

  it('export * from → ["*"]; export * as ns from → ["* as ns"]; export type { T } from → type-only', async () => {
    const recs = await imports(
      typescriptHandler,
      `export * from './all';\nexport * as ns from './ns';\nexport type { T } from './types';\n`,
    );
    expect(recs.map((r) => [r.specifier, r.importedNames, r.isTypeOnly])).toEqual([
      ['./all', ['*'], false],
      ['./ns', ['* as ns'], false],
      ['./types', ['T'], true],
    ]);
  });

  it('a plain export (no source) records nothing; regular imports are unchanged', async () => {
    const recs = await imports(typescriptHandler, `export const x = 1;\nexport { x };\nimport { y } from './y';\n`);
    expect(recs).toEqual([{ sourceFile: '', specifier: './y', resolvedPath: null, importedNames: ['y'], isTypeOnly: false }]);
  });

  it('JavaScript handler records the same shapes', async () => {
    const recs = await imports(javascriptHandler, `export { a } from './lib';\nexport * from './all';\n`);
    expect(recs.map((r) => [r.specifier, r.importedNames])).toEqual([['./lib', ['a']], ['./all', ['*']]]);
  });
});

describe('Go import bindings', () => {
  it('plain → [], alias → ["* as x"], dot → ["*"], blank → dropped', async () => {
    const recs = await imports(
      goHandler,
      `package main\n\nimport (\n\t"fmt"\n\tu "example.com/m/util"\n\t. "example.com/m/dot"\n\t_ "example.com/m/side"\n)\n`,
    );
    expect(recs.map((r) => [r.specifier, r.importedNames])).toEqual([
      ['fmt', []],
      ['example.com/m/util', ['* as u']],
      ['example.com/m/dot', ['*']],
    ]);
  });
});

describe('Kotlin wildcard imports', () => {
  it('import a.b.* → specifier is the package, names ["*"]; a plain import keeps the last segment', async () => {
    const recs = await imports(kotlinHandler, `package x

import com.acme.libs.*
import com.acme.libs.Foo
`);
    expect(recs.map((r) => [r.specifier, r.importedNames])).toEqual([
      ['com.acme.libs', ['*']],
      ['com.acme.libs.Foo', ['Foo']],
    ]);
  });
});
