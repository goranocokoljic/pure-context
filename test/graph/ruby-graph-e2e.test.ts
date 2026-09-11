/**
 * Phase 103, Task 641 / 645 — Ruby dependency edges end to end.
 *
 * A Rails-shaped fixture (models + controllers + concerns, a gem-style lib/
 * with require / require_relative, a Homebrew-shaped load path that is not
 * lib/, specs) goes through the full indexFolder pipeline — the worker path
 * (default concurrency) and the sequential path — and must produce the same
 * edges: Zeitwerk constants, require through discovered roots, never a
 * dangling target, never production → spec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { rubyHandler } from '../../src/handlers/ruby.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function allEdges(id: string): Array<[string, string]> {
  const db = openDatabase(id);
  const rows = db
    .prepare<[string], { source_file: string; target_file: string }>(
      'SELECT source_file, target_file FROM dep_edges WHERE repo_id = ? AND target_repo_id IS NULL',
    )
    .all(id);
  db.close();
  return rows
    .map((r) => [r.source_file.replace(/\\/g, '/'), r.target_file.replace(/\\/g, '/')] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function edgesFrom(source: string): string[] {
  return allEdges(repoId)
    .filter(([s]) => s === source)
    .map(([, t]) => t)
    .sort();
}

function blastFilesOf(symbolName: string): string[] {
  const db = openDatabase(repoId);
  const sym = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
    )
    .get(repoId, symbolName);
  expect(sym).toBeDefined();
  const radius = getBlastRadius(sym!.id, repoId, db, 3);
  db.close();
  return radius.files.map((f) => f.replace(/\\/g, '/')).sort();
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(rubyHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-ruby-e2e-')));

  // ── Rails app ──────────────────────────────────────────────────────────────
  write('app/models/application_record.rb', 'class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n');
  write('app/models/concerns/searchable.rb', 'module Searchable\n  extend ActiveSupport::Concern\nend\n');
  write('app/models/account.rb', 'class Account < ApplicationRecord\n  has_many :users\nend\n');
  write(
    'app/models/user.rb',
    'class User < ApplicationRecord\n  include Searchable\n  belongs_to :account\n'
      + '  has_many :line_items, class_name: "Billing::LineItem"\n  has_many :taggings, polymorphic: true\n'
      + '  def full_name\n    Other.call\n  end\nend\n',
  );
  write('app/models/billing/line_item.rb', 'module Billing\n  class LineItem < ApplicationRecord\n    belongs_to :user\n  end\nend\n');
  write('app/controllers/users_controller.rb', 'class UsersController < ApplicationController\n  def show\n    @user = User.find(params[:id])\n  end\nend\n');
  write('app/controllers/application_controller.rb', 'class ApplicationController < ActionController::Base\nend\n');

  // ── Gem-style lib/ with require + require_relative ─────────────────────────
  write('lib/my_gem.rb', 'require "json"\nrequire "my_gem/version"\nrequire_relative "my_gem/client"\n\nmodule MyGem\nend\n');
  write('lib/my_gem/version.rb', 'module MyGem\n  VERSION = "1.0"\nend\n');
  write('lib/my_gem/client.rb', 'require_relative "version"\n\nmodule MyGem\n  class Client\n    def get; end\n  end\nend\n');
  write('lib/my_gem/json.rb', 'module MyGem\n  module JSON\n  end\nend\n');

  // ── Homebrew-shaped: Library/Homebrew is the load path, never lib/ ────────
  write('Library/Homebrew/formula.rb', 'require "utils"\n\nclass Formula\n  def brew; end\nend\n');
  write('Library/Homebrew/utils.rb', 'module Utils\n  def self.popen; end\nend\n');
  write('Library/Homebrew/cask/dsl.rb', 'module Cask\n  class DSL\n  end\nend\n');
  write('Library/Homebrew/cask/installer.rb', 'require "cask/dsl"\n\nmodule Cask\n  class Installer < Formula\n  end\nend\n');

  // ── Specs ──────────────────────────────────────────────────────────────────
  write('spec/spec_helper.rb', 'require "my_gem"\n');
  write('spec/models/user_spec.rb', 'require_relative "../spec_helper"\n\nclass FakeUser < User\nend\n');

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 120_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Ruby dependency edges end to end (Task 641)', () => {
  it('the Ruby repo no longer indexes to zero dependency edges, and none dangle', () => {
    const edges = allEdges(repoId);
    expect(edges.length).toBeGreaterThan(0);
    const db = openDatabase(repoId);
    const files = new Set(
      db.prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?').all(repoId)
        .map((r) => r.path.replace(/\\/g, '/')),
    );
    db.close();
    for (const [, target] of edges) expect(files.has(target)).toBe(true);
  });

  it('Zeitwerk: superclass, concern, associations (class_name wins, polymorphic skipped), never method bodies', () => {
    expect(edgesFrom('app/models/user.rb')).toEqual([
      'app/models/account.rb',
      'app/models/application_record.rb',
      'app/models/billing/line_item.rb',
      'app/models/concerns/searchable.rb',
    ]);
    expect(edgesFrom('app/models/account.rb')).toEqual(['app/models/application_record.rb', 'app/models/user.rb']);
    expect(edgesFrom('app/models/billing/line_item.rb')).toEqual(['app/models/application_record.rb', 'app/models/user.rb']);
    // controller: superclass resolves, `User.find` in a method body does NOT (R1)
    expect(edgesFrom('app/controllers/users_controller.rb')).toEqual(['app/controllers/application_controller.rb']);
    // external superclasses / mixins make no edge
    expect(edgesFrom('app/models/application_record.rb')).toEqual([]);
    expect(edgesFrom('app/models/concerns/searchable.rb')).toEqual([]);
  });

  it('require resolves through lib/; "json" is reserved even though lib/my_gem/json.rb exists', () => {
    expect(edgesFrom('lib/my_gem.rb')).toEqual(['lib/my_gem/client.rb', 'lib/my_gem/version.rb']);
    expect(edgesFrom('lib/my_gem/client.rb')).toEqual(['lib/my_gem/version.rb']);
  });

  it('a load path that is not lib/ is discovered from the multi-segment require evidence', () => {
    expect(edgesFrom('Library/Homebrew/cask/installer.rb')).toEqual([
      'Library/Homebrew/cask/dsl.rb',
      'Library/Homebrew/formula.rb',
    ]);
    expect(edgesFrom('Library/Homebrew/formula.rb')).toEqual(['Library/Homebrew/utils.rb']);
  });

  it('specs resolve into production and into specs; production never into specs', () => {
    expect(edgesFrom('spec/spec_helper.rb')).toEqual(['lib/my_gem.rb']);
    expect(edgesFrom('spec/models/user_spec.rb')).toEqual(['app/models/user.rb', 'spec/spec_helper.rb']);
    for (const [s, t] of allEdges(repoId)) {
      if (!s.startsWith('spec/')) expect(t.startsWith('spec/')).toBe(false);
    }
  });

  it('blast radius of ApplicationRecord reaches every model and the spec through User', () => {
    const files = blastFilesOf('ApplicationRecord');
    expect(files).toContain('app/models/user.rb');
    expect(files).toContain('app/models/account.rb');
    expect(files).toContain('app/models/billing/line_item.rb');
    expect(files).toContain('spec/models/user_spec.rb');
    expect(files).not.toContain('lib/my_gem.rb');
  });

  it('the sequential path produces the same edge set as the worker path', async () => {
    const parallel = allEdges(repoId);
    expect(parallel.length).toBeGreaterThan(10);
    // a fresh index (hash cache gone) parsed with concurrency 1
    deleteIndex(repoId);
    const seq = await indexFolder(root, { fileLimit: 100, concurrency: 1 });
    expect(seq.repoId).toBe(repoId);
    expect(seq.filesIndexed).toBe(17);
    expect(allEdges(repoId)).toEqual(parallel);
  }, 60_000);
});
