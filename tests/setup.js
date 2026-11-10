'use strict';
/* Each suite starts from a migrated, seeded store, whatever order the runner picks. */
const path = require('path');
const { makePool } = require('../scripts/db');
const { migrate } = require('../scripts/migrate');
const { importDump } = require('../scripts/import');

async function ready({ reset } = {}) {
  const pool = makePool();
  if (reset) await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  await importDump(pool, require(path.join(__dirname, '..', 'data', 'seed', 'dump.json')), { ifEmpty: !reset });
  await pool.end();
}
module.exports = { ready };
