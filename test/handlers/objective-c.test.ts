import { describe, it, expect } from 'vitest';
import { objectiveCHandler } from '../../src/handlers/objective-c.js';
import type { Tree } from '../../src/core/types.js';

// Handler is regex-based (grammarPath returns null) — no tree-sitter needed.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Objective-C handler — extractSymbols', () => {

  // ── @interface → 'class' ─────────────────────────────────────────────────

  it('extracts @interface as kind "class"', () => {
    const { tree, buf } = parse(`
@interface Person : NSObject
- (NSString *)name;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Person.h');
    const sym = syms.find((s) => s.name === 'Person');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('@interface Person');
  });

  it('extracts @interface with protocol conformance as "class"', () => {
    const { tree, buf } = parse(`
@interface MyView : UIView <UITableViewDelegate>
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'MyView.h');
    expect(syms.find((s) => s.name === 'MyView' && s.kind === 'class')).toBeDefined();
  });

  it('extracts @interface category as "class"', () => {
    const { tree, buf } = parse(`
@interface NSString (MyCategory)
- (BOOL)isPalindrome;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'NSString+MyCategory.h');
    expect(syms.find((s) => s.name === 'NSString' && s.kind === 'class')).toBeDefined();
  });

  // ── @protocol → 'interface' ──────────────────────────────────────────────

  it('extracts @protocol as kind "interface"', () => {
    const { tree, buf } = parse(`
@protocol Serializable <NSObject>
- (NSData *)serialize;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Serializable.h');
    const sym = syms.find((s) => s.name === 'Serializable');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
  });

  // ── instance methods → 'method' ──────────────────────────────────────────

  it('extracts instance method as kind "method"', () => {
    const { tree, buf } = parse(`
@interface Person : NSObject
- (NSString *)fullName;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Person.h');
    const method = syms.find((s) => s.kind === 'method');
    expect(method).toBeDefined();
    expect(method!.name).toContain('fullName');
    expect(method!.frameworkMeta?.['isClassMethod']).toBe(false);
  });

  it('qualifies method name with class name', () => {
    const { tree, buf } = parse(`
@interface Dog : NSObject
- (void)bark;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Dog.h');
    const method = syms.find((s) => s.kind === 'method');
    expect(method!.name).toBe('Dog:bark');
  });

  // ── class methods → 'method' with isClassMethod ──────────────────────────

  it('extracts class method with isClassMethod: true', () => {
    const { tree, buf } = parse(`
@interface Person : NSObject
+ (instancetype)personWithName:(NSString *)name;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Person.h');
    const method = syms.find((s) => s.kind === 'method' && s.name.includes('personWithName'));
    expect(method).toBeDefined();
    expect(method!.frameworkMeta?.['isClassMethod']).toBe(true);
    expect(method!.name).toContain('Person::personWithName');
  });

  // ── @property → 'const' ──────────────────────────────────────────────────

  it('extracts @property as kind "const"', () => {
    const { tree, buf } = parse(`
@interface Person : NSObject
@property (nonatomic, strong) NSString *name;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Person.h');
    const prop = syms.find((s) => s.kind === 'const');
    expect(prop).toBeDefined();
    expect(prop!.name).toContain('name');
  });

  it('qualifies property name with class name', () => {
    const { tree, buf } = parse(`
@interface Car : NSObject
@property (nonatomic, assign) NSInteger speed;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Car.h');
    const prop = syms.find((s) => s.kind === 'const');
    expect(prop!.name).toBe('Car.speed');
  });

  // ── doc comments ─────────────────────────────────────────────────────────

  it('uses preceding /// comment as summary', () => {
    const { tree, buf } = parse(
      `/// Represents a user in the system.\n@interface User : NSObject\n@end\n`,
    );
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'User.h');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym!.summary).toContain('Represents a user');
  });

  it('uses preceding /** */ block comment as summary', () => {
    const { tree, buf } = parse(
      `/**\n * Returns the full name.\n */\n- (NSString *)fullName;\n`,
    );
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'test.h');
    const method = syms.find((s) => s.kind === 'method');
    expect(method!.summary).toContain('Returns the full name');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets startByte and endByte for interface', () => {
    const { tree, buf } = parse(`\n@interface Foo : NSObject\n@end\n`);
    const sym = objectiveCHandler.extractSymbols(tree, buf, 'Foo.h').find((s) => s.name === 'Foo')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`@interface Foo : NSObject\n@end\n`);
    const sym = objectiveCHandler.extractSymbols(tree, buf, 'Foo.h').find((s) => s.name === 'Foo')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = objectiveCHandler.extractSymbols(tree, buf, 'Foo.h').find((s) => s.name === 'Foo')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple symbols from a single file', () => {
    const { tree, buf } = parse(`
#import <Foundation/Foundation.h>

@protocol Shape <NSObject>
- (CGFloat)area;
@end

@interface Circle : NSObject <Shape>
@property (nonatomic, assign) CGFloat radius;
+ (instancetype)circleWithRadius:(CGFloat)r;
- (CGFloat)area;
@end
`);
    const syms = objectiveCHandler.extractSymbols(tree, buf, 'Circle.h');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Shape');
    expect(names).toContain('Circle');
    expect(syms.some((s) => s.kind === 'method')).toBe(true);
    expect(syms.some((s) => s.kind === 'const')).toBe(true);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Objective-C handler — extractImports', () => {

  it('extracts #import with angle brackets as external', () => {
    const { tree, buf } = parse(`#import <Foundation/Foundation.h>\n`);
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Foundation/Foundation.h');
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts #import with quotes as local', () => {
    const { tree, buf } = parse(`#import "Person.h"\n`);
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('Person.h');
    expect(imports[0]!.resolvedPath).toBe('Person.h');
  });

  it('extracts #include', () => {
    const { tree, buf } = parse(`#include "utils.h"\n`);
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('utils.h');
  });

  it('extracts multiple imports', () => {
    const { tree, buf } = parse(
      `#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>\n#import "MyClass.h"\n`,
    );
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('Foundation/Foundation.h');
    expect(specs).toContain('UIKit/UIKit.h');
    expect(specs).toContain('MyClass.h');
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(`#import <Foundation/Foundation.h>\n#import <Foundation/Foundation.h>\n`);
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for file with no imports', () => {
    const { tree, buf } = parse(`@interface Foo : NSObject\n@end\n`);
    expect(objectiveCHandler.extractImports(tree, buf)).toHaveLength(0);
  });

  it('sets importedNames from header filename', () => {
    const { tree, buf } = parse(`#import <UIKit/UIKit.h>\n`);
    const imports = objectiveCHandler.extractImports(tree, buf);
    expect(imports[0]!.importedNames).toContain('UIKit');
  });
});
