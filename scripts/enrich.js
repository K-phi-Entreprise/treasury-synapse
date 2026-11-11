'use strict';
/* Company profiles for the Market filters, from Wikidata: industry -> vertical, employees -> size band, country -> region.
 * A match needs the same name (label or alias) and an item that looks like an organisation; otherwise the company stays
 * "Unknown" rather than guessed. Polite to Wikimedia: one company at a time, a pause between calls, a named user agent,
 * and a back-off when asked to slow down. Runs in the web process in small batches (ENRICH=off disables it). */
const { compKey } = require('./market');

const API = 'https://www.wikidata.org/w/api.php';
const UA = 'TreasurySynapse/1.0 (https://synapse.k-phi.com; public-sources map of treasury technology)';
const VERTICALS = [
  ['Commodities & trading', /commodit|trading company|metals trad|energy trad|agribusiness|grain|physical trad/],
  ['Energy & utilities', /energy|utilit|oil|natural gas|petrol|electric power|electricity|power (generation|station|compan)|renewable|nuclear|mining|coal|wind power|solar/],
  ['Pharma & healthcare', /pharma|health|medic|hospital|biotech|life science|diagnost|veterinar|clinic/],
  ['Financial services', /bank|financ|insur|asset management|invest|payment|credit|lending|fintech|stock exchange|mortgage/],
  ['Technology & software', /software|information technology|internet|computer|semiconductor|electronic|technology|video game|cloud|data|cybersecurity|it service/],
  ['Telecom & media', /telecom|media|broadcast|publish|entertainment|film|music|advertis|news|television|radio/],
  ['Food & beverage', /food|beverage|drink|brew|wine|spirit|dairy|agricultur|confection|bakery|meat|coffee|snack/],
  ['Consumer & retail', /retail|consumer|fashion|apparel|cosmetic|luxury|clothing|e-commerce|supermarket|toy|furniture|jewel|footwear|personal care|household/],
  ['Transport & logistics', /transport|logistic|shipping|airline|aviation|railway|freight|travel|airport|courier|mobility/],
  ['Automotive & aerospace', /automotive|vehicle|automobile|car manufact|aerospace|defen[cs]e/],
  ['Chemicals & materials', /chemical|material|plastic|paper|packaging|steel|glass|cement|metal/],
  ['Industrials & manufacturing', /manufactur|industr|engineering|machin|equipment|conglomerate/],
  ['Real estate & construction', /real estate|construction|building|property|housing|infrastructure|architect/],
  ['Professional services', /consult|accounting|legal|law firm|staffing|recruit|business service|outsourc|human resource|employment agency/],
  ['Hospitality & leisure', /hotel|hospitality|restaurant|leisure|gambling|casino|tourism|sport|event/],
  ['Public sector & non-profit', /government|public sector|public body|non-profit|nonprofit|charit|university|education|research institut|ngo|foundation|municipal|agency/]
];
function verticalOf(texts) {
  for (const t of texts) {
    const l = String(t || '').toLowerCase();
    if (!l) continue;
    for (const [v, re] of VERTICALS) if (re.test(l)) return v;
  }
  return '';
}
function sizeOf(n) {
  if (!(n > 0)) return '';
  return n < 250 ? 'Under 250' : n < 1000 ? '250 to 1,000' : n < 5000 ? '1,000 to 5,000' : n < 20000 ? '5,000 to 20,000' : '20,000 and more';
}
const COUNTRY = { Q30: ['United States', 'United States'], Q145: ['United Kingdom', 'United Kingdom'], Q142: ['France', 'France'],
  Q183: ['Germany', 'DACH'], Q40: ['Austria', 'DACH'], Q39: ['Switzerland', 'DACH'], Q55: ['Netherlands', 'Benelux'], Q31: ['Belgium', 'Benelux'], Q32: ['Luxembourg', 'Benelux'],
  Q34: ['Sweden', 'Nordics'], Q20: ['Norway', 'Nordics'], Q35: ['Denmark', 'Nordics'], Q33: ['Finland', 'Nordics'], Q189: ['Iceland', 'Nordics'],
  Q29: ['Spain', 'Southern Europe'], Q38: ['Italy', 'Southern Europe'], Q45: ['Portugal', 'Southern Europe'], Q41: ['Greece', 'Southern Europe'], Q233: ['Malta', 'Southern Europe'], Q229: ['Cyprus', 'Southern Europe'],
  Q408: ['Australia', 'Asia-Pacific'], Q664: ['New Zealand', 'Asia-Pacific'], Q17: ['Japan', 'Asia-Pacific'], Q148: ['China', 'Asia-Pacific'], Q668: ['India', 'Asia-Pacific'], Q334: ['Singapore', 'Asia-Pacific'],
  Q833: ['Malaysia', 'Asia-Pacific'], Q884: ['South Korea', 'Asia-Pacific'], Q8646: ['Hong Kong', 'Asia-Pacific'], Q865: ['Taiwan', 'Asia-Pacific'], Q252: ['Indonesia', 'Asia-Pacific'], Q869: ['Thailand', 'Asia-Pacific'],
  Q928: ['Philippines', 'Asia-Pacific'], Q881: ['Vietnam', 'Asia-Pacific'] };
