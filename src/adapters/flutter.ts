/**
 * Flutter framework adapter.
 *
 * Detects Flutter projects via pubspec.yaml containing 'flutter'.
 * Reclassifies Dart class symbols:
 *   - StatelessWidget / StatefulWidget / State / InheritedWidget / RenderObject
 *     subclasses → kind 'widget'
 *   - @immutable annotated classes → kind 'class' with flutter_immutable meta
 *   - ChangeNotifier / Listenable / ValueNotifier subclasses → kind 'class'
 *     with flutter_notifier meta
 *
 * For StatefulWidget subclasses the associated State<T> class is found in the
 * same file and linked via frameworkMeta.state_class.
 *
 * Test files (*_test.dart) are excluded.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { extname } from 'path';
import type { FrameworkAdapter, SymbolRecord, SyntaxNode, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

function nodeText(node: SyntaxNode, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

// ─── Widget base-class sets ───────────────────────────────────────────────────

type WidgetType = 'stateless' | 'stateful' | 'state' | 'inherited' | 'render';

const WIDGET_BASES = new Map<string, WidgetType>([
  ['StatelessWidget', 'stateless'],
  ['StatefulWidget', 'stateful'],
  ['State', 'state'],
  ['InheritedWidget', 'inherited'],
  ['RenderObject', 'render'],
  ['RenderBox', 'render'],
  ['RenderSliver', 'render'],
]);

const NOTIFIER_BASES = new Set([
  'ChangeNotifier',
  'ValueNotifier',
  'Listenable',
]);

// ─── AST helpers ──────────────────────────────────────────────────────────────

interface ClassInfo {
  node: SyntaxNode;
  name: string;
  baseType: string;         // direct superclass name (e.g. 'State', 'StatelessWidget')
  typeArg: string | null;   // first type argument of superclass (e.g. 'HomeScreen' for State<HomeScreen>)
  hasImmutable: boolean;
}

/**
 * Walk backwards through named siblings from a node to detect @immutable
 * annotation (appears as marker_annotation or annotation before the class).
 */
function hasImmutableAnnotation(classNode: SyntaxNode): boolean {
  let prev = classNode.previousNamedSibling;
  while (prev !== null) {
    const t = prev.type;
    if (t === 'marker_annotation') {
      const id = prev.children.find((c) => c.isNamed && c.type === 'identifier');
      if (id && id.text === 'immutable') return true;
      // Keep walking back — there may be stacked annotations
    } else if (t === 'annotation') {
      // @ with arguments, e.g. @Deprecated('...')
      // Keep walking
    } else if (t !== 'documentation_comment' && t !== 'comment') {
      // Hit something that isn't an annotation or comment — stop
      break;
    }
    prev = prev.previousNamedSibling;
  }
  return false;
}

/**
 * Extract information from a single class_definition node.
 */
function extractClassInfo(node: SyntaxNode, src: string): ClassInfo | null {
  const nameNode = node.children.find((c) => c.isNamed && c.type === 'identifier');
  if (!nameNode) return null;
  const name = nodeText(nameNode, src);

  // Superclass: superclass node → type_identifier (+ optional type_arguments)
  const superclassNode = node.children.find((c) => c.isNamed && c.type === 'superclass');
  let baseType = '';
  let typeArg: string | null = null;

  if (superclassNode) {
    const typeIdNode = superclassNode.children.find(
      (c) => c.isNamed && c.type === 'type_identifier',
    );
    if (typeIdNode) {
      baseType = nodeText(typeIdNode, src);

      // Extract first type argument (for State<WidgetClass>)
      const typeArgsNode = superclassNode.children.find(
        (c) => c.isNamed && c.type === 'type_arguments',
      );
      if (typeArgsNode) {
        const firstArg = typeArgsNode.children.find(
          (c) => c.isNamed && c.type === 'type_identifier',
        );
        if (firstArg) typeArg = nodeText(firstArg, src);
      }
    }
  }

  return {
    node,
    name,
    baseType,
    typeArg,
    hasImmutable: hasImmutableAnnotation(node),
  };
}

/**
 * Collect ClassInfo for every class_definition at the top level of the tree.
 */
