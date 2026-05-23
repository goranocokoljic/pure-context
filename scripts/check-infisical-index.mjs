#!/usr/bin/env node
// Quick check of infisical index
import { openDatabase } from '../dist/core/db/schema.js';
import { computeRepoId } from '../dist/core/index-manager.js';
import { resolve } from 'path';

const repoId = computeRepoId(resolve('d:/private/PureContext Benchmarking Projects/React/infisical'));
const db = openDatabase();
const r1 = db.prepare('SELECT name, file_path FROM symbols WHERE repo_id = ? AND name LIKE ? LIMIT 5').all(repoId, '%fetchProjectSecrets%');
console.log('fetchProjectSecrets:', JSON.stringify(r1));
const r2 = db.prepare('SELECT name, file_path FROM symbols WHERE repo_id = ? AND name LIKE ? LIMIT 5').all(repoId, '%useCreateSecretV3%');
console.log('useCreateSecretV3:', JSON.stringify(r2));
const r3 = db.prepare('SELECT COUNT(1) as cnt FROM symbols WHERE repo_id = ?').get(repoId);
console.log('total:', r3.cnt);
const r4 = db.prepare("SELECT name, file_path FROM symbols WHERE repo_id = ? AND file_path LIKE '%queries%' LIMIT 5").all(repoId);
console.log('queries files:', JSON.stringify(r4));
db.close();
