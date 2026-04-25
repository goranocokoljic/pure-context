import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { railsAdapter } from '../../src/adapters/rails.js';
import type { SymbolRecord } from '../../src/core/types.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/rails-project');

function buf(source: string): Buffer {
  return Buffer.from(source);
}

function readFixture(rel: string): Buffer {
  return Buffer.from(readFileSync(resolve(FIXTURE_ROOT, rel), 'utf8'));
}

function extractFrom(rel: string): SymbolRecord[] {
  return railsAdapter.extractFrameworkSymbols(null, readFixture(rel), rel);
}

// ─── detect ──────────────────────────────────────────────────────────────────

describe('railsAdapter — detect', () => {
  it('returns true for the rails fixture project', async () => {
    const result = await railsAdapter.detect(FIXTURE_ROOT);
    expect(result).toBe(true);
  });

  it('returns false when no Gemfile exists', async () => {
    const result = await railsAdapter.detect('/nonexistent/path');
    expect(result).toBe(false);
  });
});

// ─── metadata ─────────────────────────────────────────────────────────────────

describe('railsAdapter metadata', () => {
  it('name is rails', () => {
    expect(railsAdapter.name).toBe('rails');
  });

  it('extensions returns empty array', () => {
    expect(railsAdapter.extensions()).toEqual([]);
  });
});

// ─── fileFilter ───────────────────────────────────────────────────────────────

describe('railsAdapter.fileFilter', () => {
  it('accepts app/models/*.rb', () => {
    expect(railsAdapter.fileFilter('app/models/user.rb')).toBe(true);
  });

  it('accepts app/controllers/*.rb', () => {
    expect(railsAdapter.fileFilter('app/controllers/users_controller.rb')).toBe(true);
  });

  it('accepts nested controller paths', () => {
    expect(railsAdapter.fileFilter('app/controllers/api/v1/posts_controller.rb')).toBe(true);
  });

  it('accepts app/jobs/*.rb', () => {
    expect(railsAdapter.fileFilter('app/jobs/send_welcome_email_job.rb')).toBe(true);
  });

  it('accepts config/routes.rb', () => {
    expect(railsAdapter.fileFilter('config/routes.rb')).toBe(true);
  });

  it('rejects non-.rb files', () => {
    expect(railsAdapter.fileFilter('app/models/user.js')).toBe(false);
  });

  it('rejects lib/*.rb', () => {
    expect(railsAdapter.fileFilter('lib/helper.rb')).toBe(false);
  });

  it('rejects app/views/*.rb', () => {
    expect(railsAdapter.fileFilter('app/views/users/index.html.erb')).toBe(false);
  });
});

// ─── model extraction ─────────────────────────────────────────────────────────

describe('railsAdapter — model extraction', () => {
  it('extracts a model from ApplicationRecord subclass', () => {
    const syms = extractFrom('app/models/user.rb');
    const model = syms.find((s) => s.name === 'User');
    expect(model).toBeDefined();
    expect(model!.kind).toBe('model');
    expect(model!.frameworkMeta?.rails_model).toBe(true);
    expect(model!.signature).toContain('class User');
    expect(model!.signature).toContain('ApplicationRecord');
  });

  it('includes has_many / belongs_to / has_one associations', () => {
    const syms = extractFrom('app/models/user.rb');
    const model = syms.find((s) => s.name === 'User')!;
    const assoc = model.frameworkMeta?.associations as string[];
    expect(assoc).toContain('posts');
    expect(assoc).toContain('profile');
    expect(assoc).toContain('organization');
  });

  it('extracts model from ActiveRecord::Base subclass', () => {
    const syms = extractFrom('app/models/post.rb');
    const model = syms.find((s) => s.name === 'Post');
    expect(model).toBeDefined();
    expect(model!.kind).toBe('model');
    expect(model!.frameworkMeta?.rails_model).toBe(true);
  });

  it('gives model a deterministic 16-char hex id', () => {
    const s1 = extractFrom('app/models/user.rb').find((s) => s.name === 'User')!;
    const s2 = extractFrom('app/models/user.rb').find((s) => s.name === 'User')!;
    expect(s1.id).toHaveLength(16);
    expect(s1.id).toMatch(/^[0-9a-f]+$/);
    expect(s1.id).toBe(s2.id);
  });

  it('extracts model from inline source', () => {
    const source = `class Order < ApplicationRecord\n  has_many :items\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'app/models/order.rb');
    const model = syms.find((s) => s.name === 'Order');
    expect(model).toBeDefined();
    expect(model!.kind).toBe('model');
    const assoc = model!.frameworkMeta?.associations as string[];
    expect(assoc).toContain('items');
  });

  it('ignores non-model classes', () => {
    const source = `class UserService\n  def call; end\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'app/models/user_service.rb');
    expect(syms).toHaveLength(0);
  });
});

