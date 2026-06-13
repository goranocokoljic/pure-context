/**
 * co-change.test.ts
 *
 * Tests getCoChange (Phase 76 temporal-coupling scoring):
 *   (a) a clean 2-file co-change pair ranks top,
 *   (b) a 40-file mega-commit is excluded,
 *   (c) a coincidental single shared commit falls below minSupport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertCommitFiles } from '../../src/core/db/co-change-store.js';
import { getCoChange } from '../../src/server/tools/co-change.js';
import type { RepoCommit } from '../../src/core/git-log-reader.js';

const REPO = 'co-change-query-repo';

function seed(db: Database, commits: RepoCommit[]) {
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/cc-query',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  });
  insertCommitFiles(db, REPO, commits);
}

describe('getCoChange', () => {
  let db: Database;
  beforeEach(() => { db = openInMemoryDatabase(); });
  afterEach(() => db.close());

  it('ranks the clean pair top, excludes mega-commit, drops the coincidence', () => {
    const commits: RepoCommit[] = [];
    // (a) Clean pair: target.ts + partner.ts change together 6 times (2-file commits).
    for (let i = 0; i < 6; i++) {
      commits.push({ sha: `pair${i}`, date: 1000 + i, files: ['target.ts', 'partner.ts'] });
    }
    // (b) One 40-file mega-commit that also touches target.ts + noise files.
    const megaFiles = ['target.ts', ...Array.from({ length: 39 }, (_, i) => `mega${i}.ts`)];
    commits.push({ sha: 'mega', date: 2000, files: megaFiles });
    // (c) One coincidental shared commit: target.ts + coincidence.ts, just once.
    commits.push({ sha: 'coinc', date: 3000, files: ['target.ts', 'coincidence.ts'] });
    // Padding so windowCommits >= 20 (signalQuality ok).
    for (let i = 0; i < 20; i++) {
      commits.push({ sha: `pad${i}`, date: 4000 + i, files: [`pad${i}.ts`] });
    }

    seed(db, commits);
    const res = getCoChange(db, REPO, 'target.ts', { minSupport: 2, megaCommitThreshold: 30 });

    // The clean pair ranks first.
    expect(res.partners[0].filePath).toBe('partner.ts');
    expect(res.partners[0].support).toBe(6);
    expect(res.partners[0].confidence).toBeGreaterThan(0);

    const files = res.partners.map((p) => p.filePath);
    // Mega-commit noise files are excluded entirely.
    expect(files.some((f) => f.startsWith('mega'))).toBe(false);
    // The single coincidence is below minSupport=2.
    expect(files).not.toContain('coincidence.ts');
  });

  it('flags low signal quality on sparse/shallow histories', () => {
    seed(db, [
      { sha: 'x1', date: 1, files: ['a.ts', 'b.ts'] },
      { sha: 'x2', date: 2, files: ['a.ts', 'b.ts'] },
    ]);
    const res = getCoChange(db, REPO, 'a.ts');
    expect(res.signalQuality).toBe('low');
  });

  it('returns empty partners for an unknown file', () => {
    seed(db, [{ sha: 'x', date: 1, files: ['a.ts', 'b.ts'] }]);
    const res = getCoChange(db, REPO, 'nonexistent.ts');
    expect(res.partners).toEqual([]);
  });

  it('down-weights mega-commit shared commits below focused ones', () => {
    // partnerA shares 3 focused 2-file commits; partnerB shares 3 commits that
    // are each 11-file commits (k=11 → weight 0.1) — A should outrank B.
    const commits: RepoCommit[] = [];
    for (let i = 0; i < 3; i++) {
      commits.push({ sha: `a${i}`, date: 10 + i, files: ['t.ts', 'A.ts'] });
    }
    for (let i = 0; i < 3; i++) {
      const noise = Array.from({ length: 9 }, (_, j) => `n${i}_${j}.ts`);
      commits.push({ sha: `b${i}`, date: 20 + i, files: ['t.ts', 'B.ts', ...noise] });
    }
    for (let i = 0; i < 20; i++) commits.push({ sha: `p${i}`, date: 100 + i, files: [`p${i}.ts`] });

    seed(db, commits);
    const res = getCoChange(db, REPO, 't.ts', { minSupport: 2, megaCommitThreshold: 30 });
    const a = res.partners.find((p) => p.filePath === 'A.ts');
    const b = res.partners.find((p) => p.filePath === 'B.ts');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.weightedSupport).toBeGreaterThan(b!.weightedSupport);
  });
});
