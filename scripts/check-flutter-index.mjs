import Database from 'better-sqlite3';
const db = new Database(process.env.USERPROFILE + '\\.purecontext\\indexes\\bd922deab6dc29cf.db', { readonly: true });

const files = [
  'packages/flutter/lib/src/widgets/framework.dart',
  'packages/flutter/lib/src/animation/animation_controller.dart',
  'packages/flutter/lib/src/material/scaffold.dart',
  'packages/flutter/lib/src/rendering/box.dart',
];
for (const f of files) {
  const r = db.prepare('SELECT COUNT(*) as n FROM symbols WHERE file_path = ?').get(f);
  console.log(`${f}: ${r.n} symbols`);
}

// Top dirs by symbol count
const dirs = db.prepare(
  `SELECT substr(file_path, 1, instr(file_path, '/') - 1) as dir, COUNT(*) as n
   FROM symbols GROUP BY dir ORDER BY n DESC LIMIT 10`
).all();
console.log('\nTop dirs:');
dirs.forEach(d => console.log(`  ${d.dir}: ${d.n}`));
db.close();