/* properties that only organisations carry; people, places and disambiguation pages are refused */
const ORG_PROPS = ['P452', 'P1128', 'P159', 'P749', 'P355', 'P169', 'P1454', 'P414', 'P1278', 'P2139'];
const NOT_ORG = new Set(['Q5', 'Q4167410', 'Q486972', 'Q515', 'Q6256', 'Q532', 'Q3957', 'Q1549591', 'Q13442814', 'Q482994', 'Q7397', 'Q101352', 'Q4167836', 'Q13406463', 'Q11424', 'Q7725634']);
const VERSION = 3;   /* 3: the country is where the headquarters are, not a listing or a market */   /* 2: the best-known organisation of that name wins (most Wikipedia articles), not the first hit */

const ids = (claims, p) => ((claims && claims[p]) || []).map(c => c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id).filter(Boolean);
function employeesOf(claims) {
  const list = ((claims && claims.P1128) || []).filter(c => c.mainsnak && c.mainsnak.datavalue);
  if (!list.length) return null;
  const when = c => { const q = c.qualifiers && c.qualifiers.P585 && c.qualifiers.P585[0]; return q && q.datavalue ? String(q.datavalue.value.time || '') : ''; };
  const best = list.find(c => c.rank === 'preferred') || list.slice().sort((a, b) => when(b).localeCompare(when(a)))[0];
  const n = Math.round(Math.abs(Number(String(best.mainsnak.datavalue.value.amount || '').replace('+', ''))));
  return n > 0 ? n : null;
}

