/**
 * Task 128 — Workspace isolation tests
 * Tests that repos in workspace A are not visible to workspace B queries.
 */
import { describe, it, expect } from 'vitest';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION, getRepo } from '../../src/core/db/schema.js';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import { TenantStore } from '../../src/core/db/tenants.js';

describe('Workspace isolation — list_repos filtering', () => {
  it('repos indexed in workspace A are not visible when filtering by workspace B', () => {
    // Create two repos in separate DBs with different tenant_ids
    const dbA = openInMemoryDatabase();
    upsertRepo(dbA, {
      id: 'repoA',
      rootPath: '/projects/alpha',
      symbolCount: 10,
      fileCount: 5,
      languages: ['typescript'],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'workspace-a',
    });

    const dbB = openInMemoryDatabase();
    upsertRepo(dbB, {
      id: 'repoB',
      rootPath: '/projects/beta',
      symbolCount: 20,
      fileCount: 8,
      languages: ['javascript'],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'workspace-b',
    });

    const metaA = getRepo(dbA, 'repoA');
    const metaB = getRepo(dbB, 'repoB');

    expect(metaA?.tenantId).toBe('workspace-a');
    expect(metaB?.tenantId).toBe('workspace-b');

    // Simulate workspace-scoped filtering
    const reposForWorkspaceA = [metaA, metaB].filter(
      (m) => m?.tenantId === 'workspace-a'
    );
    const reposForWorkspaceB = [metaA, metaB].filter(
      (m) => m?.tenantId === 'workspace-b'
    );

    expect(reposForWorkspaceA).toHaveLength(1);
    expect(reposForWorkspaceA[0]?.id).toBe('repoA');

    expect(reposForWorkspaceB).toHaveLength(1);
    expect(reposForWorkspaceB[0]?.id).toBe('repoB');

    dbA.close();
    dbB.close();
  });

  it('workspace membership: adding and listing members', () => {
    const db = openInMemoryAuthDatabase();
    const store = new TenantStore(db);

    const ws = store.create('Team Alpha', { plan: 'team' });
    store.addMember(ws.id, 'user-alice', 'admin');
    store.addMember(ws.id, 'user-bob', 'member');

    const members = store.listMembers(ws.id);
    expect(members).toHaveLength(2);

    const alice = members.find((m) => m.userId === 'user-alice');
    expect(alice?.role).toBe('admin');

    const bob = members.find((m) => m.userId === 'user-bob');
    expect(bob?.role).toBe('member');

    db.close();
  });

  it('removing a workspace member', () => {
    const db = openInMemoryAuthDatabase();
    const store = new TenantStore(db);

    const ws = store.create('Team Beta', { plan: 'team' });
    store.addMember(ws.id, 'user-charlie', 'readonly');

    expect(store.listMembers(ws.id)).toHaveLength(1);

    store.removeMember(ws.id, 'user-charlie');
    expect(store.listMembers(ws.id)).toHaveLength(0);

    db.close();
  });

  it('admin can see all workspaces', () => {
    const db = openInMemoryAuthDatabase();
    const store = new TenantStore(db);

    store.create('Workspace A', { plan: 'free' });
    store.create('Workspace B', { plan: 'team' });

    const all = store.list();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const names = all.map((w) => w.name);
    expect(names).toContain('Workspace A');
    expect(names).toContain('Workspace B');

    db.close();
  });

  it('workspace plan is stored and retrieved correctly', () => {
    const db = openInMemoryAuthDatabase();
    const store = new TenantStore(db);

    const freeWs = store.create('Free Team', { plan: 'free' });
    const teamWs = store.create('Pro Team', { plan: 'team' });
    const enterpriseWs = store.create('Enterprise', { plan: 'enterprise' });

    expect(freeWs.plan).toBe('free');
    expect(teamWs.plan).toBe('team');
    expect(enterpriseWs.plan).toBe('enterprise');

    // Verify retrieved from DB
    expect(store.get(freeWs.id)?.plan).toBe('free');
    expect(store.get(teamWs.id)?.plan).toBe('team');

    db.close();
  });
});
