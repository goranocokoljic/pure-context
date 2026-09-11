/**
 * Ruby standard-library / default-gem `require` names (Phase 103, Task 641).
 *
 * The Python precedent (`python-stdlib.ts`, Phase 98): a `require` whose
 * specifier is listed resolves to NOTHING (external), so a repo file such as
 * `activesupport/lib/active_support/json.rb` can never capture
 * `require "json"` repo-wide. Only the FIRST path segment is matched
 * (`net/http` → `net`, `io/console` → `io`), which is how the load path
 * works: a top-level stdlib name owns its whole subtree. Names are the
 * default + bundled gems of Ruby 3.3 plus the pre-3.0 stdlib names that
 * older codebases still require (`webrick`, `rexml`, `rss`, `matrix`).
 * Default for `graph.reservedRubyModules`; [] disables the check.
 */
export const RUBY_STDLIB_MODULES: ReadonlyArray<string> = [
  'English', 'abbrev', 'base64', 'benchmark', 'bigdecimal', 'bundler', 'cgi', 'coverage',
  'csv', 'date', 'debug', 'delegate', 'did_you_mean', 'digest', 'drb', 'erb',
  'error_highlight', 'etc', 'expect', 'fcntl', 'fiddle', 'fileutils', 'find', 'forwardable',
  'getoptlong', 'io', 'ipaddr', 'irb', 'json', 'logger', 'matrix', 'minitest', 'mkmf',
  'monitor', 'mutex_m', 'net', 'nkf', 'objspace', 'observer', 'open-uri', 'open3',
  'openssl', 'optparse', 'ostruct', 'pathname', 'pp', 'prettyprint', 'prime', 'pstore',
  'psych', 'pty', 'racc', 'rake', 'random', 'rbconfig', 'rdoc', 'readline', 'reline',
  'resolv', 'resolv-replace', 'rexml', 'rinda', 'ripper', 'rss', 'rubygems', 'securerandom',
  'set', 'shellwords', 'singleton', 'socket', 'stringio', 'strscan', 'syntax_suggest',
  'syslog', 'tempfile', 'thread', 'time', 'timeout', 'tmpdir', 'tsort', 'un',
  'unicode_normalize', 'uri', 'weakref', 'webrick', 'win32', 'win32ole', 'yaml', 'zlib',
  // not stdlib, but universal in the ecosystem and never a repo-local file
  'sorbet-runtime', 'rspec', 'pry', 'byebug',
];
