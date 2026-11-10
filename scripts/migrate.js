'use strict';
/* Applies db/schema.sql. Every statement is idempotent, so running it on every deploy is safe. */
const fs = require('fs');
const path = require('path');
const { makePool } = require('./db');

/* On a first deploy the database can still be starting when this runs: wait for it (up to ~3 minutes). */
async function waitForDb(pool, { tries = 18, delayMs = 10000 } = {}) {
  for (let i = 1; ; i++) {
    try { await pool.query('select 1'); return; }
    catch (e) {
      if (i >= tries) throw e;
      console.log('database not reachable yet (' + (e.code || e.message) + '), retry ' + i + '/' + (tries - 1) + ' in ' + delayMs / 1000 + 's');
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function migrate(pool) {
  await waitForDb(pool);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  await require('./market').seed(pool);
}

if (require.main === module) {
  const pool = makePool();
  migrate(pool).then(() => { console.log('schema applied'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrate, waitForDb };