function client(fetchImpl = fetch, delayMs = 1100) {
  let last = 0;
  const labels = new Map();
  async function get(params) {
    const wait = last + delayMs - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const r = await fetchImpl(API + '?' + new URLSearchParams(Object.assign({ format: 'json', origin: '*' }, params)), { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (r.status === 429 || r.status === 503) { const e = new Error('slow down'); e.slow = true; throw e; }
    const text = await r.text();
    if (!r.ok || /too many requests/i.test(text.slice(0, 200))) { const e = new Error('wikidata ' + r.status); e.slow = r.status === 429 || /too many/i.test(text); throw e; }
    return JSON.parse(text);
  }
  /* the country of a place (a headquarters city): its own P17 */
  const placeCountry = new Map();
  async function countryOfPlace(id) {
    if (placeCountry.has(id)) return placeCountry.get(id);
    const j = await get({ action: 'wbgetentities', ids: id, props: 'claims' });
    const e = j.entities && j.entities[id];
    const c = e && e.claims ? (ids(e.claims, 'P17')[0] || '') : '';
    placeCountry.set(id, c); return c;
  }
  async function labelsFor(list) {
    const need = [...new Set(list)].filter(id => !labels.has(id));
    for (let i = 0; i < need.length; i += 50) {
      const j = await get({ action: 'wbgetentities', ids: need.slice(i, i + 50).join('|'), props: 'labels', languages: 'en' });
      for (const [id, e] of Object.entries(j.entities || {})) labels.set(id, (e.labels && e.labels.en && e.labels.en.value) || '');
    }
    return list.map(id => labels.get(id) || '');
  }
  /* the organisation item for a name, or null */
  async function find(name) {
    const key = compKey(name);
    const s = await get({ action: 'wbsearchentities', search: name, language: 'en', uselang: 'en', type: 'item', limit: '7' });
    const cands = (s.search || []).filter(x => compKey(x.label) === key || (x.match && compKey(x.match.text) === key)).map(x => x.id);
    if (!cands.length) return null;
    const j = await get({ action: 'wbgetentities', ids: cands.join('|'), props: 'claims|labels|descriptions|sitelinks', languages: 'en' });
    const ok = [];
    for (const id of cands) {
      const e = j.entities && j.entities[id]; if (!e || !e.claims) continue;
      if (ids(e.claims, 'P31').some(q => NOT_ORG.has(q))) continue;
      if (!ORG_PROPS.some(p => e.claims[p])) continue;
      ok.push({ id, claims: e.claims, description: (e.descriptions && e.descriptions.en && e.descriptions.en.value) || '', links: Object.keys(e.sitelinks || {}).length });
    }
    /* a vendor's customer is more often the well-known one: most Wikipedia articles first */
    ok.sort((a, b) => b.links - a.links);
    return ok[0] || null;
  }
  return { get, find, labelsFor, countryOfPlace };
}

async function enrichOne(pool, wd, c) {
  /* an earlier match is redone from scratch: what it set is cleared first */
  if (c.wikidata) await pool.query("update companies set vertical = '', size = '', employees = null, country = '', region = 'Unknown', wikidata = '' where id = $1", [c.id]);
  const hit = await wd.find(c.name);
  if (!hit) {
    await pool.query("update companies set enriched_at = now(), enrich_v = $2, enrich_note = 'no matching organisation on Wikidata', updated_at = now() where id = $1", [c.id, VERSION]);
    return { id: c.id, matched: false };
  }
  const industries = await wd.labelsFor(ids(hit.claims, 'P452'));
  const kinds = await wd.labelsFor(ids(hit.claims, 'P31'));
  const vertical = verticalOf(industries.concat(kinds, [hit.description, c.industry]));
  const employees = employeesOf(hit.claims);
  const preferred = p => { const l = ((hit.claims && hit.claims[p]) || []).filter(x => x.mainsnak && x.mainsnak.datavalue); const b = l.find(x => x.rank === 'preferred') || l[0]; return b ? b.mainsnak.datavalue.value.id : ''; };
  const hq = preferred('P159');
  /* the headquarters' country, unless it is a former state (not on the list) while the company's own country is */
  const hqc = hq && wd.countryOfPlace ? await wd.countryOfPlace(hq) : '';
  const own = preferred('P17') || preferred('P495') || '';
  const cq = (hqc && (COUNTRY[hqc] || !COUNTRY[own]) ? hqc : own) || hqc;
  const country = COUNTRY[cq] ? COUNTRY[cq][0] : (cq ? (await wd.labelsFor([cq]))[0] : '');
  const region = COUNTRY[cq] ? COUNTRY[cq][1] : (cq ? 'Other' : '');
  await pool.query(`update companies set wikidata = $2, vertical = case when vertical = '' then $3 else vertical end,
      employees = coalesce(employees, $4), size = case when size = '' then $5 else size end, country = case when country = '' then $6 else country end,
      region = case when region = 'Unknown' and $7 <> '' then $7 else region end, industry = case when industry = '' then $8 else industry end,
      enriched_at = now(), enrich_v = $9, enrich_note = '', updated_at = now() where id = $1`,
  [c.id, hit.id, vertical, employees, sizeOf(employees), country, region, (industries[0] || '').slice(0, 80), VERSION]);
  return { id: c.id, matched: true, wikidata: hit.id, vertical, employees, country };
}

/* companies never looked up first, those with the most facts first; misses are retried after 60 days */
async function enrichBatch(pool, { limit = 8, wd = client() } = {}) {
  const rows = (await pool.query(`select c.id, c.name, c.industry, c.wikidata from companies c where not c.hidden and (c.enriched_at is null or c.enrich_v < $2 or (c.wikidata = '' and c.enrich_v < 99 and c.enriched_at < now() - interval '60 days'))
    order by c.enriched_at nulls first, (select count(*) from installs i where i.company_id = c.id) desc, c.added_at limit $1`, [limit, VERSION])).rows;
  const out = { looked: 0, matched: 0, slow: false };
  for (const c of rows) {
    try { const r = await enrichOne(pool, wd, c); out.looked++; if (r.matched) out.matched++; }
    catch (e) { if (e.slow) { out.slow = true; break; } await pool.query("update companies set enriched_at = now(), enrich_v = $3, enrich_note = $2 where id = $1", [c.id, String(e.message).slice(0, 200), VERSION]); }
  }
  return out;
}

/* the web process runs it in the background: a batch a minute, slower after a "slow down" */
function start(pool, { everyMs = 60000, limit = 8, onChange } = {}) {
  let wait = everyMs, timer = null;
  const wd = client();
  const tick = async () => {
    try {
      const r = await enrichBatch(pool, { limit, wd });
      if (r.looked && onChange) onChange();
      wait = r.slow ? Math.min(wait * 2, 30 * 60000) : everyMs;
    } catch (e) { wait = Math.min(wait * 2, 30 * 60000); }
    timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, 15000);
  return () => clearTimeout(timer);
}

module.exports = { verticalOf, sizeOf, employeesOf, client, enrichBatch, start, VERTICALS, VERSION };
