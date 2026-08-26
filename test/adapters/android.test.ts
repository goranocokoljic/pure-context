/**
 * Tasks 523–525, 527, 528 (Phase 85): android adapter unit tests.
 *
 * Detection (bounded recursive), file routing, Compose kind upgrade (+preview),
 * Hilt/Dagger DI metadata per annotation (Kotlin + Java), manifest entry-point
 * symbols, and Gradle module attribution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  androidAdapter,
  collectKotlinFacts,
  collectJavaFacts,
  extractManifestSymbols,
  gradleModuleOf,
  cleanType,
  _factsCacheForTesting,
} from '../../src/adapters/android.js';
import { ktorAdapter } from '../../src/adapters/ktor.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/android-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-android-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function handlerSym(
  name: string,
  filePath: string,
  kind: SymbolKind = 'function',
): SymbolRecord {
  return {
    id: 'deadbeefdeadbeef',
    name,
    kind,
    filePath,
    startByte: 5,
    endByte: 50,
    signature: `fun ${name}()`,
    summary: `${name} summary`,
  };
}

beforeEach(() => {
  _factsCacheForTesting().clear();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('androidAdapter metadata', () => {
  it('has name "android"', () => {
    expect(androidAdapter.name).toBe('android');
  });

  it('declares .xml so manifests stay discoverable', () => {
    expect(androidAdapter.extensions()).toEqual(['.xml']);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('androidAdapter.detect', () => {
  it('detects a nested AndroidManifest.xml', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'app', 'src', 'main'), { recursive: true });
    writeFileSync(join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest />\n');
    expect(await androidAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects com.android.application in a nested build.gradle.kts', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }\n');
    expect(await androidAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects com.android.library in build.gradle', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "apply plugin: 'com.android.library'\n");
    expect(await androidAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('does not detect a Ktor server project (coexistence guard)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'implementation("io.ktor:ktor-server-core:2.3.7")\n');
    writeFileSync(join(dir, 'Server.kt'), 'fun main() {}\n');
    expect(await androidAdapter.detect(dir)).toBe(false);
    expect(await ktorAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false for an empty directory', async () => {
    const dir = tmpDir();
    expect(await androidAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects the checked-in android fixture', async () => {
    expect(await androidAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File routing ─────────────────────────────────────────────────────────────

describe('androidAdapter.fileFilter', () => {
  it('claims .kt, .java, and AndroidManifest.xml — nothing else', () => {
    expect(androidAdapter.fileFilter('app/src/main/java/com/example/A.kt')).toBe(true);
    expect(androidAdapter.fileFilter('app/src/main/java/com/example/A.java')).toBe(true);
    expect(androidAdapter.fileFilter('app/src/main/AndroidManifest.xml')).toBe(true);
    expect(androidAdapter.fileFilter('app/src/main/res/layout/activity_main.xml')).toBe(false);
    expect(androidAdapter.fileFilter('src/index.ts')).toBe(false);
  });
});

// ─── Kotlin annotation facts ──────────────────────────────────────────────────

describe('collectKotlinFacts', () => {
  it('records @Composable functions, with @Preview flagged', () => {
    const facts = collectKotlinFacts(
      '@Composable\nfun HomeScreen() {}\n\n@Preview(showBackground = true)\n@Composable\nfun HomePreview() {}\n\nfun plain() {}\n',
    );
    expect(facts.composables.get('HomeScreen')).toEqual({ preview: false });
    expect(facts.composables.get('HomePreview')).toEqual({ preview: true });
    expect(facts.composables.has('plain')).toBe(false);
  });

  it('a @Composable lambda TYPE does not mark the next function (type-position guard)', () => {
    const facts = collectKotlinFacts(
      'fun Button(content: @Composable () -> Unit) {}\n\nfun helper() {}\n',
    );
    expect(facts.composables.size).toBe(0);
  });

  it('records @Provides with return type and scope', () => {
    const facts = collectKotlinFacts(
      '@Provides\n@Singleton\nfun provideAppDatabase(context: Context): AppDatabase {\n  return AppDatabase()\n}\n',
    );
    expect(facts.di.get('provideAppDatabase')).toMatchObject({
      role: 'provider',
      providedType: 'AppDatabase',
      scope: 'Singleton',
    });
  });

  it('records @Binds with bound interface and consumed impl', () => {
    const facts = collectKotlinFacts(
      '@Binds\nabstract fun bindUserRepository(impl: UserRepositoryImpl): UserRepository\n',
    );
    expect(facts.di.get('bindUserRepository')).toMatchObject({
      role: 'provider',
      providedType: 'UserRepository',
      binds: true,
      consumedTypes: ['UserRepositoryImpl'],
    });
  });

  it('records an @Inject primary constructor on the class', () => {
    const facts = collectKotlinFacts(
      '@HiltViewModel\nclass HomeViewModel @Inject constructor(\n  private val repository: UserRepository,\n  handle: SavedStateHandle,\n) : ViewModel() {}\n',
    );
    expect(facts.di.get('HomeViewModel')).toMatchObject({
      role: 'consumer',
      injectConstructor: true,
      hiltViewModel: true,
      consumedTypes: ['UserRepository', 'SavedStateHandle'],
    });
  });

  it('records @Module and @AndroidEntryPoint classes', () => {
    const facts = collectKotlinFacts(
      '@Module\n@InstallIn(SingletonComponent::class)\nobject DataModule {}\n\n@AndroidEntryPoint\nclass MainActivity : ComponentActivity() {}\n',
    );
    expect(facts.di.get('DataModule')).toMatchObject({ role: 'module' });
    expect(facts.di.get('MainActivity')).toMatchObject({ androidEntryPoint: true });
  });

  it('records Kotlin field injection', () => {
    const facts = collectKotlinFacts(
      'class SyncService : Service() {\n  @Inject lateinit var repository: UserRepository\n}\n',
    );
    expect(facts.di.get('SyncService')).toMatchObject({
      role: 'consumer',
      injectedFields: true,
      consumedTypes: ['UserRepository'],
    });
  });

  it('strips generics and nullability from types', () => {
    const facts = collectKotlinFacts(
      '@Provides\nfun provideList(dep: Repo?): List<String> { return listOf() }\n',
    );
    expect(facts.di.get('provideList')).toMatchObject({ providedType: 'List' });
  });
});

// ─── Java annotation facts ────────────────────────────────────────────────────

describe('collectJavaFacts', () => {
  it('records an @Inject constructor with parameter types', () => {
    const facts = collectJavaFacts(
      'public class AnalyticsTracker {\n  @Inject\n  public AnalyticsTracker(AppDatabase database, EventBus bus) {}\n}\n',
    );
    expect(facts.di.get('AnalyticsTracker')).toMatchObject({
      role: 'consumer',
      injectConstructor: true,
      consumedTypes: ['AppDatabase', 'EventBus'],
    });
  });

  it('records @Inject fields on the enclosing class', () => {
    const facts = collectJavaFacts(
      'public class LegacyActivity {\n  @Inject\n  UserRepository repository;\n}\n',
    );
    expect(facts.di.get('LegacyActivity')).toMatchObject({
      role: 'consumer',
      injectedFields: true,
      consumedTypes: ['UserRepository'],
    });
  });

  it('records @Provides methods with return type', () => {
    const facts = collectJavaFacts(
      '@Module\npublic class AppModule {\n  @Provides\n  @Singleton\n  static AppDatabase provideDatabase(Context context) {\n    return null;\n  }\n}\n',
    );
    expect(facts.di.get('AppModule')).toMatchObject({ role: 'module' });
    expect(facts.di.get('provideDatabase')).toMatchObject({
      role: 'provider',
      providedType: 'AppDatabase',
      scope: 'Singleton',
    });
  });

  it('plain constructors and fields carry no DI metadata', () => {
    const facts = collectJavaFacts(
      'public class Plain {\n  private final AppDatabase db;\n  public Plain(AppDatabase db) { this.db = db; }\n}\n',
    );
    expect(facts.di.size).toBe(0);
  });
});

// ─── Manifest extraction ──────────────────────────────────────────────────────

const MANIFEST = `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
  <application>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <service android:name=".SyncService" android:exported="false" />
    <receiver android:name="com.example.other.BootReceiver">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
      </intent-filter>
    </receiver>
    <provider android:name=".DataProvider" android:authorities="com.example.app.data" />
  </application>
</manifest>
`;

describe('extractManifestSymbols', () => {
  const MANIFEST_PATH = 'app/src/main/AndroidManifest.xml';

  it('emits one route symbol per component, all four kinds', () => {
    const symbols = extractManifestSymbols(buf(MANIFEST), MANIFEST_PATH);
    expect(symbols).toHaveLength(4);
    const components = symbols.map((s) => s.frameworkMeta?.['component']).sort();
    expect(components).toEqual(['activity', 'provider', 'receiver', 'service']);
    expect(symbols.every((s) => s.kind === 'route')).toBe(true);
    expect(symbols.every((s) => s.frameworkMeta?.['android'] === 'manifest')).toBe(true);
  });

  it('resolves leading-dot names against the manifest package', () => {
    const symbols = extractManifestSymbols(buf(MANIFEST), MANIFEST_PATH);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('com.example.app.MainActivity');
    expect(names).toContain('com.example.app.SyncService');
    expect(names).toContain('com.example.other.BootReceiver'); // already qualified — untouched
  });

  it('flags the LAUNCHER activity and records intent filters + exported', () => {
    const symbols = extractManifestSymbols(buf(MANIFEST), MANIFEST_PATH);
    const activity = symbols.find((s) => s.name.endsWith('MainActivity'))!;
    expect(activity.frameworkMeta?.['launcher']).toBe(true);
    expect(activity.frameworkMeta?.['exported']).toBe(true);
    expect(activity.frameworkMeta?.['intentFilters']).toEqual(['MAIN/LAUNCHER']);
    const service = symbols.find((s) => s.name.endsWith('SyncService'))!;
    expect(service.frameworkMeta?.['exported']).toBe(false);
    expect(service.frameworkMeta?.['launcher']).toBeUndefined();
  });

  it('keeps the bare name when no package attribute exists (namespace-in-gradle manifests)', () => {
    const modern = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application>\n    <activity android:name=".MainActivity" />\n  </application>\n</manifest>\n';
    const symbols = extractManifestSymbols(buf(modern), MANIFEST_PATH);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('MainActivity');
  });

  it('degrades to zero symbols on malformed input without throwing', () => {
    expect(extractManifestSymbols(buf('<manifest><activity'), MANIFEST_PATH)).toEqual([]);
    expect(extractManifestSymbols(buf(''), MANIFEST_PATH)).toEqual([]);
    expect(extractManifestSymbols(buf('not xml at all'), MANIFEST_PATH)).toEqual([]);
  });
});

// ─── enrichMetadata pipeline ──────────────────────────────────────────────────

describe('androidAdapter.enrichMetadata', () => {
  const KT_PATH = 'app/src/main/java/com/example/app/HomeScreen.kt';

  function extractThenEnrich(source: string, symbol: SymbolRecord): SymbolRecord {
    androidAdapter.extractFrameworkSymbols(null, buf(source), symbol.filePath);
    return androidAdapter.enrichMetadata!(symbol);
  }

  it('upgrades a @Composable function to kind composable with a recomputed id', () => {
    const before = handlerSym('HomeScreen', KT_PATH, 'function');
    const after = extractThenEnrich('@Composable\nfun HomeScreen() {}\n', before);
    expect(after.kind).toBe('composable');
    expect(after.id).not.toBe(before.id);
    expect(after.frameworkMeta?.['android']).toBe('compose');
    expect(after.frameworkMeta?.['preview']).toBeUndefined();
    // Handler spans and signature survive the upgrade
    expect(after.startByte).toBe(before.startByte);
    expect(after.endByte).toBe(before.endByte);
    expect(after.signature).toBe(before.signature);
  });

  it('marks @Preview composables so they can be filtered from API surfaces', () => {
    const after = extractThenEnrich(
      '@Preview\n@Composable\nfun HomeScreenPreview() {}\n',
      handlerSym('HomeScreenPreview', KT_PATH, 'function'),
    );
    expect(after.kind).toBe('composable');
    expect(after.frameworkMeta?.['preview']).toBe(true);
  });

  it('matches qualified handler names by bare segment', () => {
    const after = extractThenEnrich(
      'class Screens {\n  @Composable\n  fun ItemRow() {}\n}\n',
      handlerSym('Screens.ItemRow', KT_PATH, 'method'),
    );
    expect(after.kind).toBe('composable');
  });

  it('leaves non-annotated functions untouched apart from gradleModule', () => {
    const before = handlerSym('formatTitle', KT_PATH, 'function');
    const after = extractThenEnrich('@Composable\nfun HomeScreen() {}\nfun formatTitle() {}\n', before);
    expect(after.kind).toBe('function');
    expect(after.id).toBe(before.id);
    expect(after.frameworkMeta?.['android']).toBeUndefined();
    expect(after.frameworkMeta?.['gradleModule']).toBe(':app');
  });

  it('attaches DI metadata to class symbols', () => {
    const after = extractThenEnrich(
      '@HiltViewModel\nclass HomeViewModel @Inject constructor(repo: UserRepository) : ViewModel() {}\n',
      handlerSym('HomeViewModel', 'app/src/main/java/com/example/app/HomeViewModel.kt', 'class'),
    );
    expect(after.frameworkMeta?.['di']).toMatchObject({
      role: 'consumer',
      injectConstructor: true,
      hiltViewModel: true,
      consumedTypes: ['UserRepository'],
    });
  });

  it('attributes symbols to their Gradle module', () => {
    const appSym = extractThenEnrich('fun x() {}\n', handlerSym('x', 'app/src/main/java/A.kt'));
    expect(appSym.frameworkMeta?.['gradleModule']).toBe(':app');

    const nested = extractThenEnrich(
      'fun y() {}\n',
      handlerSym('y', 'feature/login/src/main/java/B.kt'),
    );
    expect(nested.frameworkMeta?.['gradleModule']).toBe(':feature:login');
  });

  it('does not touch symbols from non-Android files', () => {
    const before = handlerSym('helper', 'src/utils/helper.ts');
    expect(androidAdapter.enrichMetadata!(before)).toBe(before);
  });
});

// ─── Path helpers ─────────────────────────────────────────────────────────────

describe('gradleModuleOf', () => {
  it('derives module paths from the src/ boundary', () => {
    expect(gradleModuleOf('app/src/main/java/com/example/A.kt')).toBe(':app');
    expect(gradleModuleOf('feature/login/src/main/java/B.kt')).toBe(':feature:login');
    expect(gradleModuleOf('src/main/java/C.kt')).toBe(':');
    expect(gradleModuleOf('scripts/build.kt')).toBe(null);
  });
});

describe('cleanType', () => {
  it('normalizes type expressions', () => {
    expect(cleanType(' AppDatabase ')).toBe('AppDatabase');
    expect(cleanType('List<String>')).toBe('List');
    expect(cleanType('Repo?')).toBe('Repo');
    expect(cleanType('com.example.Foo')).toBe('com.example.Foo');
    expect(cleanType('@ApplicationContext Context')).toBe('Context');
    expect(cleanType('vararg Item')).toBe('Item');
    expect(cleanType('() -> Unit')).toBe(null);
  });
});
