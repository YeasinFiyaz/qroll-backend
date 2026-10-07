// Creates any missing QRoll tables. Existing tables and data are left untouched.
const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) await db.query(stmt);
  console.log(`Schema OK (${statements.length} tables checked).`);
  await db.end();
})().catch((err) => {
  console.error('init-db failed:', err.message);
  process.exit(1);
});
