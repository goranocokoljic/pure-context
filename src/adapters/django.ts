/**
 * Django framework adapter.
 *
 * Extracts model, view, route, and signal symbols from Django applications
 * using regex pattern scanning on Python source text.
 *
 * Patterns recognised:
 *   class User(models.Model):                      → model
 *   class UserListView(APIView):                   → view (CBV)
 *   @login_required / @api_view([...])             → view (FBV)
 *   path('/users/', ...) in urls.py                → route
 *   @receiver(post_save, sender=User)              → signal
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

function hasDjangoImport(sourceStr: string): boolean {
  return (
    /from\s+django\b/.test(sourceStr) ||
    /import\s+django\b/.test(sourceStr) ||
    /from\s+rest_framework\b/.test(sourceStr)
  );
}

// ─── Model extraction ─────────────────────────────────────────────────────────

// Base classes that indicate a Django ORM model
const MODEL_BASES = [
  'models\\.Model',
  'Model',
  'BaseModel',         // DRF / Pydantic style (common pattern)
  'MPTTModel',         // django-mptt
  'TimeStampedModel',  // django-extensions
  'AbstractUser',
  'AbstractBaseUser',
].join('|');

const MODEL_RE = new RegExp(
  `^class\\s+(\\w+)\\s*\\(([^)]*(?:${MODEL_BASES})[^)]*)\\)\\s*:`,
  'gm',
);

function extractModels(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  MODEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODEL_RE.exec(sourceStr)) !== null) {
    const name = m[1]!;
    symbols.push({
      id: makeId(filePath, name, 'model'),
      name,
      kind: 'model',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: m[0]!.trim(),
      summary: `Django model: ${name}`,
      frameworkMeta: { django_model: true },
    });
  }
  return symbols;
}

// ─── View extraction ──────────────────────────────────────────────────────────

// Class-based view base classes
const CBV_BASES = [
  'View',
  'TemplateView',
  'RedirectView',
  'ListView',
  'DetailView',
  'CreateView',
  'UpdateView',
  'DeleteView',
  'FormView',
  'APIView',
  'ModelViewSet',
  'ReadOnlyModelViewSet',
  'ViewSet',
  'GenericAPIView',
  'ListAPIView',
  'CreateAPIView',
  'RetrieveAPIView',
  'UpdateAPIView',
  'DestroyAPIView',
  'ListCreateAPIView',
  'RetrieveUpdateAPIView',
  'RetrieveDestroyAPIView',
  'RetrieveUpdateDestroyAPIView',
].join('|');

const CBV_RE = new RegExp(
  `^class\\s+(\\w+)\\s*\\(([^)]*(?:${CBV_BASES})[^)]*)\\)\\s*:`,
  'gm',
);

// FBV decorators that mark a function as a view
const FBV_DECORATOR_RE =
  /^[ \t]*@(?:login_required|permission_required|api_view|staff_member_required|user_passes_test)\s*[(\n]/gm;

function extractViews(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Class-based views
  CBV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CBV_RE.exec(sourceStr)) !== null) {
    const name = m[1]!;
    symbols.push({
      id: makeId(filePath, name, 'view'),
      name,
      kind: 'view',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: m[0]!.trim(),
      summary: `Django CBV: ${name}`,
      frameworkMeta: { django_cbv: true },
    });
  }

  // Function-based views — find decorated functions
  FBV_DECORATOR_RE.lastIndex = 0;
  while ((m = FBV_DECORATOR_RE.exec(sourceStr)) !== null) {
    // Find the `def name(` on the next non-decorator, non-blank line
    const rest = sourceStr.slice(m.index + m[0]!.length);
    const fnMatch = rest.match(/(?:^|\n)[ \t]*(?:@\w[^\n]*\n)*[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!fnMatch) continue;
    const name = fnMatch[1]!;
    // Avoid duplicates
    if (!symbols.some((s) => s.name === name && s.kind === 'view')) {
      symbols.push({
        id: makeId(filePath, name, 'view'),
        name,
        kind: 'view',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `def ${name}(request, ...)`,
        summary: `Django FBV: ${name}`,
        frameworkMeta: { django_fbv: true },
      });
    }
  }

  return symbols;
}

// ─── URL pattern extraction ───────────────────────────────────────────────────

/**
 * Normalise Django URL path to :param format.
 * e.g.  <int:pk>  → :pk
 *       <slug>    → :slug
 *       (?P<pk>\d+) (re_path) → :pk
 */
function normaliseUrlPath(path: string): string {
  // Django 2+ angle-bracket params: <type:name> or <name>
  let result = path.replace(/<(?:[a-zA-Z_][a-zA-Z0-9_]*:)?([a-zA-Z_][a-zA-Z0-9_]*)>/g, ':$1');
  // Legacy regex named groups: (?P<name>...)
  result = result.replace(/\(\?P<([^>]+)>[^)]*\)/g, ':$1');
  return result;
}

// Match path(...), re_path(...), url(...) at module level or inside urlpatterns
const URL_PATTERN_RE =
  /\b(?:path|re_path|url)\s*\(\s*r?(['"])([^'"]*)\1\s*,/g;

function extractUrlPatterns(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  URL_PATTERN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_PATTERN_RE.exec(sourceStr)) !== null) {
    const rawPath = m[2]!;
    const normPath = normaliseUrlPath(rawPath);
    const routeName = normPath || '/';

    if (seen.has(routeName)) continue;
    seen.add(routeName);

    symbols.push({
      id: makeId(filePath, routeName, 'route'),
      name: routeName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: m[0]!.trim().slice(0, 100),
      summary: `Django URL: ${routeName}`,
      frameworkMeta: {
        django_url_pattern: true,
        route_path: rawPath,
      },
    });
  }

  return symbols;
}

// ─── Signal extraction ────────────────────────────────────────────────────────

const SIGNAL_RE =
  /^[ \t]*@receiver\s*\(\s*(\w[\w.]*)\s*(?:,|\))[^\n]*\n(?:[ \t]*@[^\n]+\n)*[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm;

function extractSignals(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  SIGNAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SIGNAL_RE.exec(sourceStr)) !== null) {
    const signal = m[1]!;
    const name = m[2]!;
    symbols.push({
      id: makeId(filePath, name, 'signal'),
      name,
      kind: 'signal',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `@receiver(${signal}) def ${name}(...)`,
      summary: `Django signal receiver: ${name} (${signal})`,
      frameworkMeta: { django_signal: true, signal_type: signal },
    });
  }
  return symbols;
}

// ─── Django adapter ───────────────────────────────────────────────────────────

export const djangoAdapter: FrameworkAdapter = {
  name: 'django',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // manage.py at project root is the canonical Django marker
    if (existsSync(join(projectRoot, 'manage.py'))) return true;

    try {
      const req = readFileSync(join(projectRoot, 'requirements.txt'), 'utf8');
      if (/^\s*[Dd]jango\b/m.test(req)) return true;
    } catch { /* absent */ }

    try {
      const toml = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8');
      if (/["']django\b/i.test(toml)) return true;
    } catch { /* absent */ }

    return false;
  },

  fileFilter: (filePath: string): boolean => {
    if (!filePath.endsWith('.py')) return false;
    const base = filePath.split('/').pop()!;
    return base !== 'manage.py';
  },

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    if (!hasDjangoImport(sourceStr)) return [];

    const symbols: SymbolRecord[] = [
      ...extractModels(sourceStr, filePath),
      ...extractViews(sourceStr, filePath),
      ...extractSignals(sourceStr, filePath),
    ];

    // URL patterns only from urls.py files
    const fileName = basename(filePath);
    if (fileName === 'urls.py' || filePath.endsWith('/urls.py')) {
      symbols.push(...extractUrlPatterns(sourceStr, filePath));
    }

    return symbols;
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(djangoAdapter);
logger.debug("Adapter 'django' registered");