// ─── controller extraction ────────────────────────────────────────────────────

describe('railsAdapter — controller extraction', () => {
  it('extracts the controller class symbol', () => {
    const syms = extractFrom('app/controllers/users_controller.rb');
    const ctrl = syms.find((s) => s.name === 'UsersController');
    expect(ctrl).toBeDefined();
    expect(ctrl!.kind).toBe('class');
    expect(ctrl!.frameworkMeta?.rails_controller).toBe(true);
    expect(ctrl!.signature).toContain('class UsersController');
  });

  it('extracts public actions as view symbols', () => {
    const syms = extractFrom('app/controllers/users_controller.rb');
    const actions = syms.filter((s) => s.kind === 'view').map((s) => s.name);
    expect(actions).toContain('UsersController#index');
    expect(actions).toContain('UsersController#show');
    expect(actions).toContain('UsersController#new');
    expect(actions).toContain('UsersController#create');
  });

  it('action symbols have rails_action in frameworkMeta', () => {
    const syms = extractFrom('app/controllers/users_controller.rb');
    const action = syms.find((s) => s.name === 'UsersController#index')!;
    expect(action.frameworkMeta?.rails_action).toBe(true);
    expect(action.signature).toContain('def index');
  });

  it('does not include private methods as actions', () => {
    const syms = extractFrom('app/controllers/users_controller.rb');
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('UsersController#user_params');
  });

  it('extracts ActionController::API subclass', () => {
    const syms = extractFrom('app/controllers/api/v1/posts_controller.rb');
    const ctrl = syms.find((s) => s.name === 'PostsController');
    expect(ctrl).toBeDefined();
    expect(ctrl!.kind).toBe('class');
    expect(ctrl!.frameworkMeta?.rails_controller).toBe(true);
  });

  it('extracts public actions from ActionController::API subclass', () => {
    const syms = extractFrom('app/controllers/api/v1/posts_controller.rb');
    const actions = syms.filter((s) => s.kind === 'view').map((s) => s.name);
    expect(actions).toContain('PostsController#index');
    expect(actions).toContain('PostsController#show');
    expect(actions).not.toContain('PostsController#post_params');
  });

  it('extracts inline controller', () => {
    const source = `class OrdersController < ApplicationController\n  def index\n  end\n\n  def destroy\n  end\n\n  private\n\n  def find_order\n  end\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'app/controllers/orders_controller.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('OrdersController');
    expect(names).toContain('OrdersController#index');
    expect(names).toContain('OrdersController#destroy');
    expect(names).not.toContain('OrdersController#find_order');
  });
});

// ─── job extraction ───────────────────────────────────────────────────────────

describe('railsAdapter — job extraction', () => {
  it('extracts ApplicationJob subclass', () => {
    const syms = extractFrom('app/jobs/send_welcome_email_job.rb');
    const job = syms.find((s) => s.name === 'SendWelcomeEmailJob');
    expect(job).toBeDefined();
    expect(job!.kind).toBe('class');
    expect(job!.frameworkMeta?.rails_job).toBe(true);
    expect(job!.signature).toContain('class SendWelcomeEmailJob');
  });

  it('extracts ActiveJob::Base subclass', () => {
    const syms = extractFrom('app/jobs/cleanup_job.rb');
    const job = syms.find((s) => s.name === 'CleanupJob');
    expect(job).toBeDefined();
    expect(job!.kind).toBe('class');
    expect(job!.frameworkMeta?.rails_job).toBe(true);
  });

  it('ignores non-job classes', () => {
    const source = `class MyService\n  def call; end\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'app/jobs/my_service.rb');
    expect(syms).toHaveLength(0);
  });
});

