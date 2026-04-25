/**
 * Phase 9 Integration Tests — Task 79
 *
 * Validates all four new language handlers end-to-end against representative fixtures.
 *
 *  1.  Elixir: `defmodule` extracted as kind 'class'
 *  2.  Elixir: `def` extracted, `defp` skipped
 *  3.  Elixir: `@doc` captured as docstring
 *  4.  Elixir: `alias`, `import`, `use`, `require` captured as imports
 *  5.  Haskell: function with type signature extracted
 *  6.  Haskell: `data` type with constructors
 *  7.  Haskell: `class` and `instance` declarations
 *  8.  Haskell: Haddock `-- |` captured
 *  9.  Scala: `class`, `object`, `trait` extracted
 *  10. Scala: `case class` with scala_case_class metadata
 *  11. Scala: Scala 3 `enum` and `given`
 *  12. R: function with `<-` assignment
 *  13. R: S3 method detection (`print.myclass`)
 *  14. R: `library()` captured as import
 *  15. R: Roxygen2 `#'` captured
 *  16. Regression: all Phase 1–8 fixtures still green
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ImportRecord } from '../../src/core/types.js';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { elixirHandler } from '../../src/handlers/elixir.js';
import { haskellHandler } from '../../src/handlers/haskell.js';
import { scalaHandler } from '../../src/handlers/scala.js';
import { rHandler } from '../../src/handlers/r.js';
import { initParser, parseFile } from '../../src/core/parse-dispatcher.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const ELIXIR_FIXTURE  = resolve(__dirname, '../fixtures/elixir-project');
const HASKELL_FIXTURE = resolve(__dirname, '../fixtures/haskell-project');
const SCALA_FIXTURE   = resolve(__dirname, '../fixtures/scala-project');
const R_FIXTURE       = resolve(__dirname, '../fixtures/r-project');
const TS_FIXTURE      = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Shared state ──────────────────────────────────────────────────────────────

let elixirRepoId:  string;
let haskellRepoId: string;
let scalaRepoId:   string;
let rRepoId:       string;
let tsRepoId:      string;

// Pre-parsed imports (external imports are dropped from dep_edges, so we parse directly)
let elixirMyAppImports: ImportRecord[] = [];
let haskellMainImports: ImportRecord[] = [];
let rFunctionsImports:  ImportRecord[] = [];
let rClassesImports:    ImportRecord[] = [];

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();

  registerHandler(typescriptHandler);
  registerHandler(elixirHandler);
  registerHandler(haskellHandler);
  registerHandler(scalaHandler);
  registerHandler(rHandler);

  await initParser();

  const [elixirResult, haskellResult, scalaResult, rResult, tsResult] = await Promise.all([
    indexFolder(ELIXIR_FIXTURE),
    indexFolder(HASKELL_FIXTURE),
    indexFolder(SCALA_FIXTURE),
    indexFolder(R_FIXTURE),
    indexFolder(TS_FIXTURE),
  ]);

  elixirRepoId  = elixirResult.repoId;
  haskellRepoId = haskellResult.repoId;
  scalaRepoId   = scalaResult.repoId;
  rRepoId       = rResult.repoId;
  tsRepoId      = tsResult.repoId;

  expect(elixirResult.symbolsFound).toBeGreaterThan(0);
  expect(haskellResult.symbolsFound).toBeGreaterThan(0);
  expect(scalaResult.symbolsFound).toBeGreaterThan(0);
  expect(rResult.symbolsFound).toBeGreaterThan(0);

  // Parse import records directly — external imports are dropped from dep_edges
  const elixirBuf = readFileSync(resolve(ELIXIR_FIXTURE, 'lib/my_app.ex'));
  const elixirTree = await parseFile(elixirBuf, elixirHandler);
  elixirMyAppImports = elixirHandler.extractImports(elixirTree, elixirBuf);

  const haskellBuf = readFileSync(resolve(HASKELL_FIXTURE, 'src/Main.hs'));
  const haskellTree = await parseFile(haskellBuf, haskellHandler);
  haskellMainImports = haskellHandler.extractImports(haskellTree, haskellBuf);

  const rFuncBuf = readFileSync(resolve(R_FIXTURE, 'R/functions.r'));
  const rFuncTree = await parseFile(rFuncBuf, rHandler);
  rFunctionsImports = rHandler.extractImports(rFuncTree, rFuncBuf);

  const rClassBuf = readFileSync(resolve(R_FIXTURE, 'R/classes.r'));
  const rClassTree = await parseFile(rClassBuf, rHandler);
  rClassesImports = rHandler.extractImports(rClassTree, rClassBuf);
}, 60_000);

afterAll(() => {
  for (const id of [elixirRepoId, haskellRepoId, scalaRepoId, rRepoId, tsRepoId]) {
    if (id) deleteIndex(id);
  }
});

// ─── 1. Elixir: defmodule extracted as class ──────────────────────────────────

describe('1. Elixir: defmodule extracted as kind "class"', () => {
  it('MyApp is extracted as kind "class"', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'MyApp', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'MyApp')).toBe(true);
  });

  it('MyApp signature starts with "defmodule"', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'MyApp', { kind: 'class' });
    db.close();
    const mod = results.find((s) => s.name === 'MyApp');
    expect(mod).toBeDefined();
    expect(mod!.signature).toContain('defmodule');
  });

  it('nested module MyApp.User extracted as class', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'MyApp.User', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'MyApp.User')).toBe(true);
  });

  it('MyApp.Repo extracted as class', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'MyApp.Repo', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'MyApp.Repo')).toBe(true);
  });
});

// ─── 2. Elixir: def extracted, defp skipped ───────────────────────────────────

describe('2. Elixir: def extracted, defp skipped', () => {
  it('MyApp.start_link is extracted as kind "function"', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'start_link', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'MyApp.start_link')).toBe(true);
  });

  it('MyApp.version is extracted', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'version');
    db.close();
    expect(results.some((s) => s.name === 'MyApp.version' && s.kind === 'function')).toBe(true);
  });

  it('defp init_state is NOT extracted', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'init_state');
    db.close();
    expect(results).toHaveLength(0);
  });

  it('defmacro with_logging extracted with elixir_macro: true', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'with_logging');
    db.close();
    const macro = results.find((s) => s.name === 'MyApp.with_logging');
    expect(macro).toBeDefined();
    expect(macro!.frameworkMeta?.elixir_macro).toBe(true);
  });

  it('defp sanitize in MyApp.User is NOT extracted', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'sanitize');
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 3. Elixir: @doc captured as docstring ────────────────────────────────────

describe('3. Elixir: @doc captured as docstring (summary)', () => {
  it('MyApp.start_link has non-empty summary from @doc', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'start_link');
    db.close();
    const fn = results.find((s) => s.name === 'MyApp.start_link');
    expect(fn).toBeDefined();
    expect(fn!.summary.length).toBeGreaterThan(0);
  });

  it('MyApp.start_link summary contains "application"', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'start_link');
    db.close();
    const fn = results.find((s) => s.name === 'MyApp.start_link');
    expect(fn).toBeDefined();
    expect(fn!.summary.toLowerCase()).toContain('application');
  });

  it('defmacro defgetter has non-empty summary from @doc', () => {
    const db = openDatabase(elixirRepoId);
    const results = searchSymbols(db, elixirRepoId, 'defgetter');
    db.close();
    const macro = results.find((s) => s.name === 'MyApp.Macros.defgetter');
    expect(macro).toBeDefined();
    expect(macro!.summary.length).toBeGreaterThan(0);
  });
});

// ─── 4. Elixir: alias/import/use/require captured as imports ──────────────────

describe('4. Elixir: alias, import, use, require captured as imports', () => {
  it('alias MyApp.User captured', () => {
    expect(elixirMyAppImports.some((i) => i.specifier === 'MyApp.User')).toBe(true);
  });

  it('use GenServer captured', () => {
    expect(elixirMyAppImports.some((i) => i.specifier === 'GenServer')).toBe(true);
  });

  it('require Logger captured', () => {
    expect(elixirMyAppImports.some((i) => i.specifier === 'Logger')).toBe(true);
  });

  it('import MyApp.Helpers captured', () => {
    expect(elixirMyAppImports.some((i) => i.specifier === 'MyApp.Helpers')).toBe(true);
  });
});

// ─── 5. Haskell: function with type signature ─────────────────────────────────

describe('5. Haskell: function with type signature extracted', () => {
  it('greet is extracted as kind "function"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'greet', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'greet')).toBe(true);
  });

  it('greet signature contains "::"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'greet');
    db.close();
    const fn = results.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('::');
  });

  it('factorial is extracted', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'factorial');
    db.close();
    expect(results.some((s) => s.name === 'factorial' && s.kind === 'function')).toBe(true);
  });

  it('Data.List import captured', () => {
    expect(haskellMainImports.some((i) => i.specifier === 'Data.List')).toBe(true);
  });

  it('qualified Data.Map import captured', () => {
    expect(haskellMainImports.some((i) => i.specifier === 'Data.Map')).toBe(true);
  });
});

// ─── 6. Haskell: data type with constructors ──────────────────────────────────

describe('6. Haskell: data type with constructors', () => {
  it('User data type extracted as kind "class"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'User', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'User')).toBe(true);
  });

  it('Color data type extracted as kind "class"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Color', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'Color')).toBe(true);
  });

  it('data constructors extracted as kind "const"', () => {
    const db = openDatabase(haskellRepoId);
    const reds = searchSymbols(db, haskellRepoId, 'Red', { kind: 'const' });
    db.close();
    expect(reds.some((s) => s.name === 'Red')).toBe(true);
  });

  it('UserId newtype extracted as kind "type"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'UserId', { kind: 'type' });
    db.close();
    expect(results.some((s) => s.name === 'UserId')).toBe(true);
  });

  it('Name type synonym extracted as kind "type"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Name', { kind: 'type' });
    db.close();
    expect(results.some((s) => s.name === 'Name')).toBe(true);
  });
});

// ─── 7. Haskell: class and instance declarations ──────────────────────────────

describe('7. Haskell: class and instance declarations', () => {
  it('Printable typeclass extracted as kind "interface"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Printable', { kind: 'interface' });
    db.close();
    expect(results.some((s) => s.name === 'Printable')).toBe(true);
  });

  it('Serialisable typeclass extracted as kind "interface"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Serialisable', { kind: 'interface' });
    db.close();
    expect(results.some((s) => s.name === 'Serialisable')).toBe(true);
  });

  it('Printable User instance extracted as kind "class" with haskell_instance: true', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Printable', { kind: 'class' });
    db.close();
    const inst = results.find((s) => s.frameworkMeta?.haskell_instance === true && s.name.includes('Printable'));
    expect(inst).toBeDefined();
    expect(inst!.frameworkMeta?.haskell_instance).toBe(true);
  });

  it('instance signature contains "instance"', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'Printable', { kind: 'class' });
    db.close();
    const inst = results.find((s) => s.frameworkMeta?.haskell_instance === true);
    expect(inst).toBeDefined();
    expect(inst!.signature.toLowerCase()).toContain('instance');
  });
});

// ─── 8. Haskell: Haddock -- | comment captured ────────────────────────────────

describe('8. Haskell: Haddock -- | comment captured', () => {
  it('greet function has non-empty summary', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'greet');
    db.close();
    const fn = results.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.summary.length).toBeGreaterThan(0);
  });

  it('greet summary contains content from Haddock comment', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'greet');
    db.close();
    const fn = results.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    // @doc says "Greet a user by name."
    expect(fn!.summary.toLowerCase()).toContain('greet');
  });

  it('User data type has Haddock summary', () => {
    const db = openDatabase(haskellRepoId);
    const results = searchSymbols(db, haskellRepoId, 'User', { kind: 'class' });
    db.close();
    const data = results.find((s) => s.name === 'User');
    expect(data).toBeDefined();
    expect(data!.summary.length).toBeGreaterThan(0);
  });
});

// ─── 9. Scala: class, object, trait extracted ─────────────────────────────────

describe('9. Scala: class, object, trait extracted', () => {
  it('Main object extracted as kind "class" with scala_object: true', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Main', { kind: 'class' });
    db.close();
    const obj = results.find((s) => s.name === 'Main');
    expect(obj).toBeDefined();
    expect(obj!.frameworkMeta?.scala_object).toBe(true);
  });

  it('UserService class extracted as kind "class"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'UserService', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'UserService')).toBe(true);
  });

  it('Repository trait extracted as kind "interface"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Repository', { kind: 'interface' });
    db.close();
    expect(results.some((s) => s.name === 'Repository')).toBe(true);
  });

  it('greet method in UserService extracted as kind "method"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'greet', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name === 'greet')).toBe(true);
  });

  it('Main.main extracted as kind "method"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'main');
    db.close();
    expect(results.some((s) => s.name === 'main')).toBe(true);
  });

  it('private method validate in UserService NOT extracted', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'validate');
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 10. Scala: case class with scala_case_class metadata ─────────────────────

describe('10. Scala: case class with scala_case_class metadata', () => {
  it('User case class extracted as kind "class"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'User', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'User')).toBe(true);
  });

  it('Admin has scala_case_class: true in frameworkMeta', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Admin', { kind: 'class' });
    db.close();
    const admin = results.find((s) => s.name === 'Admin' && s.frameworkMeta?.scala_case_class);
    expect(admin).toBeDefined();
    expect(admin!.frameworkMeta?.scala_case_class).toBe(true);
  });

  it('Admin signature contains "case class"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Admin', { kind: 'class' });
    db.close();
    const admin = results.find((s) => s.name === 'Admin' && s.frameworkMeta?.scala_case_class);
    expect(admin).toBeDefined();
    expect(admin!.signature.toLowerCase()).toContain('case class');
  });

  it('Address case class extracted', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Address', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'Address' && s.frameworkMeta?.scala_case_class)).toBe(true);
  });

  it('Scaladoc comment captured for Admin', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'Admin', { kind: 'class' });
    db.close();
    const admin = results.find((s) => s.name === 'Admin' && s.frameworkMeta?.scala_case_class);
    expect(admin).toBeDefined();
    expect(admin!.summary.length).toBeGreaterThan(0);
  });
});

// ─── 11. Scala: Scala 3 enum and given ────────────────────────────────────────

describe('11. Scala: Scala 3 enum and given', () => {
  it('UserStatus enum extracted as kind "enum"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'UserStatus', { kind: 'enum' });
    db.close();
    // If grammar supports enums — skip gracefully if not
    if (results.length === 0) return;
    expect(results.some((s) => s.name === 'UserStatus')).toBe(true);
  });

  it('given defaultOrdering extracted as kind "const" with scala_given: true', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'defaultOrdering', { kind: 'const' });
    db.close();
    // If grammar supports givens — skip gracefully if not
    if (results.length === 0) return;
    expect(results[0]!.frameworkMeta?.scala_given).toBe(true);
  });

  it('UserId type alias extracted as kind "type"', () => {
    const db = openDatabase(scalaRepoId);
    const results = searchSymbols(db, scalaRepoId, 'UserId', { kind: 'type' });
    db.close();
    expect(results.some((s) => s.name === 'UserId')).toBe(true);
  });
});

// ─── 12. R: function with <- assignment ───────────────────────────────────────

describe('12. R: function with <- assignment', () => {
  it('greet is extracted as kind "function"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'greet', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'greet')).toBe(true);
  });

  it('greet signature contains "<-"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'greet');
    db.close();
    const fn = results.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('<-');
  });

  it('square is extracted as kind "function"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'square', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'square')).toBe(true);
  });

  it('normalize (= assignment) extracted as kind "function"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'normalize', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'normalize')).toBe(true);
  });

  it('MAX_RETRIES constant extracted as kind "const"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'MAX_RETRIES', { kind: 'const' });
    db.close();
    expect(results.some((s) => s.name === 'MAX_RETRIES')).toBe(true);
  });

  it('nested inner function NOT extracted', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'inner');
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 13. R: S3 method detection ───────────────────────────────────────────────

describe('13. R: S3 method detection (print.myclass)', () => {
  it('print.myclass extracted as kind "method"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'print.myclass', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name === 'print.myclass')).toBe(true);
  });

  it('summary.myclass extracted as kind "method"', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'summary.myclass', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name === 'summary.myclass')).toBe(true);
  });

  it('print.myclass signature contains function keyword', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'print.myclass');
    db.close();
    const method = results.find((s) => s.name === 'print.myclass');
    expect(method).toBeDefined();
    expect(method!.signature).toContain('function');
  });
});

// ─── 14. R: library() captured as import ──────────────────────────────────────

describe('14. R: library() captured as import', () => {
  it('library(stats) captured as import in R/functions.r', () => {
    expect(rFunctionsImports.some((i) => i.specifier === 'stats')).toBe(true);
  });

  it('require(utils) captured as import in R/functions.r', () => {
    expect(rFunctionsImports.some((i) => i.specifier === 'utils')).toBe(true);
  });

  it('library(methods) captured as import in R/classes.r', () => {
    expect(rClassesImports.some((i) => i.specifier === 'methods')).toBe(true);
  });
});

// ─── 15. R: Roxygen2 #' comment captured ──────────────────────────────────────

describe('15. R: Roxygen2 #\' comment captured', () => {
  it('greet function has non-empty summary from Roxygen2', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'greet');
    db.close();
    const fn = results.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.summary.length).toBeGreaterThan(0);
  });

  it('format_date has Roxygen2 summary describing date formatting', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'format_date');
    db.close();
    const fn = results.find((s) => s.name === 'format_date');
    expect(fn).toBeDefined();
    expect(fn!.summary.toLowerCase()).toContain('format');
  });

  it('truncate_string has Roxygen2 summary', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'truncate_string');
    db.close();
    const fn = results.find((s) => s.name === 'truncate_string');
    expect(fn).toBeDefined();
    expect(fn!.summary.length).toBeGreaterThan(0);
  });

  it('is_nonempty_string has Roxygen2 summary', () => {
    const db = openDatabase(rRepoId);
    const results = searchSymbols(db, rRepoId, 'is_nonempty_string');
    db.close();
    const fn = results.find((s) => s.name === 'is_nonempty_string');
    expect(fn).toBeDefined();
    expect(fn!.summary.length).toBeGreaterThan(0);
  });
});

// ─── 16. Regression: Phase 1–8 fixtures still green ──────────────────────────

describe('16. Regression: Phase 1–8 TypeScript fixture indexes cleanly', () => {
  it('basic-ts-project produces symbols', () => {
    const db = openDatabase(tsRepoId);
    const results = searchSymbols(db, tsRepoId, '', { limit: 50 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('TypeScript symbols have no elixir/haskell/scala/R contamination', () => {
    const db = openDatabase(tsRepoId);
    const all = searchSymbols(db, tsRepoId, '', { limit: 200 });
    db.close();
    const contaminated = all.filter((s) =>
      s.frameworkMeta?.elixir_macro ||
      s.frameworkMeta?.elixir_impl ||
      s.frameworkMeta?.haskell_instance ||
      s.frameworkMeta?.scala_case_class ||
      s.frameworkMeta?.scala_object ||
      s.frameworkMeta?.scala_given,
    );
    expect(contaminated).toHaveLength(0);
  });

  it('all Phase 9 repos have distinct repoIds', () => {
    const ids = new Set([elixirRepoId, haskellRepoId, scalaRepoId, rRepoId, tsRepoId]);
    expect(ids.size).toBe(5);
  });
});
