'use strict';
/* Company profiles from Wikidata, against a stand-in for the Wikidata API: same name and an organisation item, or nothing. */
const test = require('node:test');
const assert = require('node:assert');
const { makePool } = require('../scripts/db');
const { client, enrichBatch, verticalOf, sizeOf, employeesOf } = require('../scripts/enrich');

let pool;
test.before(async () => { await require('./setup').ready({ reset: true }); pool = makePool(); });
test.after(async () => { await pool.end(); });

const claim = id => ({ mainsnak: { datavalue: { value: { id } } } });
const ENT = {
  Q801: { labels: { en: { value: 'Barilla' } }, descriptions: { en: { value: 'Italian food company' } }, claims: {
    P31: [claim('Q4830453')], P452: [claim('Q2095')], P17: [claim('Q38')],
    P1128: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+8000' } } }, qualifiers: { P585: [{ datavalue: { value: { time: '+2019-01-01T00:00:00Z' } } }] } },
      { rank: 'normal', mainsnak: { datavalue: { value: { amount: '+8700' } } }, qualifiers: { P585: [{ datavalue: { value: { time: '+2023-01-01T00:00:00Z' } } }] } }] } },
  Q9: { labels: { en: { value: 'Elis' } }, claims: { P31: [claim('Q5')], P27: [claim('Q142')] } },
  Q2095: { labels: { en: { value: 'food industry' } } }, Q4830453: { labels: { en: { value: 'business' } } }, Q38: { labels: { en: { value: 'Italy' } } }
};
const fake = calls => async url => {
  const q = Object.fromEntries(new URL(url).searchParams); calls.push(q);
  let body;
  if (q.action === 'wbsearchentities') body = { search: q.search === 'Barilla' ? [{ id: 'Q801', label: 'Barilla' }, { id: 'Q77', label: 'Barilla Center' }] : q.search === 'Elis' ? [{ id: 'Q9', label: 'Elis' }] : [] };
  else body = { entities: Object.fromEntries(q.ids.split('|').filter(id => ENT[id]).map(id => [id, ENT[id]])) };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

test('verticals, size bands and the latest head count', () => {
  assert.strictEqual(verticalOf(['food industry']), 'Food & beverage');
  assert.strictEqual(verticalOf(['', 'commodity trading company']), 'Commodities & trading');
  assert.strictEqual(sizeOf(8700), '5,000 to 20,000'); assert.strictEqual(sizeOf(null), '');
  assert.strictEqual(employeesOf(ENT.Q801.claims), 8700);
});

test('a company gets its vertical, size, country and region from its Wikidata item; a person of the same name is refused', async () => {
  await pool.query("update companies set enriched_at = now() where id not in ('barilla', 'elis')");
  await pool.query("update companies set enriched_at = null, wikidata = '', vertical = '', size = '', employees = null, country = '', region = 'Unknown' where id in ('barilla', 'elis')");
  const calls = [];
  const r = await enrichBatch(pool, { limit: 5, wd: client(fake(calls), 0) });
  assert.deepStrictEqual({ looked: r.looked, matched: r.matched }, { looked: 2, matched: 1 });
  const b = (await pool.query("select wikidata, vertical, size, employees, country, region from companies where id = 'barilla'")).rows[0];
  assert.deepStrictEqual(b, { wikidata: 'Q801', vertical: 'Food & beverage', size: '5,000 to 20,000', employees: 8700, country: 'Italy', region: 'Southern Europe' });
  const e = (await pool.query("select wikidata, vertical, enrich_note from companies where id = 'elis'")).rows[0];
  assert.strictEqual(e.wikidata, ''); assert.match(e.enrich_note, /no matching organisation/);
  assert.ok(calls.every(q => q.format === 'json'));
  const again = await enrichBatch(pool, { limit: 5, wd: client(fake([]), 0) });
  assert.strictEqual(again.looked, 0, 'looked-up companies are not asked again');
});

test('a "slow down" from Wikidata stops the batch without marking companies', async () => {
  await pool.query("update companies set enriched_at = null where id = 'swile'");
  const r = await enrichBatch(pool, { limit: 3, wd: client(async () => ({ ok: false, status: 429, text: async () => 'You are making too many requests' }), 0) });
  assert.strictEqual(r.slow, true);
  assert.strictEqual((await pool.query("select enriched_at from companies where id = 'swile'")).rows[0].enriched_at, null);
});

test('the page has the five Market filters', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const f of ["id:'vertical'", "id:'erp'", "id:'size'", "id:'region'", "id:'family'"]) assert.ok(html.includes(f), f);
  assert.match(html, /id="mkf-tiles"/);
});
