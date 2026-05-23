import { describe, it, expect } from 'vitest';
import { angularHtmlHandler } from '../../src/handlers/angular-html.js';
import type { Tree } from '../../src/core/types.js';

function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

describe('Angular HTML handler — extensions', () => {
  it('claims .html', () => {
    expect(angularHtmlHandler.extensions()).toContain('.html');
  });

  it('has no grammar (regex-only)', () => {
    expect(angularHtmlHandler.grammarPath()).toBeNull();
  });
});

describe('Angular HTML handler — detection guard', () => {
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

  it('processes a file that contains *ngIf', () => {
    const { tree, buf } = parse(`<div *ngIf="show">content</div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    expect(syms.length).toBeGreaterThan(0);
  });

  it('processes a file with routerLink', () => {
    const { tree, buf } = parse(`<a routerLink="/home">Home</a>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'nav.component.html');
    expect(syms.some((s) => s.name === 'routerLink')).toBe(true);
  });
});

describe('Angular HTML handler — extractSymbols', () => {

  // ── component selectors ───────────────────────────────────────────────────

  it('extracts kebab-case component selector as kind "component"', () => {
    const { tree, buf } = parse(`
<div *ngIf="true">
  <app-vault-list></app-vault-list>
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
  <p>text</p>
  <span>more</span>
</div>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    expect(syms.find((s) => s.name === 'div')).toBeUndefined();
    expect(syms.find((s) => s.name === 'p')).toBeUndefined();
  });

  // ── structural directives ─────────────────────────────────────────────────

  it('extracts *ngIf as kind "property"', () => {
    const { tree, buf } = parse(`<div *ngIf="isVisible">content</div>`);
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

  it('deduplicates repeated structural directives', () => {
    const { tree, buf } = parse(`
<div *ngIf="a">A</div>
<span *ngIf="b">B</span>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    const ngIfCount = syms.filter((s) => s.name === '*ngIf').length;
    expect(ngIfCount).toBe(1);
  });

  // ── Angular 17+ control flow ──────────────────────────────────────────────

  it('extracts @if as kind "property"', () => {
    const { tree, buf } = parse(`@if (show) { <p>visible</p> }`);
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
    const { tree, buf } = parse(`<button (click)="onSave()">Save</button>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'form.component.html');
    const ev = syms.find((s) => s.name === '(click)');
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe('property');
    expect(ev!.signature).toContain('onSave()');
  });

  it('deduplicates repeated event bindings of the same type', () => {
    const { tree, buf } = parse(`
<button (click)="save()">Save</button>
<button (click)="cancel()">Cancel</button>
`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.html');
    expect(syms.filter((s) => s.name === '(click)').length).toBe(1);
  });

  // ── template reference variables ──────────────────────────────────────────

  it('extracts template reference variable as kind "const"', () => {
    const { tree, buf } = parse(`<input #userInput type="text" *ngIf="true">`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'form.html');
    const ref = syms.find((s) => s.name === 'userInput');
    expect(ref).toBeDefined();
    expect(ref!.kind).toBe('const');
  });

  // ── routerLink ────────────────────────────────────────────────────────────

  it('extracts routerLink presence as const', () => {
    const { tree, buf } = parse(`<a routerLink="/dashboard" *ngIf="true">Dashboard</a>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'nav.html');
    expect(syms.find((s) => s.name === 'routerLink')).toBeDefined();
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates deterministic 16-char hex IDs', () => {
    const { tree, buf } = parse(`<app-foo></app-foo>` + '\n' + `<div *ngIf="x"></div>`);
    const syms = angularHtmlHandler.extractSymbols(tree, buf, 'app.component.html');
    for (const s of syms) {
      expect(s.id).toHaveLength(16);
      expect(s.id).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('Angular HTML handler — extractImports', () => {
  it('returns empty array', () => {
    const { tree, buf } = parse(`<div *ngIf="x"></div>`);
    expect(angularHtmlHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
