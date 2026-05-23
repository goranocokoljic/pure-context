import Database from 'better-sqlite3';
const dbPath = process.env.USERPROFILE + '\\.purecontext\\indexes\\bd922deab6dc29cf.db';
try {
  const db = new Database(dbPath);
  const result = db.pragma('wal_checkpoint(PASSIVE)');
  console.log('WAL checkpoint result:', JSON.stringify(result));
  const size = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  console.log('DB size after checkpoint:', Math.round(size / 1024 / 1024), 'MB');
  db.close();
} catch(e) {
  console.error('Failed:', e.message);
}
