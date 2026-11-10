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
const LIMITS = { connection: 10, submission: 10, import: 2 };

app.set('trust proxy', true);
app.use(compression());
/* admin catch-up import: registered before the small JSON limit so a full store dump (a few MB) fits */
app.post('/api/admin/import', (req, res, next) => admin(req, res, next), express.json({ limit: '40mb' }), async (req, res, next) => {
  try {
    const d = req.body || {};
    if (!Array.isArray(d.people) || !Array.isArray(d.edges)) return res.status(400).json({ error: 'not a store dump (people and edges expected)' });
    const r = await require('./scripts/import').importDump(pool, d, { merge: true });
    cache.at = 0;
    res.json({ ok: true, result: r });
  } catch (e) { next(e); }
});
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

/* LinkedIn Connections.csv, matched in the visitor's browser: only ids of people already on the map arrive here. */
app.post('/api/connections/import', async (req, res, next) => {
  try {
    const from = slug(req.body.from);
    const to = [...new Set((Array.isArray(req.body.to) ? req.body.to : []).map(slug).filter(Boolean))].filter(id => id !== from);
    if (!from || !to.length) return res.status(400).json({ error: 'nothing to import' });
    if (to.length > 500) return res.status(400).json({ error: 'at most 500 connections per import' });
    const known = await pool.query('select id from people where id = any($1) and not hidden', [[from, ...to]]);
    const ok = new Set(known.rows.map(r => r.id));
    if (!ok.has(from)) return res.status(404).json({ error: 'unknown person' });
    if (!(await underQuota(req, 'import'))) return res.status(429).json({ error: 'two imports a day at most, try again tomorrow' });
    const batch = 'csv-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const h = ipHash(req);
    let added = 0;
    for (const id of to) {
      if (!ok.has(id)) continue;
      const r = await pool.query(`insert into connections (from_id, to_id, status, note, ip_hash, batch) values ($1,$2,'pending','LinkedIn connections import',$3,$4)
        on conflict (from_id, to_id) do nothing returning 1`, [from, id, h, batch]);
      added += r.rowCount;
    }
    cache.at = 0;
    res.json({ added, existing: to.filter(id => ok.has(id)).length - added, unknown: to.filter(id => !ok.has(id)).length, batch });
  } catch (e) { next(e); }
});

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

const mail = require('./mail');
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://synapse.k-phi.com').replace(/\/$/, '');
const REGIONS = ['United States', 'United Kingdom', 'France', 'DACH', 'Benelux', 'Nordics', 'Southern Europe', 'Asia-Pacific', 'Other', 'Unknown'];
const FIELDS = { headline: 'headline', org: 'org', city: 'city', region: 'region', knownFor: 'known_for' };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

