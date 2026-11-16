'use strict';
/* AI ladder: the hand-kept data file follows its own rules, and the page and map payload carry it. */
const test = require('node:test');
const assert = require('node:assert');
const { aiMap, aiPage, load, slug } = require('../scripts/ai');

const RUNGS = ['answer', 'act', 'mcp', 'build'];
const OK = new Set(['available', 'limited', 'announced', 'none']);

test('every vendor has the four rungs, a known status, and a source for anything found', () => {
  const d = load();
  assert.ok(d.vendors.length >= 30);
  for (const v of d.vendors) {
    for (const r of RUNGS) {
      assert.ok(v[r] && OK.has(v[r].s), v.system + ' ' + r);
      if (v[r].s !== 'none') assert.match(v[r].src || '', /^https:\/\//, v.system + ' ' + r + ' needs a source');
      if (v[r].src) assert.ok(!/linkedin\.com/i.test(v[r].src), 'LinkedIn is never a source');
    }
  }
  assert.strictEqual(d.vendors.filter(v => v.self).length, 1, 'K-φ is marked as the site owner');
});

test('map payload keys systems by their map name and by alias, without the site owner', () => {
  const m = aiMap();
  assert.strictEqual(m.systems.Kyriba.mcp, load().vendors.find(v => v.system === 'Kyriba').mcp.s);
  assert.ok(m.systems.GTreasury && m.systems['Ripple Treasury']);
  assert.ok(!m.systems['K-φ']);
});

test('the page lists every vendor alphabetically with its sources, and shows K-φ apart', () => {
  const html = aiPage('https://synapse.example');
  for (const v of load().vendors) assert.ok(html.includes('id="src-' + slug(v.system) + '"'), v.system);
  assert.ok(html.indexOf('>Agicap<') < html.indexOf('>Kyriba<'));
  assert.ok(html.includes('runs this site'));
  assert.ok(!/—/.test(html.replace(/<style[\s\S]*?<\/style>/, '')), 'no em dashes in copy');
});
