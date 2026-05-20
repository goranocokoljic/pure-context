import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rustHandler } from '../../src/handlers/rust.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rustHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('Rust cfg attribute frameworkMeta', () => {
  it('extracts target_os = "linux" as eq predicate on function_item', async () => {
    const src = `#[cfg(target_os = "linux")]\npub fn send() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/lib.rs');
    const sym = syms.find((s) => s.name === 'send');
    expect(sym).toBeDefined();
    const cfg = sym!.frameworkMeta?.['cfg'] as { raw: string; predicates: unknown[] } | undefined;
    expect(cfg).toBeDefined();
    expect(cfg!.raw).toContain('#[cfg(target_os = "linux")]');
    expect(cfg!.predicates[0]).toMatchObject({ kind: 'eq', key: 'target_os', value: 'linux' });
  });

  it('extracts cfg attribute on struct_item', async () => {
    const src = `#[cfg(feature = "net")]\npub struct TcpStream {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/net.rs');
    const sym = syms.find((s) => s.name === 'TcpStream');
    expect(sym).toBeDefined();
    const cfg = sym!.frameworkMeta?.['cfg'] as { predicates: unknown[] } | undefined;
    expect(cfg).toBeDefined();
    expect(cfg!.predicates[0]).toMatchObject({ kind: 'eq', key: 'feature', value: 'net' });
  });

  it('captures multiple stacked cfg attributes', async () => {
    const src = `#[cfg(target_os = "linux")]\n#[cfg(feature = "rt")]\npub fn spawn() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/rt.rs');
    const sym = syms.find((s) => s.name === 'spawn');
    expect(sym).toBeDefined();
    // With two cfg attrs, frameworkMeta.cfg should be an array
    const cfg = sym!.frameworkMeta?.['cfg'];
    expect(Array.isArray(cfg)).toBe(true);
    expect((cfg as unknown[]).length).toBe(2);
  });

  it('captures cfg_attr attribute with isCfgAttr=true', async () => {
    const src = `#[cfg_attr(windows, path = "windows.rs")]\npub struct Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/foo.rs');
    const sym = syms.find((s) => s.name === 'Foo');
    expect(sym).toBeDefined();
    const cfg = sym!.frameworkMeta?.['cfg'] as { isCfgAttr: boolean } | undefined;
    expect(cfg).toBeDefined();
    expect(cfg!.isCfgAttr).toBe(true);
  });

  it('parses nested all() predicate with children', async () => {
    const src = `#[cfg(all(unix, feature = "io"))]\npub trait AsyncRead {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/io.rs');
    const sym = syms.find((s) => s.name === 'AsyncRead');
    expect(sym).toBeDefined();
    const cfg = sym!.frameworkMeta?.['cfg'] as { predicates: Array<{ kind: string; children?: unknown[] }> } | undefined;
    expect(cfg).toBeDefined();
    const allPred = cfg!.predicates[0]!;
    expect(allPred.kind).toBe('all');
    expect(Array.isArray(allPred.children)).toBe(true);
    expect((allPred.children as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('items WITHOUT cfg have frameworkMeta.cfg undefined', async () => {
    const src = `pub fn normal() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/lib.rs');
    const sym = syms.find((s) => s.name === 'normal');
    expect(sym).toBeDefined();
    expect(sym!.frameworkMeta?.['cfg']).toBeUndefined();
  });

  it('extracts cfg on trait_item', async () => {
    const src = `#[cfg(feature = "serde")]\npub trait Serialize {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/ser.rs');
    const sym = syms.find((s) => s.name === 'Serialize');
    expect(sym).toBeDefined();
    const cfg = sym!.frameworkMeta?.['cfg'] as { predicates: unknown[] } | undefined;
    expect(cfg!.predicates[0]).toMatchObject({ kind: 'eq', key: 'feature', value: 'serde' });
  });
});