function collectClasses(tree: Tree, src: string): ClassInfo[] {
  const result: ClassInfo[] = [];
  for (const node of tree.rootNode.children) {
    if (node.isNamed && node.type === 'class_definition') {
      const info = extractClassInfo(node, src);
      if (info) result.push(info);
    }
  }
  return result;
}

/**
 * Build a one-line class signature from the declaration (everything up to '{').
 */
function classSignature(node: SyntaxNode, src: string): string {
  const text = nodeText(node, src);
  const brace = text.indexOf('{');
  const declLine = (brace >= 0 ? text.slice(0, brace) : text).replace(/\s+/g, ' ').trim();
  return declLine.length > 120 ? declLine.slice(0, 117) + '...' : declLine;
}

// ─── Flutter adapter ──────────────────────────────────────────────────────────

export const flutterAdapter: FrameworkAdapter = {
  name: 'flutter',

  /** .dart files are already handled by the Dart handler — no new extension needed. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const content = readFileSync(`${projectRoot}/pubspec.yaml`, 'utf8');
      return content.includes('flutter');
    } catch {
      return false;
    }
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string) =>
    extname(filePath) === '.dart' && !filePath.endsWith('_test.dart'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    if (!tree) return [];

    // Test files are excluded
    if (filePath.endsWith('_test.dart')) return [];

    const src = source.toString('utf8');
    const classes = collectClasses(tree, src);
    const symbols: SymbolRecord[] = [];

    // Build lookup: widget name → state class name (for StatefulWidget linking)
    // State<HomeScreen> → state class name that extends it
    const stateForWidget = new Map<string, string>(); // widgetName → stateClassName
    for (const info of classes) {
      if (info.baseType === 'State' && info.typeArg) {
        stateForWidget.set(info.typeArg, info.name);
      }
    }

    for (const info of classes) {
      const { node, name, baseType, typeArg, hasImmutable } = info;

      // ── Widget classes (StatelessWidget, StatefulWidget, State, etc.) ─────
      const widgetType = WIDGET_BASES.get(baseType);
      if (widgetType) {
        // State classes are conventionally private (_WidgetState) — include them
        const meta: Record<string, unknown> = {
          flutter_widget: true,
          flutter_widget_type: widgetType,
        };

        // Link StatefulWidget to its State class
        if (widgetType === 'stateful') {
          const stateClass = stateForWidget.get(name);
          if (stateClass) meta['state_class'] = stateClass;
        }

        // Link State<T> back to its widget
        if (widgetType === 'state' && typeArg) {
          meta['widget_class'] = typeArg;
        }

        symbols.push({
          id: makeId(filePath, name, 'widget'),
          name,
          kind: 'widget',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: classSignature(node, src),
          summary: `Flutter ${widgetType} widget: ${name}`,
          frameworkMeta: meta,
        });
        continue;
      }

      // ── ChangeNotifier / Listenable / ValueNotifier ────────────────────────
      if (NOTIFIER_BASES.has(baseType)) {
        if (name.startsWith('_')) continue; // skip private notifiers

        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: classSignature(node, src),
          summary: `Flutter notifier: ${name}`,
          frameworkMeta: {
            flutter_notifier: true,
            notifier_base: baseType,
          },
        });
        continue;
      }

      // ── @immutable annotated classes ───────────────────────────────────────
      if (hasImmutable) {
        if (name.startsWith('_')) continue; // skip private

        symbols.push({
          id: makeId(filePath, name, 'class'),
          name,
          kind: 'class',
          filePath,
          startByte: node.startIndex,
          endByte: node.endIndex,
          signature: classSignature(node, src),
          summary: `Flutter immutable class: ${name}`,
          frameworkMeta: {
            flutter_immutable: true,
          },
        });
      }
    }

    return symbols;
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  /**
   * Never downgrade a 'widget' symbol to 'class'. Leave plain Dart classes
   * as-is even if their name ends in 'Widget' — the inheritance check is the
   * authoritative signal, not the name.
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    // Preserve any widget kind already set
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(flutterAdapter);
logger.debug("Adapter 'flutter' registered");
