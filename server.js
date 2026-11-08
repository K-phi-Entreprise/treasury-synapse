'use strict';
/* Treasury Synapse server: serves the map, the graph API (three angles from one set of facts),
 * visitor declarations and submissions (never instant: the owner validates), and an admin review API. */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { makePool } = require('./scripts/db');

const app = express();
const pool = process.env.DATABASE_URL ? makePool() : null;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SALT = process.env.IP_SALT || ADMIN_TOKEN || 'synapse';
const LIMITS = { connection: 10, submission: 10, ask: 20 };

app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '64kb' }));

const ipHash = req => crypto.createHash('sha256').update(SALT + '|' + (req.ip || '')).digest('hex').slice(0, 32);
const iso = v => (v ? new Date(v).toISOString() : '');

/* ---------- graph: one query set, cached for a minute ---------- */
let cache = { at: 0, body: null };
async function loadGraph(since) {
  const sinceSql = since ? ' where updated_at > $1' : '';
  const params = since ? [since] : [];
  const people = await pool.query(
    `select p.*,
       coalesce((select json_agg(t.topic order by t.topic) from person_topics t where t.person_id = p.id), '[]') as topics,
       coalesce((select json_agg(json_build_object('name', s.system, 'role', s.role, 'url', s.url, 'date', s.date)) from person_systems s where s.person_id = p.id), '[]') as systems,
       coalesce((select json_agg(json_build_object('title', r.title, 'org', r.org, 'from', r.from_year, 'to', r.to_year, 'url', r.url) order by r.from_year) from person_roles r where r.person_id = p.id), '[]') as roles
     from people p${sinceSql.replace('updated_at', 'p.updated_at')} order by p.added_at nulls last`, params);
  const edges = await pool.query(`select * from v_social${sinceSql} order by added_at nulls last`, params);
  const conns = await pool.query(`select * from v_connections${sinceSql} order by added_at`, params);
  return {
    now: new Date().toISOString(),
    people: people.rows.filter(p => !p.hidden).map(p => ({
      id: p.id, name: p.name, headline: p.headline, org: p.org, city: p.city, region: p.region, segment: p.segment, seed: p.seed,
      foundVia: p.found_via, source: p.source, knownFor: p.known_for, publishers: p.publishers, followers: p.followers,
      addedAt: iso(p.added_at), topics: p.topics, systems: p.systems, roles: p.roles
    })),
    hidden: people.rows.filter(p => p.hidden).map(p => p.id),
    edges: edges.rows.map(e => ({ id: e.a + '__' + e.b, a: e.a, b: e.b, kind: e.kind, label: e.label, url: e.url, confidence: e.confidence, evidence: e.evidence, addedAt: iso(e.added_at) })),
    connections: conns.rows.map(c => ({ id: c.from_id + '__' + c.to_id, from: c.from_id, to: c.to_id, status: c.status, addedAt: iso(c.added_at) }))
  };
}
app.get('/api/graph', async (req, res, next) => {
  try {
    const since = req.query.since && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : null;
    if (since) return res.json(await loadGraph(since));
    if (!cache.body || Date.now() - cache.at > 60000) cache = { at: Date.now(), body: await loadGraph(null) };
    res.set('Cache-Control', 'public, max-age=60');
    res.json(cache.body);
  } catch (e) { next(e); }
});

app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('select (select count(*) from people where not hidden)::int as people, (select count(*) from co_appearances)::int as edges');
    res.json({ ok: true, people: r.rows[0].people, edges: r.rows[0].edges });
  } catch (e) { res.status(500).json({ ok: false, error: 'database unavailable' }); }
});

/* ---------- visitor writes: quota per visitor per day, always pending ---------- */
async function underQuota(req, kind) {
  const h = ipHash(req);
  const r = await pool.query(
    `insert into quotas (ip_hash, day, kind, n) values ($1, current_date, $2, 1)
     on conflict (ip_hash, day, kind) do update set n = quotas.n + 1 returning n`, [h, kind]);
  return r.rows[0].n <= LIMITS[kind];
}
const slug = v => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);