// ─── route extraction ─────────────────────────────────────────────────────────

describe('railsAdapter — route extraction', () => {
  it('extracts a GET route', () => {
    const syms = extractFrom('config/routes.rb');
    const route = syms.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.rails_route).toBe(true);
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
  });

  it('extracts a POST route', () => {
    const syms = extractFrom('config/routes.rb');
    const route = syms.find((s) => s.name === 'POST /login');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('POST');
  });

  it('expands resources :users into 5 CRUD routes', () => {
    const syms = extractFrom('config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
    expect(names).toContain('GET /users/:id');
    expect(names).toContain('PUT /users/:id');
    expect(names).toContain('DELETE /users/:id');
  });

  it('resource route symbols have rails_resource flag', () => {
    const syms = extractFrom('config/routes.rb');
    const r = syms.find((s) => s.name === 'GET /users')!;
    expect(r.frameworkMeta?.rails_resource).toBe(true);
  });

  it('expands singular resource :profile into 4 routes', () => {
    const syms = extractFrom('config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /profile');
    expect(names).toContain('POST /profile');
    expect(names).toContain('PUT /profile');
    expect(names).toContain('DELETE /profile');
    // singular resource has no /:id routes
    expect(names).not.toContain('GET /profile/:id');
  });

  it('applies namespace prefix to nested routes', () => {
    const syms = extractFrom('config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /api/v1/posts');
    expect(names).toContain('POST /api/v1/posts');
    expect(names).toContain('GET /api/v1/posts/:id');
    expect(names).toContain('PUT /api/v1/posts/:id');
    expect(names).toContain('DELETE /api/v1/posts/:id');
  });

  it('applies namespace prefix to explicit HTTP routes inside namespace', () => {
    const syms = extractFrom('config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /api/v1/status');
  });

  it('does not emit outer-scope duplicates of namespaced resources', () => {
    const syms = extractFrom('config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('GET /posts');
    expect(names).not.toContain('POST /posts');
  });

  it('route symbols have deterministic 16-char hex ids', () => {
    const s1 = extractFrom('config/routes.rb').find((s) => s.name === 'GET /health')!;
    const s2 = extractFrom('config/routes.rb').find((s) => s.name === 'GET /health')!;
    expect(s1.id).toHaveLength(16);
    expect(s1.id).toMatch(/^[0-9a-f]+$/);
    expect(s1.id).toBe(s2.id);
  });

  it('inline single-namespace route', () => {
    const source = `Rails.application.routes.draw do\n  namespace :admin do\n    get '/dashboard', to: 'dashboard#index'\n  end\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /admin/dashboard');
  });

  it('inline resources without namespace', () => {
    const source = `Rails.application.routes.draw do\n  resources :articles\nend\n`;
    const syms = railsAdapter.extractFrameworkSymbols(null, buf(source), 'config/routes.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /articles');
    expect(names).toContain('POST /articles');
    expect(names).toContain('DELETE /articles/:id');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('railsAdapter.enrichMetadata', () => {
  it('returns the symbol unchanged', () => {
    const sym: SymbolRecord = {
      id: 'abc123def456789a',
      name: 'User',
      kind: 'model',
      filePath: 'app/models/user.rb',
      startByte: 0,
      endByte: 0,
      signature: 'class User < ApplicationRecord',
      summary: 'Rails model: User',
    };
    expect(railsAdapter.enrichMetadata!(sym)).toBe(sym);
  });
});
