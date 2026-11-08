'use strict';
/* One pool for the server and the scripts. DATABASE_URL comes from Render (or a local Postgres in tests). */
const { Pool } = require('pg');

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const ssl = /render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false;
  return new Pool({ connectionString: url, ssl, max: 8 });
}

module.exports = { makePool };
