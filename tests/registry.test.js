'use strict';
/* Public companies: registry profiles (France, SEC) and SEC filings that name a system, against stand-ins for the registries and the Messages API. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makePool } = require('../scripts/db');
const { upsertInstall, loadMarket } = require('../scripts/market');
const reg = require('../scripts/registry');

let pool, mock, base, judged = [];
const FILING = '<html><body><p>Item 9A. Changes in internal control. During the fourth quarter we completed the implementation of Kyriba as our treasury management system, replacing spreadsheets.</p></body></html>';
const COMPETITOR = '<html><body><p>Our competitors include Kyriba, GTreasury and others.</p></body></html>';
test.before(async () => {
  await require('./setup').ready({ reset: true });
  pool = makePool();
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), json = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
      if (u.pathname === '/search') {
        const q = u.searchParams.get('q');
        if (/^Fromagerie/.test(q)) return json({ results: [{ siren: '123456789', nom_complet: 'FROMAGERIE TEST SA', categorie_entreprise: 'ETI', tranche_effectif_salarie: '41', annee_tranche_effectif_salarie: '2024', activite_principale: '10.51C', finances: { 2024: { ca: 412000000 } } }] });
        return json({ results: [{ siren: '999999999', nom_complet: 'SOMETHING ELSE' }] });
      }
      if (u.pathname === '/files/company_tickers_exchange.json') return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[777, 'Widget Corp', 'WDG', 'NYSE'], [888, 'Rival Treasury Inc', 'RIV', 'Nasdaq']] });
      if (u.pathname === '/submissions/CIK0000000777.json') return json({ sic: '3550', sicDescription: 'Special Industry Machinery', category: 'Large accelerated filer', addresses: { business: { stateOrCountry: 'OH', isForeignLocation: 0 } } });
      if (u.pathname === '/LATEST/search-index') return json({ hits: { hits: [
        { _id: '0000000777-25-000001:wdg-10k.htm', _source: { ciks: ['0000000777'], display_names: ['Widget Corp  (WDG)  (CIK 0000000777)'], form: '10-K', file_date: '2025-02-20' } },
        { _id: '0000000888-25-000002:riv-10k.htm', _source: { ciks: ['0000000888'], display_names: ['Rival Treasury Inc  (RIV)  (CIK 0000000888)'], form: '10-K', file_date: '2025-03-01' } }] } });
      if (/wdg-10k/.test(u.pathname)) { res.setHeader('content-type', 'text/html'); return res.end(FILING); }
      if (/riv-10k/.test(u.pathname)) { res.setHeader('content-type', 'text/html'); return res.end(COMPETITOR); }
      if (u.pathname === '/v1/messages') {
        const body = JSON.parse(b); judged.push(body);
        const text = body.messages[0].content;
        const input = /implementation of Kyriba/.test(text) ? { uses: true, status: 'live', extract: 'completed the implementation of Kyriba as our treasury management system', note: 'Widget Corp went live on Kyriba.' }
          : { uses: false };
        return json({ content: [{ type: 'tool_use', id: 't1', name: 'judge_filing', input }], usage: { input_tokens: 900, output_tokens: 60 } });
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, r));
  base = 'http://127.0.0.1:' + mock.address().port;
});
test.after(async () => { mock.close(); await pool.end(); });
const cfg = () => ({ frBase: base, secFiles: base, secData: base, secSearch: base, registryPauseMs: 0, baseUrl: base, apiKey: 'k', model: 'm', priceIn: 3, priceOut: 15, pricePerSearch: 0, filingsPerRun: 5, registryBatch: 50 });

test('companies on the map get their registry identity on an exact name match, flagged with its source', async () => {
  await upsertInstall(pool, { company: 'Fromagerie Test', system: 'Agicap', status: 'live', url: 'https://agicap.com/fr/clients/fromagerie-test', region: 'France' });
  await pool.query("update companies set country = 'France' where id = 'fromagerie-test'");
  await upsertInstall(pool, { company: 'Widget Corp', system: 'Anaplan', status: 'live', url: 'https://www.anaplan.com/customers/widget' });
  await upsertInstall(pool, { company: 'Nobody Matches Ltd', system: 'Kyriba', status: 'live', url: 'https://www.kyriba.com/customers/nobody' });
  /* the seeded map is large; only the three test companies are due */
  await pool.query("update companies set reg_tried_at = now() where id not in ('fromagerie-test', 'widget', 'nobody-matches')");
  const out = await reg.profiles(pool, cfg(), {});
  assert.ok(out.matched >= 2, JSON.stringify(out));
  const fr = (await pool.query("select * from companies where id = 'fromagerie-test'")).rows[0];
  assert.strictEqual(fr.registry, 'FR:123456789'); assert.match(fr.registry_url, /annuaire-entreprises/);
  assert.strictEqual(fr.reg_attrs.category, 'ETI'); assert.strictEqual(fr.reg_attrs.revenue, 412000000); assert.match(fr.reg_attrs.source, /INSEE/);
  assert.strictEqual(fr.size, '250 to 1,000');
  const us = (await pool.query("select * from companies where id = 'widget'")).rows[0];
  assert.strictEqual(us.registry, 'US:0000000777'); assert.strictEqual(us.reg_attrs.ticker, 'WDG'); assert.strictEqual(us.reg_attrs.source, 'SEC EDGAR');
  assert.strictEqual(us.country, 'United States');
  assert.strictEqual((await pool.query("select registry from companies where id = 'nobody-matches'")).rows[0].registry, '', 'no match, nothing guessed');
  const m = (await loadMarket(pool)).companies.find(c => c.id === 'widget');
  assert.strictEqual(m.registry, 'US:0000000777'); assert.strictEqual(m.reg.ticker, 'WDG');
});