function cleanPayload(kind, p) {
  p = p && typeof p === 'object' ? p : {};
  if (kind === 'correction') {
    const field = Object.prototype.hasOwnProperty.call(FIELDS, p.field) ? p.field : 'other';
    const value = clip(p.value, 300).trim();
    if (!value && field !== 'other') return null;
    if (field === 'region' && !REGIONS.includes(value)) return null;
    return { field, value, note: clip(p.note, 600) };
  }
  if (kind === 'link') {
    let u; try { u = new URL(String(p.url || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return { refused: 'linkedin' };
    return { url: u.toString().slice(0, 600), note: clip(p.note, 600) };
  }
  if (kind === 'removal') return { reason: clip(p.reason, 600), self: !!p.self };
  return null;
}

app.post('/api/submissions', async (req, res, next) => {
  try {
    const kind = String(req.body.kind || '');
    if (!['correction', 'link', 'removal'].includes(kind)) return res.status(400).json({ error: 'unknown submission kind' });
    const personId = slug(req.body.personId) || null;
    if (!personId) return res.status(400).json({ error: 'which person is this about?' });
    const payload = cleanPayload(kind, req.body.payload);
    if (!payload) return res.status(400).json({ error: kind === 'link' ? 'a public web address is needed' : 'something is missing in the form' });
    if (payload.refused) return res.status(400).json({ error: 'LinkedIn pages are not used on this map; please send another public page' });
    const email = clip(req.body.email, 200).trim();
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'that email address does not look right' });
    if (kind === 'removal' && !email) return res.status(400).json({ error: 'an email is needed for a removal request, to confirm it and tell you the outcome' });
    const person = await pool.query('select id, name from people where id = $1', [personId]);
    if (!person.rows.length) return res.status(404).json({ error: 'unknown person' });
    if (!(await underQuota(req, 'submission'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
    const token = email ? crypto.randomBytes(18).toString('base64url') : null;
    const r = await pool.query(
      'insert into submissions (kind, person_id, payload, email, ip_hash, confirm_token) values ($1,$2,$3,$4,$5,$6) returning id',
      [kind, personId, JSON.stringify(payload), email, ipHash(req), token]);
    /* a removal request hides the card at once; the owner decides on deletion */
    if (kind === 'removal') {
      await pool.query(`update people set hidden = true, hidden_reason = 'removal requested, pending review', updated_at = now() where id = $1`, [personId]);
      cache.at = 0;
    }
    let mailed = false;
    if (email) {
      const what = kind === 'removal' ? 'remove ' + person.rows[0].name + ' from the map. The card is hidden now; deletion is final once the request is reviewed.'
        : kind === 'link' ? 'add a public page to ' + person.rows[0].name + "'s card."
        : 'correct ' + person.rows[0].name + "'s card.";
      const m = await mail.send({ to: email, subject: 'Treasury Synapse: please confirm your request',
        text: 'Hello,\n\nSomeone (hopefully you) asked to ' + what + '\n\nConfirm the request here:\n' + PUBLIC_URL + '/api/confirm/' + token +
          '\n\nNothing else changes until it has been reviewed. If you did not send this, ignore this message.\n\nTreasury Synapse, by K-phi\n' });
      mailed = m.sent;
    }
    res.json({ id: r.rows[0].id, status: 'pending', confirmation: email ? (mailed ? 'sent' : 'not sent') : 'none' });
  } catch (e) { next(e); }
});

app.get('/api/confirm/:token', async (req, res, next) => {
  try {
    const r = await pool.query('update submissions set confirmed_at = coalesce(confirmed_at, now()) where confirm_token = $1 returning id', [String(req.params.token).slice(0, 64)]);
    res.set('X-Robots-Tag', 'noindex').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Treasury Synapse</title>' +
      '<body style="background:#080b17;color:#e8ecff;font:16px system-ui;padding:40px 20px;max-width:560px;margin:auto">' +
      (r.rows.length ? '<h1 style="font-size:22px">Request confirmed</h1><p>Thank you. It will be reviewed, and you will hear back at this address.</p>'
        : '<h1 style="font-size:22px">Link not recognised</h1><p>This confirmation link is not valid or has already been used.</p>') +
      '<p><a style="color:#6ee7f0" href="/">Back to the map</a></p>');
  } catch (e) { next(e); }
});

/* ---------- admin review API, used by /review ---------- */
function admin(req, res, next) {
  const got = String(req.get('x-admin-token') || '');
  const ok = ADMIN_TOKEN && got.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ADMIN_TOKEN));
  if (!ok) return res.status(401).json({ error: 'admin token required' });
  next();
}
app.get('/api/admin/queue', admin, async (req, res, next) => {
  try {
    const [c, s, l] = await Promise.all([
      pool.query(`select c.*, pf.name as from_name, pf.headline as from_headline, pt.name as to_name, pt.headline as to_headline,
          (select count(*)::int from connections x where x.ip_hash = c.ip_hash and x.ip_hash <> '') as same_sender,
          (select count(*)::int from connections y where y.batch = c.batch and y.status = 'pending') as batch_pending
        from connections c join people pf on pf.id = c.from_id join people pt on pt.id = c.to_id where c.status = 'pending' order by c.added_at`),
      pool.query(`select s.id, s.kind, s.person_id, s.payload, s.email, s.status, s.decision_note, s.added_at, s.confirmed_at,
          p.name as person_name, p.headline as person_headline, p.org as person_org, p.city as person_city, p.region as person_region, p.known_for as person_known_for
        from submissions s left join people p on p.id = s.person_id where s.status in ('pending','discuss')
        order by (s.kind = 'removal') desc, s.added_at`),
      pool.query(`select l.*, p.name as person_name from leads l left join people p on p.id = l.person_id where l.status = 'pending' order by l.added_at desc nulls last`)]);
    const runs = (await pool.query("select id, data, started_at from runs where data->>'mode' = 'render' order by started_at desc limit 15")).rows;
    const ids = [...new Set(runs.flatMap(r => r.data.deepened || []))];
    const names = ids.length ? Object.fromEntries((await pool.query('select id, name from people where id = any($1)', [ids])).rows.map(r => [r.id, r.name])) : {};
    runs.forEach(r => { r.names = names; });
    res.json({ connections: c.rows, submissions: s.rows, leads: l.rows, runs, mail: mail.configured() });
  } catch (e) { next(e); }
});
app.post('/api/admin/connections-batch/:batch', admin, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['confirmed', 'rejected'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const r = await pool.query("update connections set status = $2, reviewed_at = now(), updated_at = now() where batch = $1 and status = 'pending'", [clip(req.params.batch, 60), status]);
    cache.at = 0;
    res.json({ ok: true, updated: r.rowCount });
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
  const client = await pool.connect();
  try {
    const status = String(req.body.status || '');
    if (!['approved', 'rejected', 'discuss'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const note = clip(req.body.note, 1000);
    await client.query('begin');
    const r = await client.query("update submissions set status = $2, decision_note = $3, reviewed_at = now() where id = $1 and status in ('pending','discuss') returning *", [Number(req.params.id), status, note]);
    const sub = r.rows[0];
    if (!sub) { await client.query('rollback'); return res.status(404).json({ error: 'not in the queue' }); }
    const p = sub.payload || {};
    if (sub.kind === 'removal') {
      if (status === 'approved') await client.query('delete from people where id = $1', [sub.person_id]);
      if (status === 'rejected') await client.query("update people set hidden = false, hidden_reason = '', updated_at = now() where id = $1", [sub.person_id]);
    }
    if (sub.kind === 'correction' && status === 'approved' && FIELDS[p.field]) {
      const value = req.body.value != null ? clip(req.body.value, 300) : p.value; /* the reviewer may adjust the wording */
      if (p.field === 'region' && !REGIONS.includes(value)) throw Object.assign(new Error('bad region'), { http: 400 });
      await client.query(`update people set ${FIELDS[p.field]} = $2, updated_at = now() where id = $1`, [sub.person_id, value]);
    }
    if (sub.kind === 'link' && status === 'approved') {
      /* the crawler reads queued leads and extracts what the page attests */
      await client.query(`insert into leads (id, url, reason, person_id, snippet, status, added_at) values ($1,$2,'submitted by a visitor, approved',$3,$4,'queued',now())
        on conflict (id) do update set status = 'queued'`, ['sub-' + sub.id, p.url, sub.person_id, clip(p.note, 600)]);
    }
    await client.query('commit');
    cache.at = 0;
    if (sub.email && (status !== 'discuss' || note)) {
      const verdict = status === 'approved' ? (sub.kind === 'removal' ? 'The card has been deleted from the map.' : sub.kind === 'link' ? 'The page will be read by the next crawl and its facts added with their source.' : 'The card has been updated.')
        : status === 'rejected' ? (sub.kind === 'removal' ? 'The request was not accepted and the card is visible again.' : 'The change was not accepted.') : 'A question about your request:';
      await mail.send({ to: sub.email, subject: 'Treasury Synapse: your request', text: 'Hello,\n\n' + verdict + (note ? '\n\n' + note : '') + '\n\nTreasury Synapse, by K-phi\n' });
    }
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (e.http) return res.status(e.http).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});
app.post('/api/admin/leads/:id', admin, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['queued', 'dismissed', 'done'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const r = await pool.query('update leads set status = $2 where id = $1 returning id', [clip(req.params.id, 200), status]);
    if (!r.rows.length) return res.status(404).json({ error: 'unknown lead' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- chat (D2) ---------- */
if (pool) require('./chat').mount(app, {
  pool, ipHash,
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CHAT_MODEL || 'claude-haiku-5-5',
  perVisitor: Number(process.env.CHAT_PER_VISITOR) || 20,
  dailyCap: Number(process.env.CHAT_DAILY_CAP) || 1500,
  secret: SALT + '|ask',
  baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
});

/* ---------- static ---------- */
app.get(['/', '/index.html'], (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get(['/review', '/review/'], (req, res) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); res.sendFile(path.join(__dirname, 'public', 'review.html')); });
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /review\nDisallow: /api/\n'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server error' }); }); // eslint-disable-line no-unused-vars

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('treasury-synapse listening on ' + port));
}
module.exports = { app, pool };