app.post('/api/connections', async (req, res, next) => {
  try {
    const from = slug(req.body.from), to = slug(req.body.to);
    if (!from || !to || from === to) return res.status(400).json({ error: 'two different people are needed' });
    if (!(await underQuota(req, 'connection'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
    const ok = await pool.query('select count(*)::int as n from people where id in ($1,$2) and not hidden', [from, to]);
    if (ok.rows[0].n !== 2) return res.status(404).json({ error: 'unknown person' });
    const r = await pool.query(
      `insert into connections (from_id, to_id, status, note, ip_hash) values ($1, $2, 'pending', $3, $4)
       on conflict (from_id, to_id) do nothing returning status`, [from, to, String(req.body.note || '').slice(0, 300), ipHash(req)]);
    cache.at = 0;
    res.json({ status: r.rows.length ? 'pending' : 'exists' });
  } catch (e) { next(e); }
});

app.post('/api/submissions', async (req, res, next) => {
  try {
    const kind = String(req.body.kind || '');
    if (!['correction', 'link', 'removal'].includes(kind)) return res.status(400).json({ error: 'unknown submission kind' });
    if (!(await underQuota(req, 'submission'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
    const personId = slug(req.body.personId) || null;
    const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
    const email = String(req.body.email || '').slice(0, 200);
    const r = await pool.query(
      'insert into submissions (kind, person_id, payload, email, ip_hash) values ($1,$2,$3,$4,$5) returning id',
      [kind, personId, JSON.stringify(payload), email, ipHash(req)]);
    /* a removal request hides the card at once; the owner decides on deletion */
    if (kind === 'removal' && personId) {
      await pool.query(`update people set hidden = true, hidden_reason = 'removal requested, pending review', updated_at = now() where id = $1`, [personId]);
      cache.at = 0;
    }
    res.json({ id: r.rows[0].id, status: 'pending' });
  } catch (e) { next(e); }
});

/* ---------- admin review API (the review page comes with D3) ---------- */
function admin(req, res, next) {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'admin token required' });
  next();
}
app.get('/api/admin/queue', admin, async (req, res, next) => {
  try {
    const [c, s, l] = await Promise.all([
      pool.query("select * from connections where status = 'pending' order by added_at"),
      pool.query("select * from submissions where status in ('pending','discuss') order by added_at"),
      pool.query("select * from leads where status = 'pending' order by added_at")]);
    res.json({ connections: c.rows, submissions: s.rows, leads: l.rows });
  } catch (e) { next(e); }
});
app.post('/api/admin/connections/:from/:to', admin, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['pending', 'confirmed', 'rejected'].includes(status)) return res.status(400).json({ error: 'bad status' });
    await pool.query('update connections set status = $3, reviewed_at = now(), updated_at = now() where from_id = $1 and to_id = $2', [slug(req.params.from), slug(req.params.to), status]);
    cache.at = 0;
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/admin/submissions/:id', admin, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['approved', 'rejected', 'discuss'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const r = await pool.query('update submissions set status = $2, decision_note = $3, reviewed_at = now() where id = $1 returning *', [Number(req.params.id), status, String(req.body.note || '')]);
    const sub = r.rows[0];
    if (sub && sub.kind === 'removal' && sub.person_id) {
      if (status === 'approved') await pool.query('delete from people where id = $1', [sub.person_id]);
      if (status === 'rejected') await pool.query("update people set hidden = false, hidden_reason = '', updated_at = now() where id = $1", [sub.person_id]);
      cache.at = 0;
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- static ---------- */
app.get(['/', '/index.html'], (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server error' }); }); // eslint-disable-line no-unused-vars

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('treasury-synapse listening on ' + port));
}
module.exports = { app, pool };