test('a filing counts only when its own words say the filer runs the system, and the line is declared', async () => {
  await pool.query("insert into market_sources (url, label, kind) values ('sec:Kyriba', 'test', 'sec_search') on conflict do nothing");
  await pool.query("update market_sources set read_at = now() where kind = 'sec_search' and url <> 'sec:Kyriba'");
  await pool.query("update market_sources set read_at = null where url = 'sec:Kyriba'");
  const out = await reg.filings(pool, cfg(), {});
  assert.strictEqual(out.added, 1, JSON.stringify(out)); assert.strictEqual(out.rejected, 1);
  const row = (await pool.query("select * from installs where company_id = 'widget' and system = 'Kyriba'")).rows[0];
  assert.strictEqual(row.kind, 'filing'); assert.strictEqual(row.evidence[0].level, 'declared');
  assert.strictEqual(row.evidence[0].extract, 'completed the implementation of Kyriba as our treasury management system');
  assert.strictEqual((await pool.query("select count(*)::int n from installs where company_id = 'rival-treasury'")).rows[0].n, 0, 'a competitor list is not use');
  assert.strictEqual((await pool.query("select count(*)::int n from market_sources where kind = 'sec_filing' and status = 'done'")).rows[0].n, 2, 'each filing is read once');
  const again = await reg.filings(pool, cfg(), {});
  assert.strictEqual(again.read, 0, 'nothing read twice');
});

test('an extract the passages do not contain is never written', async () => {
  const parts = reg.passages(reg.strip(FILING), 'Kyriba');
  assert.strictEqual(parts.length, 1); assert.match(parts[0], /implementation of Kyriba/);
  assert.strictEqual(reg.filerName('BOTTOMLINE TECHNOLOGIES INC /DE/  (CIK 0001073349)'), 'BOTTOMLINE TECHNOLOGIES INC');
  assert.strictEqual(reg.filerName('Widget Corp  (WDG)  (CIK 0000000777)'), 'Widget Corp');
  /* the SEC searches are seeded, one per term, and the web harvester never picks them */
  const n = (await pool.query("select count(*)::int n from market_sources where kind = 'sec_search'")).rows[0].n;
  assert.ok(n >= reg.SEC_TERMS.length, 'seeded: ' + n);
  assert.ok(!reg.SEC_TERMS.some(([t]) => /^(Board|Cube|Bound|FIS|SAP|Pigment|Statement)$/.test(t)), 'no ordinary-word search');
});
