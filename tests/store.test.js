'use strict';
/* Schema, importer and API against a real Postgres (DATABASE_URL). The seed dump is the one shipped in data/seed. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makePool } = require('../scripts/db');
const { migrate } = require('../scripts/migrate');
const { importDump } = require('../scripts/import');

const dump = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'dump.json'), 'utf8'));
let pool, server, base;

test.before(async () => {
  pool = makePool();
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  const { app } = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); const s = require('../server'); if (s.pool) await s.pool.end(); });

const api = (p, init) => fetch(base + p, init).then(async r => ({ status: r.status, body: await r.json() }));

test('schema applies twice without error', async () => { await migrate(pool); });

test('pair order is byte order whatever the database collation (Render sorts like a dictionary)', async () => {
  const c = await pool.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'co_appearances_check'");
  assert.match(c.rows[0].d, /COLLATE "C"/);
});

test('importer loads the dump: every person, every edge between known people, one occasion per evidence url', async () => {
  const r = await importDump(pool, dump);
  assert.equal(r.people, dump.people.length);
  const knownIds = new Set(dump.people.map(p => p.id));
  const valid = dump.edges.filter(e => knownIds.has(e.a) && knownIds.has(e.b) && e.a !== e.b);
  const pairs = new Set(valid.map(e => (e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a))); /* the store held 11 reversed duplicates; one row per pair here */
  assert.equal(r.edges + r.skippedEdges, dump.edges.length);
  assert.equal(r.edges, valid.length);
  const validEdges = pairs.size;
  const c = await pool.query('select (select count(*)::int from people) p, (select count(*)::int from co_appearances) e, (select count(*)::int from occasions) o, (select count(*)::int from person_topics) t');
  assert.equal(c.rows[0].p, dump.people.length);
  assert.equal(c.rows[0].e, validEdges);
  assert.ok(c.rows[0].o > 1000, 'occasions built from evidence urls');
  assert.ok(c.rows[0].t >= 10, 'topics imported');
});

test('importer is idempotent and --if-empty skips a filled store', async () => {
  const before = await pool.query('select count(*)::int n from co_appearances');
  const r = await importDump(pool, dump, { ifEmpty: true });
  assert.equal(r.skipped, true);
  await importDump(pool, dump);
  const after = await pool.query('select count(*)::int n from co_appearances');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('the owner is on the map with his topics, roles and the Nordic battle links', async () => {
  const g = (await api('/api/graph')).body;
  const me = g.people.find(p => p.id === 'vincent-donnat');
  assert.ok(me, 'vincent-donnat present');
  assert.ok(me.topics.includes('Liquidity'));
  assert.ok(me.roles.length >= 2);
  const links = g.edges.filter(e => e.a === 'vincent-donnat' || e.b === 'vincent-donnat');
  assert.ok(links.some(e => e.id === 'jouni-kirjola__vincent-donnat' && e.evidence.length === 2));
});

test('/api/graph has the shapes the page expects and /api/health counts', async () => {
  const g = (await api('/api/graph')).body;
  assert.ok(g.people.length > 1900 && g.edges.length > 3000);
  for (const k of ['id', 'name', 'headline', 'org', 'region', 'segment', 'seed', 'addedAt', 'topics', 'systems', 'roles']) assert.ok(k in g.people[0], k);
  for (const k of ['a', 'b', 'kind', 'label', 'url', 'confidence', 'evidence']) assert.ok(k in g.edges[0], k);
  const h = (await api('/api/health')).body;
  assert.equal(h.people, g.people.length);
});

test('a visitor declares a connection: pending, visible in the connections angle, not duplicated, limited per day', async () => {
  const post = (from, to) => api('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
  let r = await post('ernie-humphrey', 'craig-jeffery');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'pending');
  r = await post('ernie-humphrey', 'craig-jeffery');
  assert.equal(r.body.status, 'exists');
  r = await post('ernie-humphrey', 'ernie-humphrey');
  assert.equal(r.status, 400);
  r = await post('ernie-humphrey', 'nobody-here');
  assert.equal(r.status, 404);
  const g = (await api('/api/graph?since=2000-01-01T00:00:00Z')).body;
  assert.ok(g.connections.some(c => c.from === 'ernie-humphrey' && c.to === 'craig-jeffery' && c.status === 'pending'));
  for (let i = 0; i < 8; i++) await post('ernie-humphrey', dump.people[i].id);
  r = await post('ernie-humphrey', dump.people[20].id);
  assert.equal(r.status, 429, 'eleventh declaration of the day is refused');
});

test('a removal request hides the card at once; approval deletes, rejection restores', async () => {
  const id = dump.people[50].id;
  let r = await api('/api/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'removal', personId: id, payload: { reason: 'test' }, email: 'someone@example.org' }) });
  assert.equal(r.body.status, 'pending');
  let g = (await api('/api/graph?since=2000-01-01T00:00:00Z')).body;
  assert.ok(!g.people.some(p => p.id === id) && g.hidden.includes(id), 'hidden immediately');
  process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'x';
  const token = require('../server').app ? process.env.ADMIN_TOKEN : '';
  r = await api('/api/admin/queue');
  assert.equal(r.status, 401, 'admin needs the token');
  r = await api('/api/admin/queue', { headers: { 'x-admin-token': token } });
  if (r.status === 200) {
    assert.ok(r.body.submissions.some(s => s.person_id === id));
    await api('/api/admin/submissions/' + r.body.submissions.find(s => s.person_id === id).id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ status: 'rejected' }) });
    g = (await api('/api/graph?since=2000-01-01T00:00:00Z')).body;
    assert.ok(g.people.some(p => p.id === id), 'restored after rejection');
  }
});

test('the served page is a full document that reads the API, with the three angles and no artifact runtime', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes("fetch('/api/graph'"));
  assert.ok(html.includes("fetch('/api/connections'"));
  assert.ok(!html.includes("claude.use('db')"));
  for (const a of ['data-a="social"', 'data-a="topics"', 'data-a="connections"']) assert.ok(html.includes(a), a);
  assert.ok(!/—/.test(html.replace(/<style[\s\S]*?<\/style>/g, '')), 'no em dash in copy');
});
