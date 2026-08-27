import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { angularHtmlHandler } from '../../src/handlers/angular-html.js';
import type { Tree } from '../../src/core/types.js';

function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-nghtml-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Angular HTML handler — extensions', () => {
  it('claims .html', () => {
    expect(angularHtmlHandler.extensions()).toContain('.html');
  });

  it('has no grammar (regex-only)', () => {
    expect(angularHtmlHandler.grammarPath()).toBeNull();
  });
});

describe('Angular HTML handler — detection guard (Phase 94: ≥2 distinct markers)', () => {
  it('returns 0 symbols for a plain HTML file without Angular markers', () => {
    const { tree, buf } = parse(`
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><h1>Hello world</h1><p>No Angular here.</p></body>
</html>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'index.html');
    expect(syms).toHaveLength(0);
  });

  it('returns 0 symbols for plain HTML with inline JS arrows, anchors, and hex colors (A-5)', () => {
    const { tree, buf } = parse(`
<!DOCTYPE html>
<html>
<head>
  <style>body { color:#fff; background:#a1b2c3; }</style>
  <script>
    const handler = (e) => { console.log(e); };
    items.forEach((x) => render(x));
  </script>
</head>
<body>
  <a href="#top">Back to top</a>
  <my-web-component data-x="1"></my-web-component>
  &#39;quoted&#39;
</body>
</html>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'index.html');
    expect(syms).toHaveLength(0);
  });

  it('rejects a file with only ONE distinct marker', () => {
    const { tree, buf } = parse(`<div *ngIf="show">content</div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'orphan.html');
    expect(syms).toHaveLength(0);
  });

  it('processes a file with two distinct markers (*ngIf + interpolation)', () => {
    const { tree, buf } = parse(`<div *ngIf="show">{{ title }}</div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.length).toBeGreaterThan(0);
  });

  it('processes a file with routerLink + event binding', () => {
    const { tree, buf } = parse(`<a routerLink="/home" (click)="go()">Home</a>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'nav.component.html');
    expect(syms.some((s) => s.name === 'routerLink')).toBe(true);
  });

  it('detects a marker-less template via sibling .ts file (A-3, the realworld shape)', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.component.ts'), 'export class AppComponent {}');
    const { tree, buf } = parse(`<app-header></app-header>\n<main>static content</main>`);
    const syms = angularHtmlHandler.extractSymbols(
      tree, buf, 'src/app.component.html', { rootPath: dir },
    );
    expect(syms.some((s) => s.name === 'app-header')).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('sibling check uses noExt + ".ts", not ".component.component.ts"', () => {
    const dir = tmpDir();
    // Sibling is exactly foo.component.ts for foo.component.html
    writeFileSync(join(dir, 'foo.component.ts'), 'export class FooComponent {}');
    const { tree, buf } = parse(`<app-inner></app-inner>`);
    const syms = angularHtmlHandler.extractSymbols(
      tree, buf, 'foo.component.html', { rootPath: dir },
    );
    expect(syms.some((s) => s.name === 'app-inner')).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('no sibling + no markers → 0 symbols even with rootPath', () => {
    const dir = tmpDir();
    const { tree, buf } = parse(`<app-inner></app-inner>`);
    const syms = angularHtmlHandler.extractSymbols(
      tree, buf, 'foo.component.html', { rootPath: dir },
    );
    expect(syms).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });
});

describe('Angular HTML handler — extractSymbols', () => {

  // ── component selectors ───────────────────────────────────────────────────

  it('extracts kebab-case component selector as kind "component"', () => {
    const { tree, buf } = parse(`
<div *ngIf="true">
  <app-vault-list [items]="items"></app-vault-list>
</div>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    const comp = syms.find((s) => s.name === 'app-vault-list');
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe('component');
  });

  it('does not emit standard HTML elements as components', () => {
    const { tree, buf } = parse(`
<div *ngFor="let x of list">
  <p>{{ x }}</p>
  <span>more</span>
</div>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    expect(syms.find((s) => s.name === 'div')).toBeUndefined();
    expect(syms.find((s) => s.name === 'p')).toBeUndefined();
  });

  // ── structural directives ─────────────────────────────────────────────────

  it('extracts *ngIf as kind "property"', () => {
    const { tree, buf } = parse(`<div *ngIf="isVisible">{{ text }}</div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    const dir = syms.find((s) => s.name === '*ngIf');
    expect(dir).toBeDefined();
    expect(dir!.kind).toBe('property');
  });

  it('extracts *ngFor as kind "property"', () => {
    const { tree, buf } = parse(`<li *ngFor="let item of items">{{ item }}</li>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'list.html');
    expect(syms.find((s) => s.name === '*ngFor')).toBeDefined();
  });

  it('deduplicates repeated structural directives — one symbol per name (A-6)', () => {
    const { tree, buf } = parse(`
<div *ngIf="a">{{ a }}</div>
<span *ngIf="b">B</span>
<p *ngIf="c">C</p>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    const ngIfCount = syms.filter((s) => s.name === '*ngIf').length;
    expect(ngIfCount).toBe(1);
  });

  // ── spans (A-6) ───────────────────────────────────────────────────────────

  it('gives each symbol a match-local span, not the whole file', () => {
    const source = `<div *ngIf="a">{{ a }}</div>\n<app-child (save)="onSave()"></app-child>\n`;
    const { tree, buf } = parse(source);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.length).toBeGreaterThan(0);
    for (const s of syms) {
      expect(s.endByte - s.startByte).toBeLessThan(buf.length);
      expect(s.endByte).toBeGreaterThan(s.startByte);
    }
    const ngIf = syms.find((s) => s.name === '*ngIf')!;
    expect(source.slice(ngIf.startByte, ngIf.endByte)).toContain('*ngIf');
  });

  it('computes true byte offsets for non-ASCII templates', () => {
    // em-dash (3 bytes) before the directive shifts bytes vs chars
    const source = `<p>—</p>\n<div *ngIf="x">{{ x }}</div>\n`;
    const { tree, buf } = parse(source);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    const ngIf = syms.find((s) => s.name === '*ngIf')!;
    const slice = buf.slice(ngIf.startByte, ngIf.endByte).toString('utf8');
    expect(slice).toContain('*ngIf');
  });

  // ── Angular 17+ control flow ──────────────────────────────────────────────

  it('extracts @if as kind "property"', () => {
    const { tree, buf } = parse(`@if (show) { <p>{{ msg }}</p> }`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.find((s) => s.name === '@if')).toBeDefined();
  });

  it('extracts @for as kind "property"', () => {
    const { tree, buf } = parse(`@for (item of items; track item.id) { <p>{{ item }}</p> }`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.find((s) => s.name === '@for')).toBeDefined();
  });

  // ── event bindings ────────────────────────────────────────────────────────

  it('extracts (click) event binding as kind "property"', () => {
    const { tree, buf } = parse(`<button (click)="onSave()">{{ label }}</button>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'form.component.html');
    const ev = syms.find((s) => s.name === '(click)');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('property');
    expect(ev!.signature).toContain('onSave()');
  });

  it('does not extract JS arrow functions as event bindings (A-5)', () => {
    const { tree, buf } = parse(`
<div *ngIf="x">{{ x }}</div>
<script>const f = (e) => handle(e); run((cb) => cb());</script>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.find((s) => s.name === '(e)')).toBeUndefined();
    expect(syms.find((s) => s.name === '(cb)')).toBeUndefined();
  });

  it('deduplicates repeated event bindings of the same type', () => {
    const { tree, buf } = parse(`
<button (click)="save()">{{ a }}</button>
<button (click)="cancel()">Cancel</button>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    expect(syms.filter((s) => s.name === '(click)').length).toBe(1);
  });

  // ── template reference variables ──────────────────────────────────────────

  it('extracts template reference variable as kind "const"', () => {
    const { tree, buf } = parse(`<input #userInput type="text" *ngIf="true" [value]="v">`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'form.html');
    const ref = syms.find((s) => s.name === 'userInput');
    expect(ref).toBeDefined();
    expect(ref!.kind).toBe('const');
  });

  it('does not extract anchors, entities, or hex colors as template refs (A-5)', () => {
    const { tree, buf } = parse(`
<div *ngIf="x">{{ x }}</div>
<a href="#section">jump</a>
<style>.x { color:#fff; }</style>
&#39;
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.find((s) => s.name === 'section')).toBeUndefined();
    expect(syms.find((s) => s.name === 'fff')).toBeUndefined();
    expect(syms.find((s) => s.name === '39')).toBeUndefined();
  });

  // ── routerLink ────────────────────────────────────────────────────────────

  it('extracts routerLink presence as const', () => {
    const { tree, buf } = parse(`<a routerLink="/dashboard" *ngIf="true">{{ t }}</a>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'nav.html');
    expect(syms.find((s) => s.name === 'routerLink')).toBeDefined();
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates deterministic 16-char hex IDs', () => {
    const { tree, buf } = parse(`<app-foo [x]="y"></app-foo>` + '\n' + `<div *ngIf="x"></div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.length).toBeGreaterThan(0);
    for (const s of syms) {
      expect(s.id).toHaveLength(16);
      expect(s.id).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('Angular HTML handler — extractImports', () => {
  it('returns empty array', () => {
    const { tree, buf } = parse(`<div *ngIf="x">{{ x }}</div>`);
    expect(angularHtmlHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
