'use strict';
/* The company universe: French large and mid-size legal units and US listed companies, against stand-ins for the registries. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makePool } = require('../scripts/db');
const { upsertInstall } = require('../scripts/market');
const uni = require('../scripts/universe');

let pool, mock, base, server, web, frPages = [];
test.before(async () => {
  await require('./setup').ready({ reset: true });
  pool = makePool();
  mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), json = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    if (u.pathname === '/search') {
      const cat = u.searchParams.get('categorie_entreprise'), page = Number(u.searchParams.get('page'));
      frPages.push(cat + page);
      if (cat === 'GE' && page === 1) return json({ total_results: 2, results: [
        { siren: '552032534', nom_complet: 'DANONE', categorie_entreprise: 'GE', tranche_effectif_salarie: '42', activite_principale: '70.10Z', etat_administratif: 'A', finances: { 2025: { ca: 27376000000 } } },
        { siren: '111111111', nom_complet: 'CLOSED CO', etat_administratif: 'C' }] });
      if (cat === 'ETI' && page <= 2) return json({ total_results: 30, results: Array.from({ length: page === 1 ? 25 : 5 }, (_, k) => ({ siren: String(200000000 + page * 100 + k), nom_complet: 'ETI ' + page + '-' + k, etat_administratif: 'A' })) });
      return json({ total_results: 0, results: [] });
    }
    if (u.pathname === '/files/company_tickers_exchange.json') return json({ data: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq'], [999, 'Blank Check Acquisition Corp', 'BLNK', 'NYSE'], [5, 'No Exchange Co', 'NOX', null]] });
    if (u.pathname === '/submissions/CIK0000320193.json') return json({ sic: '3571', sicDescription: 'Electronic Computers', category: 'Large accelerated filer' });
    if (u.pathname === '/submissions/CIK0000000999.json') return json({ sic: '6770', sicDescription: 'Blank Checks', category: 'Non-accelerated filer' });
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => mock.listen(0, r));
  base = 'http://127.0.0.1:' + mock.address().port;
  ({ app: web } = require('../server'));
  await new Promise(r => { server = web.listen(0, r); });
});
test.after(async () => { mock.close(); server.close(); await pool.end(); const s = require('../server'); if (s.pool) await s.pool.end(); });
const cfg = extra => Object.assign({ frBase: base, secFiles: base, secData: base, registryPauseMs: 0, universePages: 10, universeUS: 10 }, extra || {});

test('France: active large and mid-size legal units, page by page, each read once', async () => {
  const out = await uni.grow(pool, cfg({ universeUS: 0 }), {});
  assert.deepStrictEqual(out.errors, []);
  const fr = (await pool.query("select * from universe where country = 'France' order by id")).rows;
  assert.strictEqual(fr.length, 31, '1 GE (the closed one left out) and 30 ETI');
  const d = fr.find(r => r.id === 'FR:552032534');
  assert.deepStrictEqual([d.band, d.category, Number(d.revenue), d.source.startsWith('INSEE')], ['Large', 'GE', 27376000000, true]);
  assert.match(d.url, /annuaire-entreprises/);
  const before = frPages.length;
  await uni.grow(pool, cfg({ universeUS: 0 }), {});
  assert.strictEqual(frPages.length, before, 'a finished list is not read again before a year');
});

test('US: listed companies, the filer category gives the band, funds and blank checks are left out', async () => {
  await uni.grow(pool, cfg({ universePages: 0 }), {});
  const us = (await pool.query("select * from universe where country = 'United States' order by id")).rows;
  assert.strictEqual(us.length, 2, 'only companies with an exchange');
  const a = us.find(r => r.id === 'US:0000320193');
  assert.deepStrictEqual([a.band, a.industry, a.skipped], ['Large', 'Electronic Computers', false]);
  assert.strictEqual(us.find(r => r.id === 'US:0000000999').skipped, true);
  assert.strictEqual(uni.usBand('Accelerated filer'), 'Mid-size'); assert.strictEqual(uni.usBand('Non-accelerated filer'), 'Small');
});

test('the universe meets the map by registry id or exact name, and coverage reads X of N', async () => {
  await upsertInstall(pool, { company: 'Danone', system: 'Kyriba', status: 'live', url: 'https://www.kyriba.com/customers/danone-test' });
  await upsertInstall(pool, { company: 'Apple', system: 'Anaplan', status: 'live', kind: 'job_post', url: 'https://jobs.example.com/apple-fpa' });
  await pool.query("update companies set registry = 'US:0000320193' where id = 'apple'");
  await uni.link(pool);
  assert.strictEqual((await pool.query("select company_id from universe where id = 'FR:552032534'")).rows[0].company_id, 'danone');
  assert.strictEqual((await pool.query("select company_id from universe where id = 'US:0000320193'")).rows[0].company_id, 'apple');
  const c = await uni.coverage(pool);
  const fr = c.base.filter(b => b.country === 'France').reduce((a, b) => a + b.n, 0);
  assert.strictEqual(fr, 31);
  const ky = c.bySystem.find(b => b.country === 'France' && b.system === 'Kyriba');
  assert.deepStrictEqual([ky.n, ky.declared], [1, 1]);
  const an = c.bySystem.find(b => b.country === 'United States' && b.system === 'Anaplan');
  assert.deepStrictEqual([an.n, an.declared], [1, 0], 'an assumed line counts, and is not counted as declared');
  const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/coverage');
  assert.ok(r.ok); const j = await r.json(); assert.ok(Array.isArray(j.base) && j.note);
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /Found at X of N/); assert.match(html, /among large and mid-size companies in the registries/);
});

test('the registry and universe steps run even when the daily cap is reached, since they make no model call', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'crawl.js'), 'utf8');
  const cap = src.indexOf("else if (spent >= cfg.dailyUsd)");
  assert.ok(src.indexOf("require('./universe').grow") < cap && src.indexOf("require('./registry').profiles") < cap);
  assert.ok(src.indexOf("require('./registry').filings") > cap, 'filings stay inside the cap');
});
