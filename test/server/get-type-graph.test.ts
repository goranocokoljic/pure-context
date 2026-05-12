/**
 * Tests for the get_type_graph tool (Task 199).
 *
 * Fixture: test/fixtures/get-type-graph-fixture/
 *
 *   src/types/base.ts        — Identifiable (interface), Timestamped (interface),
 *                              BaseEntity (interface extends Identifiable, Timestamped)
 *   src/types/user.ts        — User (interface extends BaseEntity),
 *                              AdminUser (interface extends User)
 *   src/types/repository.ts  — Repository<T> (interface),
 *                              UserRepository (interface extends Repository)
 *   src/utils/types.ts       — UserId (type), Status (type),
 *                              AdminPermission (type), UserRole (enum), EventType (enum)
 *   src/models/entity.ts     — Entity (abstract class implements Identifiable)
 *   src/models/user-model.ts — UserModel (class extends Entity implements User)
 *   src/models/admin-model.ts— AdminModel (class extends UserModel implements AdminUser)
 *   src/services/service.ts  — Service<T> (interface)
 *   src/services/user-service.ts — UserService (class implements Service)
 *   src/index.ts             — re-exports only
 *
 * Expected relationships:
 *   BaseEntity   extends  Identifiable, Timestamped
 *   User         extends  BaseEntity
 *   AdminUser    extends  User
 *   UserRepository extends Repository
 *   Entity       implements Identifiable
 *   UserModel    extends Entity, implements User
 *   AdminModel   extends UserModel, implements AdminUser
 *   UserService  implements Service
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getTypeGraphHandler } from '../../src/server/tools/get-type-graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-type-graph-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface TypeNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  signature: string;
  summary: string;
  isAbstract: boolean;
  isGeneric: boolean;
}

interface TypeEdge {
  source: string;
  target: string;
  relation: 'extends' | 'implements';
  targetName: string;
  resolved: boolean;
}

interface TypeGraphOutput {
  repoId: string;
  rootSymbolId: string | null;
  nodes: TypeNode[];
  edges: TypeEdge[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    resolvedEdgeCount: number;
    unresolvedEdgeCount: number;
    relationTypes: string[];
  };
  mermaid?: string;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getTypeGraph(args: {
  repoId?: string;
  rootSymbol?: string;
  maxDepth?: number;
  scope?: string;
  kinds?: Array<'interface' | 'class' | 'type' | 'enum'>;
  includeAbstract?: boolean;
  format?: 'graph' | 'mermaid';
  limit?: number;
}): Promise<TypeGraphOutput> {
  const result = await getTypeGraphHandler({
    repoId: args.repoId ?? repoId,
    ...args,
  });
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content[0] as { type: string; text: string }).text);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_type_graph', () => {

  // ── Output structure ───────────────────────────────────────────────────────

  describe('output structure', () => {
    it('returns required top-level fields', async () => {
      const out = await getTypeGraph({});
      expect(out.repoId).toBe(repoId);
      expect(out.rootSymbolId).toBeNull();
      expect(Array.isArray(out.nodes)).toBe(true);
      expect(Array.isArray(out.edges)).toBe(true);
      expect(out.summary).toBeDefined();
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeDefined();
    });

    it('returns required summary fields', async () => {
      const out = await getTypeGraph({});
      expect(typeof out.summary.nodeCount).toBe('number');
      expect(typeof out.summary.edgeCount).toBe('number');
      expect(typeof out.summary.resolvedEdgeCount).toBe('number');
      expect(typeof out.summary.unresolvedEdgeCount).toBe('number');
      expect(Array.isArray(out.summary.relationTypes)).toBe(true);
    });

    it('nodeCount matches nodes array length', async () => {
      const out = await getTypeGraph({});
      expect(out.summary.nodeCount).toBe(out.nodes.length);
    });

    it('edgeCount matches edges array length', async () => {
      const out = await getTypeGraph({});
      expect(out.summary.edgeCount).toBe(out.edges.length);
    });

    it('resolvedEdgeCount + unresolvedEdgeCount equals edgeCount', async () => {
      const out = await getTypeGraph({});
      expect(out.summary.resolvedEdgeCount + out.summary.unresolvedEdgeCount)
        .toBe(out.summary.edgeCount);
    });

    it('nodes have all required fields', async () => {
      const out = await getTypeGraph({});
      expect(out.nodes.length).toBeGreaterThan(0);
      for (const node of out.nodes) {
        expect(typeof node.id).toBe('string');
        expect(typeof node.name).toBe('string');
        expect(typeof node.kind).toBe('string');
        expect(typeof node.filePath).toBe('string');
        expect(typeof node.signature).toBe('string');
        expect(typeof node.summary).toBe('string');
        expect(typeof node.isAbstract).toBe('boolean');
        expect(typeof node.isGeneric).toBe('boolean');
      }
    });

    it('edges have all required fields', async () => {
      const out = await getTypeGraph({});
      for (const edge of out.edges) {
        expect(typeof edge.source).toBe('string');
        expect(typeof edge.target).toBe('string');
        expect(['extends', 'implements']).toContain(edge.relation);
        expect(typeof edge.targetName).toBe('string');
        expect(typeof edge.resolved).toBe('boolean');
      }
    });
  });

  // ── Node discovery ─────────────────────────────────────────────────────────

  describe('node discovery', () => {
    it('finds all expected interfaces', async () => {
      const out = await getTypeGraph({ kinds: ['interface'] });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('Identifiable');
      expect(names).toContain('Timestamped');
      expect(names).toContain('BaseEntity');
      expect(names).toContain('User');
      expect(names).toContain('AdminUser');
      expect(names).toContain('Repository');
      expect(names).toContain('UserRepository');
      expect(names).toContain('Service');
    });

    it('finds all expected classes', async () => {
      const out = await getTypeGraph({ kinds: ['class'] });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('Entity');
      expect(names).toContain('UserModel');
      expect(names).toContain('AdminModel');
      expect(names).toContain('UserService');
    });

    it('finds type aliases', async () => {
      const out = await getTypeGraph({ kinds: ['type'] });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('UserId');
      expect(names).toContain('Status');
      expect(names).toContain('AdminPermission');
    });

    it('finds enums', async () => {
      const out = await getTypeGraph({ kinds: ['enum'] });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('UserRole');
      expect(names).toContain('EventType');
    });

    it('all nodes have valid kind values', async () => {
      const out = await getTypeGraph({});
      const validKinds = new Set(['interface', 'class', 'type', 'enum']);
      for (const node of out.nodes) {
        expect(validKinds.has(node.kind)).toBe(true);
      }
    });

    it('Entity is marked as abstract', async () => {
      const out = await getTypeGraph({ kinds: ['class'] });
      const entity = out.nodes.find((n) => n.name === 'Entity');
      expect(entity).toBeDefined();
      expect(entity!.isAbstract).toBe(true);
    });

    it('UserModel is not abstract', async () => {
      const out = await getTypeGraph({ kinds: ['class'] });
      const userModel = out.nodes.find((n) => n.name === 'UserModel');
      expect(userModel).toBeDefined();
      expect(userModel!.isAbstract).toBe(false);
    });

    it('generic types are flagged isGeneric=true', async () => {
      const out = await getTypeGraph({ kinds: ['interface'] });
      const repo = out.nodes.find((n) => n.name === 'Repository');
      // Repository<T> has a generic parameter
      expect(repo).toBeDefined();
      expect(repo!.isGeneric).toBe(true);
    });
  });

  // ── Edge detection ─────────────────────────────────────────────────────────

  describe('edge detection', () => {
    it('detects BaseEntity extends Identifiable', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'Identifiable' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'BaseEntity',
      );
      expect(edge).toBeDefined();
    });

    it('detects User extends BaseEntity', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'BaseEntity' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'User',
      );
      expect(edge).toBeDefined();
    });

    it('detects AdminUser extends User', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'User' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'AdminUser',
      );
      expect(edge).toBeDefined();
    });

    it('detects Entity implements Identifiable', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'implements' && e.targetName === 'Identifiable' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'Entity',
      );
      expect(edge).toBeDefined();
    });

    it('detects UserModel extends Entity', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'Entity' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'UserModel',
      );
      expect(edge).toBeDefined();
    });

    it('detects UserModel implements User', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'implements' && e.targetName === 'User' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'UserModel',
      );
      expect(edge).toBeDefined();
    });

    it('detects AdminModel extends UserModel', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'UserModel' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'AdminModel',
      );
      expect(edge).toBeDefined();
    });

    it('detects AdminModel implements AdminUser', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'implements' && e.targetName === 'AdminUser' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'AdminModel',
      );
      expect(edge).toBeDefined();
    });

    it('detects UserRepository extends Repository', async () => {
      const out = await getTypeGraph({});
      const edge = out.edges.find(
        (e) => e.relation === 'extends' && e.targetName === 'Repository' &&
          out.nodes.find((n) => n.id === e.source)?.name === 'UserRepository',
      );
      expect(edge).toBeDefined();
    });

    it('resolved edges point to valid node IDs', async () => {
      const out = await getTypeGraph({});
      const nodeIds = new Set(out.nodes.map((n) => n.id));
      for (const edge of out.edges.filter((e) => e.resolved)) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    });

    it('summary relationTypes includes both extends and implements', async () => {
      const out = await getTypeGraph({});
      expect(out.summary.relationTypes).toContain('extends');
      expect(out.summary.relationTypes).toContain('implements');
    });
  });

  // ── kinds filter ───────────────────────────────────────────────────────────

  describe('kinds filter', () => {
    it('kinds=["interface"] returns only interface nodes', async () => {
      const out = await getTypeGraph({ kinds: ['interface'] });
      for (const node of out.nodes) {
        expect(node.kind).toBe('interface');
      }
    });

    it('kinds=["class"] returns only class nodes', async () => {
      const out = await getTypeGraph({ kinds: ['class'] });
      for (const node of out.nodes) {
        expect(node.kind).toBe('class');
      }
    });

    it('kinds=["enum"] returns only enum nodes', async () => {
      const out = await getTypeGraph({ kinds: ['enum'] });
      for (const node of out.nodes) {
        expect(node.kind).toBe('enum');
      }
    });

    it('kinds=["type","enum"] returns only type and enum nodes', async () => {
      const out = await getTypeGraph({ kinds: ['type', 'enum'] });
      for (const node of out.nodes) {
        expect(['type', 'enum']).toContain(node.kind);
      }
    });

    it('full default returns more nodes than kinds=["interface"] alone', async () => {
      const all = await getTypeGraph({});
      const ifacesOnly = await getTypeGraph({ kinds: ['interface'] });
      expect(all.nodes.length).toBeGreaterThan(ifacesOnly.nodes.length);
    });
  });

  // ── scope parameter ────────────────────────────────────────────────────────

  describe('scope parameter', () => {
    it('scope restricts nodes to that directory', async () => {
      const out = await getTypeGraph({ scope: 'src/types' });
      for (const node of out.nodes) {
        expect(node.filePath.startsWith('src/types')).toBe(true);
      }
    });

    it('scope=src/models returns only model nodes', async () => {
      const out = await getTypeGraph({ scope: 'src/models' });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('Entity');
      expect(names).toContain('UserModel');
      expect(names).toContain('AdminModel');
      for (const node of out.nodes) {
        expect(node.filePath.startsWith('src/models')).toBe(true);
      }
    });

    it('scope to non-existent directory returns 0 nodes', async () => {
      const out = await getTypeGraph({ scope: 'src/does-not-exist' });
      expect(out.nodes.length).toBe(0);
      expect(out.edges.length).toBe(0);
    });

    it('scope=src/utils returns type aliases and enums', async () => {
      const out = await getTypeGraph({ scope: 'src/utils' });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('UserId');
      expect(names).toContain('UserRole');
    });
  });

  // ── rootSymbol traversal ───────────────────────────────────────────────────

  describe('rootSymbol traversal', () => {
    it('rootSymbol sets rootSymbolId in output', async () => {
      const out = await getTypeGraph({ rootSymbol: 'User' });
      expect(out.rootSymbolId).not.toBeNull();
      expect(typeof out.rootSymbolId).toBe('string');
    });

    it('rootSymbol=User includes User in nodes', async () => {
      const out = await getTypeGraph({ rootSymbol: 'User' });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('User');
    });

    it('rootSymbol=User with maxDepth=1 includes direct neighbours', async () => {
      const out = await getTypeGraph({ rootSymbol: 'User', maxDepth: 1 });
      const names = out.nodes.map((n) => n.name);
      // User's direct connections: BaseEntity (extends), AdminUser (extends User), UserModel (implements User)
      expect(names.length).toBeGreaterThan(1);
    });

    it('rootSymbol traversal returns fewer nodes than full graph', async () => {
      const all = await getTypeGraph({});
      const rooted = await getTypeGraph({ rootSymbol: 'Service', maxDepth: 1 });
      expect(rooted.nodes.length).toBeLessThan(all.nodes.length);
    });

    it('rootSymbol by name resolves correctly', async () => {
      const out = await getTypeGraph({ rootSymbol: 'AdminModel' });
      const root = out.nodes.find((n) => n.id === out.rootSymbolId);
      expect(root).toBeDefined();
      expect(root!.name).toBe('AdminModel');
    });

    it('rootSymbol=unknown returns error', async () => {
      const result = await getTypeGraphHandler({ repoId, rootSymbol: 'DoesNotExist' });
      expect(result.isError).toBe(true);
    });
  });

  // ── includeAbstract ────────────────────────────────────────────────────────

  describe('includeAbstract parameter', () => {
    it('includeAbstract=true (default) includes abstract Entity class', async () => {
      const out = await getTypeGraph({ kinds: ['class'], includeAbstract: true });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('Entity');
    });

    it('includeAbstract=false excludes abstract Entity class', async () => {
      const out = await getTypeGraph({ kinds: ['class'], includeAbstract: false });
      const names = out.nodes.map((n) => n.name);
      expect(names).not.toContain('Entity');
    });

    it('includeAbstract=false keeps concrete classes', async () => {
      const out = await getTypeGraph({ kinds: ['class'], includeAbstract: false });
      const names = out.nodes.map((n) => n.name);
      expect(names).toContain('UserModel');
      expect(names).toContain('AdminModel');
    });
  });

  // ── limit parameter ────────────────────────────────────────────────────────

  describe('limit parameter', () => {
    it('limit=1 returns at most 1 node', async () => {
      const out = await getTypeGraph({ limit: 1 });
      expect(out.nodes.length).toBeLessThanOrEqual(1);
    });

    it('limit=3 returns at most 3 nodes', async () => {
      const out = await getTypeGraph({ limit: 3 });
      expect(out.nodes.length).toBeLessThanOrEqual(3);
    });

    it('limit larger than total node count returns all nodes', async () => {
      const all = await getTypeGraph({});
      const limited = await getTypeGraph({ limit: 500 });
      expect(limited.nodes.length).toBe(all.nodes.length);
    });
  });

  // ── mermaid format ─────────────────────────────────────────────────────────

  describe('mermaid format', () => {
    it('format=mermaid includes mermaid field', async () => {
      const out = await getTypeGraph({ format: 'mermaid' });
      expect(typeof out.mermaid).toBe('string');
    });

    it('mermaid output starts with classDiagram', async () => {
      const out = await getTypeGraph({ format: 'mermaid' });
      expect(out.mermaid!.trim()).toMatch(/^classDiagram/);
    });

    it('mermaid includes interface annotation for User', async () => {
      const out = await getTypeGraph({ format: 'mermaid', kinds: ['interface'] });
      expect(out.mermaid).toContain('<<interface>>');
    });

    it('mermaid includes enumeration annotation for enums', async () => {
      const out = await getTypeGraph({ format: 'mermaid', kinds: ['enum'] });
      expect(out.mermaid).toContain('<<enumeration>>');
    });

    it('mermaid includes extends arrow syntax (--|>)', async () => {
      const out = await getTypeGraph({
        format: 'mermaid',
        scope: 'src/types',
      });
      expect(out.mermaid).toContain('--|>');
    });

    it('mermaid includes implements arrow syntax (..|>)', async () => {
      const out = await getTypeGraph({
        format: 'mermaid',
        kinds: ['class', 'interface'],
      });
      expect(out.mermaid).toContain('..|>');
    });

    it('format=graph (default) does not include mermaid field', async () => {
      const out = await getTypeGraph({ format: 'graph' });
      expect(out.mermaid).toBeUndefined();
    });

    it('mermaid and graph nodes are consistent', async () => {
      const out = await getTypeGraph({ format: 'mermaid', kinds: ['interface'], scope: 'src/types' });
      // Every node name should appear in the mermaid string
      for (const node of out.nodes) {
        expect(out.mermaid).toContain(node.name);
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns error for unknown repoId', async () => {
      const result = await getTypeGraphHandler({ repoId: 'deadbeef00000000' });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns empty graph for valid repo with no type symbols (kinds=[])', async () => {
      // Using an empty kinds list is not allowed by schema, but scope with no matching files
      const out = await getTypeGraph({ scope: 'nonexistent/path' });
      expect(out.nodes.length).toBe(0);
      expect(out.edges.length).toBe(0);
    });
  });

  // ── Token estimate and meta ────────────────────────────────────────────────

  describe('token estimate and meta', () => {
    it('_tokenEstimate is a positive number', async () => {
      const out = await getTypeGraph({});
      expect(out._tokenEstimate).toBeGreaterThan(0);
    });

    it('_meta includes timing_ms', async () => {
      const out = await getTypeGraph({});
      expect(typeof out._meta.timing_ms).toBe('number');
      expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    });

    it('_meta includes powered_by', async () => {
      const out = await getTypeGraph({});
      expect(out._meta.powered_by).toBeTruthy();
    });
  });
});
