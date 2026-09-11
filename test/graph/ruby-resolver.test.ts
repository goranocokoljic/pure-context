/**
 * Phase 103, Task 641 — Ruby import resolver (load-path roots, require_relative,
 * Zeitwerk constants, stdlib reserved names, Phase-98 hygiene).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createRubyResolver,
  isRubySourceFile,
  underscoreRuby,
} from '../../src/graph/ruby-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { replaceImportRecords } from '../../src/core/db/import-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO = 'rubytest1';

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/ruby-app',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

function sym(name: string, kind: SymbolRecord['kind'], filePath: string): SymbolRecord {
  return {
    id: `${filePath}:${name}:${kind}`.slice(0, 16) + Math.random().toString(36).slice(2, 8),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 1,
    signature: name,
    summary: '',
  };
}

function rec(specifier: string) {
  return { sourceFile: '', specifier, resolvedPath: null, importedNames: [], isTypeOnly: false };
}

describe('isRubySourceFile / underscoreRuby', () => {
  it('accepts .rb only', () => {
    expect(isRubySourceFile('lib/a.rb')).toBe(true);
    expect(isRubySourceFile('lib/a.rake')).toBe(false);
  });
  it('underscores like ActiveSupport', () => {
    expect(underscoreRuby('User')).toBe('user');
    expect(underscoreRuby('LineItem')).toBe('line_item');
    expect(underscoreRuby('HTMLParser')).toBe('html_parser');
    expect(underscoreRuby('API')).toBe('api');
    expect(underscoreRuby('OAuth2Token')).toBe('o_auth2_token');
  });
});

describe('createRubyResolver', () => {
  let db: ReturnType<typeof seedDb>;

  const FILES = [
    // Rails app
    'app/models/application_record.rb',
    'app/models/user.rb',
    'app/models/admin/report.rb',
    'app/models/concerns/searchable.rb',
    'app/controllers/users_controller.rb',
    'app/services/billing/invoice_builder.rb',
    'lib/my_gem.rb',
    'lib/my_gem/version.rb',
    'lib/my_gem/json.rb',
    'lib/tasks/helper.rb',
    'config/application.rb',
    'spec/models/user_spec.rb',
    'spec/spec_helper.rb',
    'spec/support/user.rb',
    'vendor/bundle/gems/foo/lib/my_gem/version.rb',
    // Homebrew-shaped: a load path that is not lib/
    'Library/Homebrew/formula.rb',
    'Library/Homebrew/cask/dsl.rb',
    'Library/Homebrew/cask/installer.rb',
    'Library/Homebrew/utils.rb',
    'Library/Homebrew/test/formula_spec.rb',
  ];

  beforeEach(() => {
    db = seedDb();
    for (const p of FILES) upsertFile(db, REPO, p, 'h');
    // Evidence for the Homebrew root: a multi-segment require that only
    // Library/Homebrew/ can answer.
    replaceImportRecords(db, REPO, 'Library/Homebrew/cask/installer.rb', [rec('cask/dsl')]);
    replaceImportRecords(db, REPO, 'Library/Homebrew/formula.rb', [rec('utils'), rec('json')]);
    insertSymbols(db, REPO, [
      sym('ApplicationRecord', 'class', 'app/models/application_record.rb'),
      sym('User', 'class', 'app/models/user.rb'),
      sym('Admin::Report', 'class', 'app/models/admin/report.rb'),
      sym('Searchable', 'type', 'app/models/concerns/searchable.rb'),
      sym('Formula', 'class', 'Library/Homebrew/formula.rb'),
      sym('DSL', 'class', 'Library/Homebrew/cask/dsl.rb'),
      sym('User', 'class', 'spec/support/user.rb'),
      sym('OAuth2Token', 'class', 'app/models/oauth2_token.rb'),
    ]);
    upsertFile(db, REPO, 'app/models/oauth2_token.rb', 'h');
  });

  afterEach(() => db.close());

  it('discovers convention roots (repo root, lib/, app/*, app/*/concerns) and evidence roots', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app', { reservedModules: [] });
    const roots = r.roots();
    expect(roots).toContain('');
    expect(roots).toContain('lib');
    expect(roots).toContain('app/models');
    expect(roots).toContain('app/models/concerns');
    expect(roots).toContain('app/controllers');
    expect(roots).toContain('Library/Homebrew');
    // lib/ inside vendor/ is a root too — hygiene, not discovery, keeps it out of edges
    expect(roots).toContain('vendor/bundle/gems/foo/lib');
    // no evidence root for a directory nobody requires INTO
    expect(roots).not.toContain('config');
  });

  it('require resolves through lib/ and through an evidence root', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app', { reservedModules: [] });
    expect(r.resolve('my_gem/version', 'lib/my_gem.rb')).toEqual(['lib/my_gem/version.rb']);
    expect(r.resolve('my_gem/version.rb', 'lib/my_gem.rb')).toEqual(['lib/my_gem/version.rb']);
    expect(r.resolve('cask/dsl', 'Library/Homebrew/cask/installer.rb')).toEqual(['Library/Homebrew/cask/dsl.rb']);
    // single-segment require only resolves through a discovered root
    expect(r.resolve('utils', 'Library/Homebrew/formula.rb')).toEqual(['Library/Homebrew/utils.rb']);
    expect(r.resolve('config/application', 'lib/my_gem.rb')).toEqual(['config/application.rb']);
  });

  it('stdlib names are reserved: lib/my_gem/json.rb never captures require "json"', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    expect(r.resolve('json', 'lib/my_gem.rb')).toEqual([]);
    expect(r.resolve('net/http', 'lib/my_gem.rb')).toEqual([]);
    // the reserved name only guards the LOAD-PATH form; the namespaced file is reachable by its full path
    expect(r.resolve('my_gem/json', 'lib/my_gem.rb')).toEqual(['lib/my_gem/json.rb']);
    // opt-out
    const open = createRubyResolver(db, REPO, '/tmp/ruby-app', { reservedModules: [] });
    expect(open.resolve('json', 'lib/my_gem.rb')).toEqual([]); // still nothing: no root holds json.rb
  });

  it('require_relative resolves against the importer directory, incl. ../', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    expect(r.resolve('./version', 'lib/my_gem.rb')).toEqual([]); // lib/version.rb does not exist
    expect(r.resolve('./my_gem/version', 'lib/my_gem.rb')).toEqual(['lib/my_gem/version.rb']);
    expect(r.resolve('./version', 'lib/my_gem/json.rb')).toEqual(['lib/my_gem/version.rb']);
    expect(r.resolve('../my_gem', 'lib/my_gem/version.rb')).toEqual(['lib/my_gem.rb']);
    expect(r.resolve('../../../escape', 'lib/my_gem/version.rb')).toEqual([]);
  });

  it('Zeitwerk: a constant path maps to <root>/<underscored path>.rb', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    expect(r.resolve('ApplicationRecord', 'app/models/user.rb')).toEqual(['app/models/application_record.rb']);
    expect(r.resolve('Admin::Report', 'app/controllers/users_controller.rb')).toEqual(['app/models/admin/report.rb']);
    expect(r.resolve('Searchable', 'app/models/user.rb')).toEqual(['app/models/concerns/searchable.rb']);
    expect(r.resolve('Billing::InvoiceBuilder', 'app/models/user.rb')).toEqual(['app/services/billing/invoice_builder.rb']);
    expect(r.resolve('MyGem::Version', 'lib/my_gem.rb')).toEqual(['lib/my_gem/version.rb']);
    // Homebrew shape through the evidence root
    expect(r.resolve('Cask::DSL', 'Library/Homebrew/formula.rb')).toEqual(['Library/Homebrew/cask/dsl.rb']);
  });

  it('Zeitwerk falls back to the symbol table when the path convention misses (acronyms)', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    // underscore gives o_auth2_token.rb — not a file; the class is declared in exactly one file
    expect(r.resolve('OAuth2Token', 'app/models/user.rb')).toEqual(['app/models/oauth2_token.rb']);
    // external constants: nothing declares them
    expect(r.resolve('ActiveRecord::Base', 'app/models/user.rb')).toEqual([]);
    expect(r.resolve('Comparable', 'lib/my_gem.rb')).toEqual([]);
  });

  it('replays the lexical lookup: innermost scope first, on paths and on the symbol table', () => {
    for (const p of ['lib/cask/dsl/base.rb', 'lib/cask/base.rb', 'lib/rubocops/cask/foo.rb', 'lib/system_command.rb', 'lib/utils/output.rb']) {
      upsertFile(db, REPO, p, 'h');
    }
    insertSymbols(db, REPO, [
      sym('Cask', 'type', 'lib/cask/dsl/base.rb'), sym('DSL', 'class', 'lib/cask/dsl/base.rb'), sym('Base', 'class', 'lib/cask/dsl/base.rb'),
      sym('Cask', 'type', 'lib/cask/base.rb'), sym('Base', 'class', 'lib/cask/base.rb'),
      sym('SystemCommand', 'class', 'lib/system_command.rb'), sym('Mixin', 'type', 'lib/system_command.rb'),
      sym('Utils', 'type', 'lib/utils/output.rb'), sym('Output', 'type', 'lib/utils/output.rb'), sym('Mixin', 'type', 'lib/utils/output.rb'),
    ]);
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    // `Base` written inside module Cask; class DSL → Cask::DSL::Base (path hit)
    expect(r.resolve('Base', 'lib/cask/dsl/installer.rb', ['Cask', 'DSL'])).toEqual(['lib/cask/dsl/base.rb']);
    // inside module Cask only → Cask::Base
    expect(r.resolve('Base', 'lib/cask/installer.rb', ['Cask'])).toEqual(['lib/cask/base.rb']);
    // compact nesting names split
    expect(r.resolve('Base', 'lib/cask/dsl/installer.rb', ['Cask::DSL'])).toEqual(['lib/cask/dsl/base.rb']);
    // bare `Base` at top level: two declarers → ambiguous → nothing (never a guess)
    expect(r.resolve('Base', 'lib/rubocops/cask/foo.rb', [])).toEqual([]);
    expect(r.resolve('Base', 'lib/rubocops/cask/foo.rb', ['RuboCop', 'Cop'])).toEqual([]);
    // multi-segment symbol match needs EVERY segment in one file: the right Mixin
    expect(r.resolve('SystemCommand::Mixin', 'lib/utils/git.rb', ['Utils', 'Git'])).toEqual(['lib/system_command.rb']);
    expect(r.resolve('Utils::Output::Mixin', 'lib/formula.rb', ['Formula'])).toEqual(['lib/utils/output.rb']);
    // a last-segment coincidence is not a match
    expect(r.resolve('Tapioca::Dsl::Mixin', 'lib/formula.rb', [])).toEqual([]);
  });

  it('hygiene: production importers never resolve into spec/ or vendor/; self-imports drop', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    // `User` is declared in app/models AND spec/support — path convention wins, test file never considered
    expect(r.resolve('User', 'app/controllers/users_controller.rb')).toEqual(['app/models/user.rb']);
    // vendor lib/ root holds my_gem/version.rb too — first-party importer never crosses into vendor
    expect(r.resolve('my_gem/version', 'lib/my_gem.rb')).toEqual(['lib/my_gem/version.rb']);
    // a vendored importer keeps its own siblings
    expect(r.resolve('my_gem/version', 'vendor/bundle/gems/foo/lib/my_gem.rb')).toContain(
      'vendor/bundle/gems/foo/lib/my_gem/version.rb',
    );
    // test importers may resolve into tests
    expect(r.resolve('spec_helper', 'spec/models/user_spec.rb')).toEqual([]); // spec/ is not a root
    expect(r.resolve('./spec_helper', 'spec/models/user_spec.rb')).toEqual([]);
    expect(r.resolve('../spec_helper', 'spec/models/user_spec.rb')).toEqual(['spec/spec_helper.rb']);
    // self
    expect(r.resolve('Formula', 'Library/Homebrew/formula.rb')).toEqual([]);
    expect(r.resolve('./formula', 'Library/Homebrew/formula.rb')).toEqual([]);
  });

  it('never yields a dangling target or a fan-out from a constant', () => {
    const r = createRubyResolver(db, REPO, '/tmp/ruby-app');
    expect(r.resolve('does/not/exist', 'lib/my_gem.rb')).toEqual([]);
    expect(r.resolve('Nope::Missing', 'lib/my_gem.rb')).toEqual([]);
    // `User` from a test importer: the Zeitwerk path app/models/user.rb answers first
    expect(r.resolve('User', 'spec/models/user_spec.rb')).toEqual(['app/models/user.rb']);
  });
});
