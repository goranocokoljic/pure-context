import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rubyHandler } from '../../src/handlers/ruby.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rubyHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('Ruby DSL extraction — associations', () => {
  it('extracts has_many association as property', async () => {
    const src = `class Post\n  has_many :comments\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/post.rb');
    const assoc = syms.find((s) => s.name === 'Post#comments');
    expect(assoc).toBeDefined();
    expect(assoc!.kind).toBe('property');
    expect(assoc!.frameworkMeta!['assoc']).toBe('has_many');
  });

  it('extracts has_one association as property', async () => {
    const src = `class User\n  has_one :profile\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/user.rb');
    const assoc = syms.find((s) => s.name === 'User#profile');
    expect(assoc).toBeDefined();
    expect(assoc!.kind).toBe('property');
    expect(assoc!.frameworkMeta!['assoc']).toBe('has_one');
  });

  it('extracts belongs_to association as property', async () => {
    const src = `class Comment\n  belongs_to :post\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/comment.rb');
    const assoc = syms.find((s) => s.name === 'Comment#post');
    expect(assoc).toBeDefined();
    expect(assoc!.frameworkMeta!['assoc']).toBe('belongs_to');
  });

  it('extracts has_and_belongs_to_many as property with habtm meta', async () => {
    const src = `class Post\n  has_and_belongs_to_many :tags\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/post.rb');
    const assoc = syms.find((s) => s.name === 'Post#tags');
    expect(assoc).toBeDefined();
    expect(assoc!.frameworkMeta!['assoc']).toBe('habtm');
  });

  it('extracts has_many :through option into frameworkMeta', async () => {
    const src = `class Post\n  has_many :tags, through: :taggings\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/post.rb');
    const assoc = syms.find((s) => s.name === 'Post#tags');
    expect(assoc).toBeDefined();
    expect(assoc!.frameworkMeta!['through']).toBe('taggings');
  });

  it('extracts polymorphic: true into frameworkMeta', async () => {
    const src = `class Comment\n  belongs_to :commentable, polymorphic: true\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/comment.rb');
    const assoc = syms.find((s) => s.name === 'Comment#commentable');
    expect(assoc).toBeDefined();
    expect(assoc!.frameworkMeta!['polymorphic']).toBe(true);
  });
});

describe('Ruby DSL extraction — callbacks', () => {
  it('extracts before_action as middleware', async () => {
    const src = `class PostsController\n  before_action :authenticate\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/controllers/posts_controller.rb');
    const cb = syms.find((s) => s.name === 'PostsController#authenticate');
    expect(cb).toBeDefined();
    expect(cb!.kind).toBe('middleware');
    expect(cb!.frameworkMeta!['target']).toBe('authenticate');
  });

  it('extracts before_action :only option into frameworkMeta', async () => {
    const src = `class PostsController\n  before_action :authenticate, only: [:show, :edit]\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/controllers/posts_controller.rb');
    const cb = syms.find((s) => s.name === 'PostsController#authenticate');
    expect(cb).toBeDefined();
    expect(cb!.frameworkMeta!['onlyActions']).toEqual(['show', 'edit']);
  });

  it('extracts after_create callback as middleware', async () => {
    const src = `class User\n  after_create :send_welcome_email\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/user.rb');
    const cb = syms.find((s) => s.name === 'User#send_welcome_email');
    expect(cb).toBeDefined();
    expect(cb!.kind).toBe('middleware');
    expect(cb!.frameworkMeta!['target']).toBe('send_welcome_email');
  });

  it('extracts after_action as middleware', async () => {
    const src = `class ApplicationController\n  after_action :set_headers\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/controllers/application_controller.rb');
    const cb = syms.find((s) => s.name === 'ApplicationController#set_headers');
    expect(cb).toBeDefined();
    expect(cb!.kind).toBe('middleware');
  });
});

describe('Ruby DSL extraction — scopes and validations', () => {
  it('extracts scope as method', async () => {
    const src = `class Post\n  scope :active, -> { where(active: true) }\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/post.rb');
    const scope = syms.find((s) => s.name === 'Post#active');
    expect(scope).toBeDefined();
    expect(scope!.kind).toBe('method');
    expect(scope!.frameworkMeta!['scope']).toBe(true);
  });

  it('extracts validates as property', async () => {
    const src = `class User\n  validates :email, presence: true\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/user.rb');
    const v = syms.find((s) => s.name === 'User#email');
    expect(v).toBeDefined();
    expect(v!.kind).toBe('property');
    expect(v!.frameworkMeta!['validation']).toBe(true);
  });

  it('does NOT extract DSL patterns outside a class context', async () => {
    const src = `has_many :comments\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/helper.rb');
    expect(syms.filter((s) => s.frameworkMeta?.['assoc'])).toHaveLength(0);
  });

  it('extracts multiple DSL patterns in a single class', async () => {
    const src = `class Post
  belongs_to :user
  has_many :comments
  scope :published, -> { where(published: true) }
  before_action :check_auth
end
`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/post.rb');
    const dslSyms = syms.filter((s) => s.frameworkMeta !== undefined);
    expect(dslSyms.length).toBeGreaterThanOrEqual(4);
  });
});
