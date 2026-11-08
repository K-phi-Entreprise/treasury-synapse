'use strict';
/* Applies db/schema.sql. Every statement is idempotent, so running it on every deploy is safe. */
const fs = require('fs');
const path = require('path');
const { makePool } = require('./db');

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  const pool = makePool();
  migrate(pool).then(() => { console.log('schema applied'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrate };
