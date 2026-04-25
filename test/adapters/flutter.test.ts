import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { dartHandler } from '../../src/handlers/dart.js';
import { flutterAdapter } from '../../src/adapters/flutter.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

async function parseDart(source: string) {
  const b = buf(source);
  const tree = await parseFile(b, dartHandler);
  return { tree, b };
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-flutter-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

beforeEach(() => {
  resetAdapters();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('flutterAdapter metadata', () => {
  it('has name "flutter"', () => {
    expect(flutterAdapter.name).toBe('flutter');
  });

  it('declares no extra extensions', () => {
    expect(flutterAdapter.extensions()).toEqual([]);
  });

  it('fileFilter accepts .dart files', () => {
    expect(flutterAdapter.fileFilter('lib/widgets/button.dart')).toBe(true);
  });

  it('fileFilter rejects _test.dart files', () => {
    expect(flutterAdapter.fileFilter('test/widget_test.dart')).toBe(false);
    expect(flutterAdapter.fileFilter('test/auth_service_test.dart')).toBe(false);
  });

  it('fileFilter rejects non-dart files', () => {
    expect(flutterAdapter.fileFilter('lib/main.ts')).toBe(false);
    expect(flutterAdapter.fileFilter('pubspec.yaml')).toBe(false);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('flutterAdapter.detect', () => {
  it('detects flutter via pubspec.yaml with sdk: flutter', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pubspec.yaml'), `
name: my_app
dependencies:
  flutter:
    sdk: flutter
`);
    expect(await flutterAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects flutter via any pubspec.yaml containing "flutter"', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pubspec.yaml'), `name: my_app\ndependencies:\n  flutter: any\n`);
    expect(await flutterAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when pubspec.yaml is absent', async () => {
    const dir = tmpDir();
    expect(await flutterAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for non-Flutter pubspec.yaml', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pubspec.yaml'), `name: pure_dart\ndependencies:\n  http: any\n`);
    expect(await flutterAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

// ─── StatelessWidget ──────────────────────────────────────────────────────────

describe('flutterAdapter — StatelessWidget', () => {
  it('emits kind "widget" for a StatelessWidget subclass', async () => {
    const { tree, b } = await parseDart(`
import 'package:flutter/material.dart';
class MyButton extends StatelessWidget {
  const MyButton({super.key});
  Widget build(BuildContext context) => Text('x');
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/widgets/my_button.dart');
    const w = syms.find((s) => s.name === 'MyButton');
    expect(w).toBeDefined();
    expect(w!.kind).toBe('widget');
    expect(w!.frameworkMeta?.flutter_widget_type).toBe('stateless');
    expect(w!.frameworkMeta?.flutter_widget).toBe(true);
  });

  it('includes signature with class declaration', async () => {
    const { tree, b } = await parseDart(`
class PrimaryButton extends StatelessWidget {
  const PrimaryButton();
  Widget build(BuildContext ctx) => Container();
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/widgets/button.dart');
    const w = syms.find((s) => s.name === 'PrimaryButton');
    expect(w!.signature).toContain('extends StatelessWidget');
  });
});

// ─── StatefulWidget ───────────────────────────────────────────────────────────

describe('flutterAdapter — StatefulWidget', () => {
  it('emits kind "widget" for a StatefulWidget subclass', async () => {
    const { tree, b } = await parseDart(`
class HomeScreen extends StatefulWidget {
  const HomeScreen();
  State<HomeScreen> createState() => _HomeScreenState();
}
class _HomeScreenState extends State<HomeScreen> {
  Widget build(context) => Container();
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/screens/home.dart');
    const w = syms.find((s) => s.name === 'HomeScreen');
    expect(w).toBeDefined();
    expect(w!.kind).toBe('widget');
    expect(w!.frameworkMeta?.flutter_widget_type).toBe('stateful');
  });

  it('links StatefulWidget to its State class via state_class', async () => {
    const { tree, b } = await parseDart(`
class HomeScreen extends StatefulWidget {
  const HomeScreen();
  State<HomeScreen> createState() => _HomeScreenState();
}
class _HomeScreenState extends State<HomeScreen> {
  Widget build(context) => Container();
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/screens/home.dart');
    const widget = syms.find((s) => s.name === 'HomeScreen');
    expect(widget!.frameworkMeta?.state_class).toBe('_HomeScreenState');
  });

  it('emits the State<T> class as kind "widget" with flutter_widget_type "state"', async () => {
    const { tree, b } = await parseDart(`
class HomeScreen extends StatefulWidget {
  const HomeScreen();
  State<HomeScreen> createState() => _HomeScreenState();
}
class _HomeScreenState extends State<HomeScreen> {
  Widget build(context) => Container();
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/screens/home.dart');
    const state = syms.find((s) => s.name === '_HomeScreenState');
    expect(state).toBeDefined();
    expect(state!.kind).toBe('widget');
    expect(state!.frameworkMeta?.flutter_widget_type).toBe('state');
    expect(state!.frameworkMeta?.widget_class).toBe('HomeScreen');
  });
});

// ─── InheritedWidget ──────────────────────────────────────────────────────────

describe('flutterAdapter — InheritedWidget', () => {
  it('emits InheritedWidget subclass as "widget"', async () => {
    const { tree, b } = await parseDart(`
class AppTheme extends InheritedWidget {
  const AppTheme({required super.child});
  bool updateShouldNotify(AppTheme old) => false;
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/theme.dart');
    const w = syms.find((s) => s.name === 'AppTheme');
    expect(w).toBeDefined();
    expect(w!.kind).toBe('widget');
    expect(w!.frameworkMeta?.flutter_widget_type).toBe('inherited');
  });
});

// ─── ChangeNotifier ───────────────────────────────────────────────────────────

describe('flutterAdapter — ChangeNotifier', () => {
  it('emits ChangeNotifier subclass as kind "class" with flutter_notifier', async () => {
    const { tree, b } = await parseDart(`
class AuthProvider extends ChangeNotifier {
  bool _auth = false;
  void login() { _auth = true; notifyListeners(); }
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/providers/auth.dart');
    const p = syms.find((s) => s.name === 'AuthProvider');
    expect(p).toBeDefined();
    expect(p!.kind).toBe('class');
    expect(p!.frameworkMeta?.flutter_notifier).toBe(true);
    expect(p!.frameworkMeta?.notifier_base).toBe('ChangeNotifier');
  });

  it('emits ValueNotifier subclass as flutter_notifier', async () => {
    const { tree, b } = await parseDart(`
class CounterNotifier extends ValueNotifier<int> {
  CounterNotifier() : super(0);
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/providers/counter.dart');
    const p = syms.find((s) => s.name === 'CounterNotifier');
    expect(p).toBeDefined();
    expect(p!.frameworkMeta?.flutter_notifier).toBe(true);
  });
});

// ─── @immutable annotation ────────────────────────────────────────────────────

describe('flutterAdapter — @immutable', () => {
  it('emits @immutable class as kind "class" with flutter_immutable', async () => {
    const { tree, b } = await parseDart(`
@immutable
class AppConfig {
  final String apiUrl;
  const AppConfig(this.apiUrl);
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/config.dart');
    const c = syms.find((s) => s.name === 'AppConfig');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('class');
    expect(c!.frameworkMeta?.flutter_immutable).toBe(true);
  });
});

// ─── Plain Dart class ─────────────────────────────────────────────────────────

describe('flutterAdapter — plain Dart class', () => {
  it('does NOT emit a plain class (no widget/notifier base)', async () => {
    const { tree, b } = await parseDart(`
class UserModel {
  final String name;
  UserModel(this.name);
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/models/user.dart');
    expect(syms.find((s) => s.name === 'UserModel')).toBeUndefined();
  });

  it('does NOT emit a class with unrelated superclass', async () => {
    const { tree, b } = await parseDart(`
class ApiService extends BaseService {
  void fetch() {}
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'lib/services/api.dart');
    expect(syms.find((s) => s.name === 'ApiService')).toBeUndefined();
  });
});

// ─── Test file exclusion ──────────────────────────────────────────────────────

describe('flutterAdapter — test file exclusion', () => {
  it('returns no symbols for _test.dart files', async () => {
    const { tree, b } = await parseDart(`
class MyButtonTest extends StatelessWidget {
  Widget build(context) => Text('test');
}
`);
    const syms = flutterAdapter.extractFrameworkSymbols(tree, b, 'test/my_button_test.dart');
    expect(syms).toHaveLength(0);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('flutterAdapter.enrichMetadata', () => {
  it('preserves widget kind unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'MyWidget',
      kind: 'widget' as const,
      filePath: 'lib/widget.dart',
      startByte: 0,
      endByte: 100,
      signature: 'class MyWidget extends StatelessWidget',
      summary: 'Flutter stateless widget: MyWidget',
      frameworkMeta: { flutter_widget: true, flutter_widget_type: 'stateless' },
    };
    const result = flutterAdapter.enrichMetadata!(sym);
    expect(result.kind).toBe('widget');
    expect(result.frameworkMeta?.flutter_widget).toBe(true);
  });

  it('preserves plain class kind unchanged', () => {
    const sym = {
      id: 'xyz',
      name: 'UserModel',
      kind: 'class' as const,
      filePath: 'lib/models/user.dart',
      startByte: 0,
      endByte: 50,
      signature: 'class UserModel',
      summary: 'Dart class: UserModel',
    };
    const result = flutterAdapter.enrichMetadata!(sym);
    expect(result.kind).toBe('class');
  });
});

// ─── Fixture integration ──────────────────────────────────────────────────────

describe('flutterAdapter — fixture files', () => {
  it('extracts widgets from my_button.dart fixture', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      resolve(import.meta.dirname ?? '', '../fixtures/flutter-project/lib/widgets/my_button.dart'),
    );
    const tree = await parseFile(src, dartHandler);
    const syms = flutterAdapter.extractFrameworkSymbols(
      tree, src, 'lib/widgets/my_button.dart',
    );
    const myButton = syms.find((s) => s.name === 'MyButton');
    expect(myButton).toBeDefined();
    expect(myButton!.kind).toBe('widget');
    expect(myButton!.frameworkMeta?.flutter_widget_type).toBe('stateless');

    const appCard = syms.find((s) => s.name === 'AppCard');
    expect(appCard).toBeDefined();
    // AppCard is @immutable StatelessWidget — widget classification wins
    expect(appCard!.kind).toBe('widget');
  });

  it('extracts and links StatefulWidget + State from home_screen.dart fixture', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      resolve(import.meta.dirname ?? '', '../fixtures/flutter-project/lib/screens/home_screen.dart'),
    );
    const tree = await parseFile(src, dartHandler);
    const syms = flutterAdapter.extractFrameworkSymbols(
      tree, src, 'lib/screens/home_screen.dart',
    );
    const home = syms.find((s) => s.name === 'HomeScreen');
    expect(home!.kind).toBe('widget');
    expect(home!.frameworkMeta?.state_class).toBe('_HomeScreenState');

    const state = syms.find((s) => s.name === '_HomeScreenState');
    expect(state!.kind).toBe('widget');
    expect(state!.frameworkMeta?.widget_class).toBe('HomeScreen');
  });

  it('extracts ChangeNotifier providers from auth_provider.dart fixture', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      resolve(import.meta.dirname ?? '', '../fixtures/flutter-project/lib/providers/auth_provider.dart'),
    );
    const tree = await parseFile(src, dartHandler);
    const syms = flutterAdapter.extractFrameworkSymbols(
      tree, src, 'lib/providers/auth_provider.dart',
    );
    expect(syms.find((s) => s.name === 'AuthProvider')?.frameworkMeta?.flutter_notifier).toBe(true);
    expect(syms.find((s) => s.name === 'ThemeProvider')?.frameworkMeta?.flutter_notifier).toBe(true);
  });

  it('emits no widget symbols from plain model file', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      resolve(import.meta.dirname ?? '', '../fixtures/flutter-project/lib/models/user.dart'),
    );
    const tree = await parseFile(src, dartHandler);
    const syms = flutterAdapter.extractFrameworkSymbols(
      tree, src, 'lib/models/user.dart',
    );
    expect(syms.filter((s) => s.kind === 'widget')).toHaveLength(0);
  });
});
