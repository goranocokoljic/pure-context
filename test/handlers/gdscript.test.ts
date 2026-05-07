import { describe, it, expect } from 'vitest';
import { gdscriptHandler } from '../../src/handlers/gdscript.js';
import type { Tree } from '../../src/core/types.js';

// GDScript handler is regex-based (grammarPath returns null) — no tree-sitter needed.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('GDScript handler — extractSymbols', () => {

  // ── func → 'function' ────────────────────────────────────────────────────

  it('extracts func as kind "function"', () => {
    const { tree, buf } = parse(`
func hello_world():
    print("Hello")
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Node.gd');
    const sym = syms.find((s) => s.name === 'hello_world');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('hello_world');
  });

  it('extracts func with return type annotation', () => {
    const { tree, buf } = parse(`
func get_speed() -> float:
    return speed
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'get_speed');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('get_speed');
  });

  it('extracts func with typed parameters', () => {
    const { tree, buf } = parse(`
func take_damage(amount: int, source: Node) -> void:
    health -= amount
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Enemy.gd');
    const sym = syms.find((s) => s.name === 'take_damage');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts built-in lifecycle functions like _ready and _process', () => {
    const { tree, buf } = parse(`
func _ready():
    pass

func _process(delta: float):
    pass
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Main.gd');
    expect(syms.find((s) => s.name === '_ready')).toBeDefined();
    expect(syms.find((s) => s.name === '_process')).toBeDefined();
  });

  // ── class → 'class' ──────────────────────────────────────────────────────

  it('extracts inner class as kind "class"', () => {
    const { tree, buf } = parse(`
class Bullet:
    var speed = 10
    func fire():
        pass
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Weapon.gd');
    const sym = syms.find((s) => s.name === 'Bullet');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('Bullet');
  });

  it('extracts inner class with extends', () => {
    const { tree, buf } = parse(`
class Enemy extends Node2D:
    var hp = 100
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Level.gd');
    const sym = syms.find((s) => s.name === 'Enemy');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  // ── var → 'const' ────────────────────────────────────────────────────────

  it('extracts top-level var as kind "const"', () => {
    const { tree, buf } = parse(`
var health: int = 100
var speed: float = 5.0
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const health = syms.find((s) => s.name === 'health');
    const speed = syms.find((s) => s.name === 'speed');
    expect(health).toBeDefined();
    expect(health!.kind).toBe('const');
    expect(speed).toBeDefined();
    expect(speed!.kind).toBe('const');
  });

  it('does not extract vars inside func bodies', () => {
    const { tree, buf } = parse(`
func setup():
    var local_var = 42
    pass
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Node.gd');
    expect(syms.find((s) => s.name === 'local_var')).toBeUndefined();
  });

  // ── @export var → 'const' with frameworkMeta ─────────────────────────────

  it('extracts @export var as kind "const" with export: true in frameworkMeta', () => {
    const { tree, buf } = parse(`
@export var speed: float = 5.0
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'speed');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.frameworkMeta?.export).toBe(true);
  });

  it('extracts @export() with parenthesised annotation args', () => {
    const { tree, buf } = parse(`
@export() var speed: float = 5.0
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'speed');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.frameworkMeta?.export).toBe(true);
  });

  // ── signal → 'function' ───────────────────────────────────────────────────

  it('extracts signal as kind "function"', () => {
    const { tree, buf } = parse(`
signal health_changed(old_health, new_health)
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'health_changed');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts signal without parameters', () => {
    const { tree, buf } = parse(`
signal died
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Enemy.gd');
    const sym = syms.find((s) => s.name === 'died');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  // ── ## doc comment as summary ─────────────────────────────────────────────

  it('uses preceding ## comment as summary', () => {
    const { tree, buf } = parse(
      `## Moves the player in the given direction.\nfunc move(direction: Vector2):\n    position += direction\n`,
    );
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'move');
    expect(sym!.summary).toContain('Moves the player');
  });

  it('concatenates multi-line ## comments', () => {
    const { tree, buf } = parse(
      `## Handles the attack logic.\n## Reduces enemy health.\nfunc attack(target: Node):\n    pass\n`,
    );
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const sym = syms.find((s) => s.name === 'attack');
    expect(sym!.summary).toContain('Handles the attack');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets non-zero startByte for func not at line 0', () => {
    const { tree, buf } = parse(`extends Node\n\nfunc _ready():\n    pass\n`);
    const sym = gdscriptHandler.extractSymbols(tree, buf, 'Node.gd').find((s) => s.name === '_ready')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThanOrEqual(sym.startByte);
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`func foo():\n    pass\n`);
    const sym = gdscriptHandler.extractSymbols(tree, buf, 'foo.gd').find((s) => s.name === 'foo')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = gdscriptHandler.extractSymbols(tree, buf, 'foo.gd').find((s) => s.name === 'foo')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple symbols from a complete GDScript file', () => {
    const { tree, buf } = parse(`
extends CharacterBody2D

var health: int = 100
@export var speed: float = 200.0
signal died

class WeaponSlot:
    var weapon = null

func _ready():
    pass

func _physics_process(delta: float):
    move_and_slide()
`);
    const syms = gdscriptHandler.extractSymbols(tree, buf, 'Player.gd');
    const names = syms.map((s) => s.name);
    expect(names).toContain('health');
    expect(names).toContain('speed');
    expect(names).toContain('died');
    expect(names).toContain('WeaponSlot');
    expect(names).toContain('_ready');
    expect(names).toContain('_physics_process');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('GDScript handler — extractImports', () => {

  it('extracts extends as an ImportRecord', () => {
    const { tree, buf } = parse(`extends CharacterBody2D\n`);
    const imports = gdscriptHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('CharacterBody2D');
    expect(imports[0]!.importedNames).toContain('CharacterBody2D');
  });

  it('marks extends as resolvedPath null (class inheritance, not file path)', () => {
    const { tree, buf } = parse(`extends Node2D\n`);
    const imports = gdscriptHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('returns empty array for file without extends', () => {
    const { tree, buf } = parse(`var x = 1\n`);
    expect(gdscriptHandler.extractImports(tree, buf)).toHaveLength(0);
  });

  it('only captures one extends per file', () => {
    const { tree, buf } = parse(`extends Node\nextends Node2D\n`);
    // Only the first extends is valid GDScript — handler should emit at most 1
    const imports = gdscriptHandler.extractImports(tree, buf);
    expect(imports.length).toBeLessThanOrEqual(1);
  });
});
