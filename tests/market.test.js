'use strict';
/* Market view: company-system facts, the seed, the payload, the harvester's rules (against a stand-in for the Messages API) and the page. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makePool } = require('../scripts/db');
const { compKey, canonSystem, upsertInstall } = require('../scripts/market');
const { crawl, config } = require('../scripts/crawl');

let pool, server, base, mock, script = null, calls = [];
test.before(async () => {
  await require('./setup').ready({ reset: true });
  pool = makePool();
  const { app } = require('../server');
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { const body = JSON.parse(b); calls.push(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(script(body, calls.length))); });
  });
  await new Promise(r => mock.listen(0, r));
});
test.after(async () => { server.close(); mock.close(); await pool.end(); const s = require('../server'); if (s.pool) await s.pool.end(); });

test('names meet on one key and products on their vendor', () => {
  assert.strictEqual(compKey('Kimberly-Clark Corporation'), compKey('Kimberly-Clark'));
  assert.strictEqual(compKey('The Arnott\'s Group'), 'arnotts');
  assert.deepStrictEqual(canonSystem('Reval'), { system: 'ION Treasury', product: 'Reval' });
  assert.deepStrictEqual(canonSystem('Ripple Treasury, powered by GTreasury'), { system: 'GTreasury', product: '' });
  assert.strictEqual(canonSystem('manual spreadsheets').system, 'Excel');
  assert.strictEqual(canonSystem('Kyriba Enterprise').system, 'Kyriba');
});

test('each seed file is loaded once, with the job-post selections, and the sources are queued', async () => {
  assert.ok((await pool.query('select count(*)::int n from market_seed_files')).rows[0].n >= 2, 'both seed files are booked');
  assert.ok((await pool.query("select count(distinct system)::int n from installs where status = 'live'")).rows[0].n >= 15, 'vendors beyond the first four');
  const n = (await pool.query("select count(*)::int n from installs where source = 'seed'")).rows[0].n;
  assert.ok(n >= 200, 'seed rows: ' + n);
  await require('../scripts/migrate').migrate(pool);
  assert.strictEqual((await pool.query("select count(*)::int n from installs where source = 'seed'")).rows[0].n, n, 'a second migrate adds nothing');
  const sw = (await pool.query("select * from installs where company_id = 'swile'")).rows[0];
  assert.strictEqual(sw.partner, 'Absys Cyborg'); assert.strictEqual(sw.since, '2020');
  const sel = (await pool.query("select * from installs where company_id = 'sovos' and status = 'selecting'")).rows[0];
  assert.strictEqual(sel.system, ''); assert.strictEqual(sel.kind, 'job_post');
  assert.ok((await pool.query("select count(*)::int n from market_sources where status = 'queued'")).rows[0].n >= 30);
});

test('a fact merges by URL, fills what is empty, upgrades a vendor list to the single story, and keeps advisers and vendors out', async () => {
  const story = 'https://www.example.org/stories/barilla-kyriba';
  let r = await upsertInstall(pool, { company: 'Barilla', system: 'Kyriba Enterprise', status: 'live', since: '2019', partner: 'Talan', url: story, note: 'Barilla centralised cash with Kyriba in 2019.' });
  assert.ok(r.ok && !r.added && r.merged);
  const row = (await pool.query("select * from installs where company_id = 'barilla' and system = 'Kyriba'")).rows[0];
  assert.strictEqual(row.url, story); assert.strictEqual(row.since, '2019'); assert.strictEqual(row.partner, 'Talan');
  assert.strictEqual(row.evidence.length, 2);
  r = await upsertInstall(pool, { company: 'Barilla', system: 'Kyriba', status: 'live', since: '2021', url: story });
  assert.ok(r.ok && !r.merged);
  assert.strictEqual((await pool.query("select since, jsonb_array_length(evidence) n from installs where company_id = 'barilla' and system = 'Kyriba'")).rows[0].since, '2019', 'nothing is overwritten');
  for (const bad of [{ company: 'EY', system: 'Kyriba', status: 'live', url: story }, { company: 'Kyriba', system: 'Kyriba', status: 'live', url: story },
    { company: 'Acme', system: '', status: 'live', url: story }, { company: 'Acme', system: 'Kyriba', status: 'live', url: 'ftp://x' }]) {
    assert.strictEqual((await upsertInstall(pool, bad)).ok, false, JSON.stringify(bad));
  }
  assert.ok((await upsertInstall(pool, { company: 'Acme Foods', system: '', status: 'selecting', url: story, kind: 'job_post', date: '2026-11-01' })).ok);
});

test('the graph carries organisations, what they run, the pairs person cards attest, and who works there', async () => {
  const r = await fetch(base + '/api/graph?since=' + encodeURIComponent('2000-01-01T00:00:00Z')).then(x => x.json());
  assert.ok(r.companies.length > 200 && r.installs.length > 200);
  const full = await fetch(base + '/api/graph').then(x => x.json());
  assert.ok(full.installs.some(i => i.kind === 'person' && i.personId), 'a pair from a person card');
  assert.ok(full.companyPeople && Object.keys(full.companyPeople).length > 0, 'people at a company');
  assert.ok(!full.installs.some(i => i.company === 'ey'), 'advisers are not users');
});

const usage = { input_tokens: 15000, output_tokens: 900, server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 } };
const fetchBlocks = (id, url) => [{ type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
  { type: 'web_fetch_tool_result', tool_use_id: id, content: { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Customer stories' } } } }];

test('the harvester keeps facts only from pages it fetched, queues single stories, and closes the source', async () => {
  const src = 'https://www.casestudies.com/company/agicap';
  await pool.query("update market_sources set status = 'done', read_at = now() where url <> $1", [src]);
  await pool.query("update market_sources set status = 'queued', read_at = null, attempts = 0 where url = $1", [src]);
  await pool.query("delete from runs where data->>'mode' = 'render'; update people set deepened_at = now(), parked = true");
  calls = [];
  script = (body, n) => n === 1
    ? { stop_reason: 'pause_turn', usage, content: [{ type: 'text', text: 'Reading.' }, ...fetchBlocks('s1', src)] }
    : { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'submit_market', input: {
      notes: 'Forty stories listed.',
      installs: [
        { company: 'Petit Bateau', system: 'Agicap', status: 'live', url: src, region: 'France' },
        { company: 'Le Slip Français', system: 'Agicap', status: 'live', replaced: 'Excel', url: src },
        { company: 'Unfetched SA', system: 'Agicap', status: 'live', url: 'https://elsewhere.example.org/x' },
        { company: 'Deloitte', system: 'Agicap', status: 'live', url: src }],
      next_pages: [{ url: 'https://www.casestudies.com/company/agicap/case-study/petit-bateau', label: 'Petit Bateau story' }, { url: 'https://www.linkedin.com/posts/x' }] } }] };
  const run = await crawl(pool, Object.assign(config({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + mock.address().port, CRAWL_TARGETS: '0' })));
  assert.deepStrictEqual(run.errors, []);
  assert.strictEqual(run.market.added, 2, JSON.stringify(run.market));
  assert.strictEqual(run.market.rejected, 2);
  assert.strictEqual(run.market.nextPages, 1, 'LinkedIn is never queued');
  const ag = (await pool.query("select company_id from installs where system = 'Agicap' and source = 'harvest' order by company_id")).rows;
  assert.deepStrictEqual(ag.map(x => x.company_id), ['le-slip-francais', 'petit-bateau']);
  assert.strictEqual((await pool.query('select region from companies where id = $1', ['petit-bateau'])).rows[0].region, 'France');
  const s = (await pool.query('select status, found from market_sources where url = $1', [src])).rows[0];
  assert.deepStrictEqual(s, { status: 'done', found: 2 });
  assert.strictEqual((await pool.query("select status from market_sources where url like '%petit-bateau'")).rows[0].status, 'queued');
  assert.ok(calls[0].tools.some(t => t.name === 'submit_market') && !calls[0].tools.some(t => t.name === 'web_search'), 'an index is read, not searched');
  assert.ok(run.costUsd > 0);
});

test('the page opens on the Market view, with organisations, systems and the selecting signal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /data-a="market" aria-pressed="true">Market</);
  assert.match(html, />People<\/button>/);
  assert.match(html, /synapse\.view/);
  assert.match(html, /pendingCo\.push/);
  assert.match(html, /Selecting now/);
  assert.match(html, /function renderCompanyDetail/);
});

test('the page carries the K-phi palettes, dark by default with a remembered light mode', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /--bg:#07070f;/);
  assert.match(html, /:root\[data-theme="light"\]\{\s*--bg:#f4f6fb;/);
  assert.match(html, /localStorage\.getItem\("synapse\.theme"\)/);
  assert.match(html, /id="btn-theme"/);
  assert.match(html, /DM\+Sans/);
  assert.ok(!/#6ee7f0|#0e1328/.test(html), 'no literal colours left from the old palette');
});

test('one method for every vendor: one named-customer search each, nothing extra, and the method is on the page', async () => {
  const { SOURCES, VENDORS, seed } = require('../scripts/market');
  for (const [name] of VENDORS) assert.strictEqual(SOURCES.filter(x => x.kind === 'search' && x.url === 'search:' + name + ' customer case study').length, 1, name);
  const named = SOURCES.filter(x => x.kind === 'search' && VENDORS.some(([n]) => x.url.includes(n)));
  assert.strictEqual(named.length, VENDORS.length, 'no vendor has a second search');
  await pool.query("insert into market_sources (url, label, kind) values ('search:FIS Quantum job post', 'extra', 'search') on conflict do nothing");
  await seed(pool);
  assert.strictEqual((await pool.query("select count(*)::int n from market_sources where url = 'search:FIS Quantum job post'")).rows[0].n, 0, 'a search outside the method is dropped');
  const { INDUSTRIES } = require('../scripts/market');
  assert.deepStrictEqual(INDUSTRIES, require('../scripts/enrich').VERTICALS.map(v => v[0]), 'the industry searches cover exactly the filter industries');
  for (const v of INDUSTRIES) assert.strictEqual(SOURCES.filter(x => x.kind === 'search' && x.url.startsWith('search:' + v + ' ')).length, 1, v);
  assert.ok(!SOURCES.some(x => /commodity trading treasury system/.test(x.url)), 'no industry gets a search of its own');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /How the Market view is counted/);
  assert.match(html, /This is not market share/);
});
