'use strict';
/* Public companies (Synapse metadata design, Nov 2026): a deepening of the market map, every value flagged as coming from a registry or a filing.
 * - profiles: companies already on the map get their registry identity and attributes, on an exact name match only
 *     United Kingdom: Companies House (company number, type, industry codes, last accounts category), with COMPANIES_HOUSE_KEY
 *     France: recherche-entreprises.api.gouv.fr (SIREN, category GE/ETI/PME, headcount band, revenue, activity code)
 *     United States: SEC EDGAR (CIK, ticker, exchange, industry code, state)
 *   A registry value never overwrites what a person corrected by hand; it fills empty fields and is shown with its own link.
 * - filings: one EDGAR full-text search per vendor name (10-K, 20-F, 40-F). The code reads the filing itself, keeps the passages
 *   around the name, and one model call says whether the filer runs the system for its own finance. The extract must appear word for
 *   word in the passages, otherwise nothing is written. A filing that names a system the filer runs is declared evidence (kind filing).
 * Polite to both registries: a named user agent with a contact, a pause between calls, small batches inside the crawler's run. */
const { compKey, canonSystem, upsertInstall, NOT_A_USER } = require('./market');

const UA = 'TreasurySynapse/1.0 (https://synapse.k-phi.com; vincent@k-phi.com)';
const s = (v, max = 300) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const pause = ms => new Promise(r => setTimeout(r, ms));

function bases(cfg = {}) {
  return {
    fr: (cfg.frBase || process.env.REGISTRY_FR_BASE || 'https://recherche-entreprises.api.gouv.fr').replace(/\/$/, ''),
    secFiles: (cfg.secFiles || process.env.REGISTRY_SEC_FILES || 'https://www.sec.gov').replace(/\/$/, ''),
    secData: (cfg.secData || process.env.REGISTRY_SEC_DATA || 'https://data.sec.gov').replace(/\/$/, ''),
    uk: (cfg.ukBase || process.env.REGISTRY_UK_BASE || 'https://api.company-information.service.gov.uk').replace(/\/$/, ''),
    ukKey: cfg.companiesHouseKey != null ? cfg.companiesHouseKey : (process.env.COMPANIES_HOUSE_KEY || ''),
    secSearch: (cfg.secSearch || process.env.REGISTRY_SEC_SEARCH || 'https://efts.sec.gov').replace(/\/$/, ''),
    wait: cfg.registryPauseMs != null ? cfg.registryPauseMs : 400
  };
}
async function getJson(url, auth) {
  const headers = { 'user-agent': UA, accept: 'application/json' };
  /* Companies House: the key is the Basic user name, with an empty password */
  if (auth) headers.authorization = 'Basic ' + Buffer.from(auth + ':').toString('base64');
  const r = await fetch(url, { headers });
  if (!r.ok) throw Object.assign(new Error('registry ' + r.status + ' ' + url), { status: r.status });
  return r.json();
}

/* INSEE headcount bands (tranche_effectif_salarie) */
const FR_BANDS = { '00': [0, 0], '01': [1, 2], '02': [3, 5], '03': [6, 9], '11': [10, 19], '12': [20, 49], '21': [50, 99], '22': [100, 199], '31': [200, 249],
  '32': [250, 499], '41': [500, 999], '42': [1000, 1999], '51': [2000, 4999], '52': [5000, 9999], '53': [10000, null] };
function frSize(band) {
  const b = FR_BANDS[band]; if (!b) return '';
  const lo = b[0];
  return lo < 250 ? 'Under 250' : lo < 1000 ? '250 to 1,000' : lo < 5000 ? '1,000 to 5,000' : lo < 10000 ? '5,000 to 20,000' : '';
}
function frBandText(band) { const b = FR_BANDS[band]; return b ? (b[1] == null ? b[0].toLocaleString('en') + ' and more' : b[0].toLocaleString('en') + ' to ' + b[1].toLocaleString('en')) : ''; }

/* ---------- profiles ---------- */
async function profileFrance(pool, c, B) {
  const j = await getJson(B.fr + '/search?q=' + encodeURIComponent(c.name) + '&per_page=10');
  const hit = (j.results || []).find(r => [r.nom_complet, r.nom_raison_sociale, r.sigle].some(n => n && compKey(n) === c.id) && r.siren);
  if (!hit) return null;
  const fin = hit.finances || {}, year = Object.keys(fin).sort().pop();
  const band = hit.tranche_effectif_salarie || '';
  return {
    registry: 'FR:' + hit.siren, url: 'https://annuaire-entreprises.data.gouv.fr/entreprise/' + hit.siren, country: 'France', region: 'France', size: frSize(band),
    attrs: { source: 'INSEE Sirene, via recherche-entreprises.api.gouv.fr', siren: hit.siren, category: hit.categorie_entreprise || '', headcount: frBandText(band),
      headcountYear: hit.annee_tranche_effectif_salarie || '', activity: hit.activite_principale || '',
      revenue: year && fin[year] && fin[year].ca != null ? Number(fin[year].ca) : null, revenueYear: year || '', currency: 'EUR' }
  };
}
/* United Kingdom: Companies House (company number, status, type, industry codes, the category of the last accounts filed).
 * The register holds no headcount or revenue, so no size band is set from it; the accounts category is shown as filed. */
const UK_ACCOUNTS = { full: 'Full accounts', group: 'Group accounts', medium: 'Medium-sized company accounts', small: 'Small company accounts',
  'micro-entity': 'Micro-entity accounts', 'total-exemption-full': 'Total exemption accounts', 'total-exemption-small': 'Total exemption accounts',
  'audit-exemption-subsidiary': 'Audit-exempt subsidiary accounts', dormant: 'Dormant company accounts', 'unaudited-abridged': 'Abridged accounts', 'audited-abridged': 'Abridged accounts' };
async function profileUK(pool, c, B) {
  if (!B.ukKey) return null;
  const j = await getJson(B.uk + '/search/companies?q=' + encodeURIComponent(c.name) + '&items_per_page=20', B.ukKey);
  const hit = (j.items || []).find(r => r.company_number && r.company_status === 'active' && compKey(r.title) === c.id);
  if (!hit) return null;
  await pause(B.wait);
  const p = await getJson(B.uk + '/company/' + encodeURIComponent(hit.company_number), B.ukKey);
  const acc = (p.accounts && p.accounts.last_accounts) || {};
  return {
    registry: 'UK:' + hit.company_number, url: 'https://find-and-update.company-information.service.gov.uk/company/' + hit.company_number,
    country: 'United Kingdom', region: 'United Kingdom', size: '',
    attrs: { source: 'Companies House', number: hit.company_number, type: p.type || hit.company_type || '', sic: (p.sic_codes || []).join(', '),
      accounts: UK_ACCOUNTS[acc.type] || acc.type || '', accountsMadeUpTo: acc.made_up_to || '' }
  };
}
let TICKERS = null;
async function secTickers(B) {
  if (TICKERS && Date.now() - TICKERS.at < 864e5) return TICKERS.map;
  const j = await getJson(B.secFiles + '/files/company_tickers_exchange.json');
  const map = new Map();
  for (const row of j.data || []) { const [cik, name, ticker, exchange] = row; const k = compKey(name); if (k && !map.has(k)) map.set(k, { cik, name, ticker, exchange }); }
  TICKERS = { at: Date.now(), map };
  return map;
}
async function profileUS(pool, c, B) {
  const t = (await secTickers(B)).get(c.id);
  if (!t) return null;
  const cik = String(t.cik).padStart(10, '0');
  await pause(B.wait);
  const sub = await getJson(B.secData + '/submissions/CIK' + cik + '.json');
  const addr = (sub.addresses && sub.addresses.business) || {};
  const us = !addr.isForeignLocation;
  return {
    registry: 'US:' + cik, url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + cik, country: us ? 'United States' : '', region: us ? 'United States' : '', size: '',
    attrs: { source: 'SEC EDGAR', cik, ticker: t.ticker || '', exchange: t.exchange || '', industry: sub.sicDescription || '', sic: sub.sic || '',
      state: addr.stateOrCountry || '', filerCategory: sub.category || '' }
  };
}
/* a batch of companies on the map: France when the map already places them there, the SEC list for everyone (it is a name lookup in memory) */
async function profiles(pool, cfg = {}, stats = {}) {
  const B = bases(cfg), n = cfg.registryBatch != null ? cfg.registryBatch : 20;
  const out = stats.registry = stats.registry || { tried: 0, matched: 0, errors: [] };
  const rows = (await pool.query(`select id, name, country, region, size from companies where not hidden and registry = ''
    and (reg_tried_at is null or reg_tried_at < now() - interval '90 days') order by reg_tried_at nulls first, added_at limit $1`, [n])).rows;
  for (const c of rows) {
    out.tried++;
    let p = null;
    try {
      if (c.country === 'France' || c.region === 'France') { p = await profileFrance(pool, c, B); await pause(B.wait); }
      if (!p && (c.country === 'United Kingdom' || c.region === 'United Kingdom')) { p = await profileUK(pool, c, B); await pause(B.wait); }
      if (!p && (c.country === '' || c.country === 'United States' || c.region === 'United States' || c.region === 'Unknown')) p = await profileUS(pool, c, B);
    } catch (e) {
      out.errors.push(c.id + ': ' + s(e.message, 200));
      if (e.status === 429 || e.status === 403) break;
      continue;
    } finally { await pool.query('update companies set reg_tried_at = now() where id = $1', [c.id]); }
    if (!p) continue;
    out.matched++;
    /* registry values fill what is empty; a corrected country or size (enrich_v 99) stays */
    await pool.query(`update companies set registry = $2, registry_url = $3, reg_attrs = $4, reg_at = now(),
        country = case when country = '' and $5 <> '' and enrich_v <> 99 then $5 else country end,
        region = case when region = 'Unknown' and $6 <> '' and enrich_v <> 99 then $6 else region end,
        size = case when size = '' and $7 <> '' and enrich_v <> 99 then $7 else size end, updated_at = now() where id = $1`,
    [c.id, p.registry, p.url, JSON.stringify(p.attrs), p.country, p.region, p.size]);
    await pause(B.wait);
  }
  return out;
}

/* ---------- filings ---------- */
/* search terms: the vendor's distinctive names. Names that are ordinary words (Board, Cube, Bound, Statement, Round, Pigment, FIS, SAP alone)
 * would return every filing and are left out, the same rule for every vendor; the page says so. */
const SEC_TERMS = [
  ['Kyriba', 'Kyriba'], ['GTreasury', 'GTreasury'], ['Wallstreet Suite', 'ION Treasury'], ['Reval', 'ION Treasury'], ['Nomentia', 'Nomentia'], ['Agicap', 'Agicap'],
  ['Embat', 'Embat'], ['Atlar', 'Atlar'], ['Trovata', 'Trovata'], ['HighRadius', 'HighRadius'], ['Treasury Intelligence Solutions', 'TIS'], ['Kantox', 'Kantox'],
  ['FiREapps', 'FiREapps'], ['HedgeFlows', 'HedgeFlows'], ['Cashforce', 'Cashforce'], ['CashAnalytics', 'CashAnalytics'], ['AccessPay', 'AccessPay'], ['Serrala', 'Serrala'],
  ['Bellin', 'Coupa Treasury'], ['Coupa Treasury', 'Coupa Treasury'], ['Quantum treasury', 'FIS'], ['SAP Treasury', 'SAP Treasury'], ['Centime', 'Centime'], ['Tesorio', 'Tesorio'],
  ['Hazeltree', 'Hazeltree'], ['Derivative Path', 'Derivative Path'], ['Planixs', 'Planixs'], ['Salmon Software', 'Salmon Software'], ['Modern Treasury', 'Modern Treasury'],
  ['Anaplan', 'Anaplan'], ['OneStream', 'OneStream'], ['Adaptive Insights', 'Workday Adaptive Planning'], ['Adaptive Planning', 'Workday Adaptive Planning'],
  ['Jedox', 'Jedox'], ['Tagetik', 'CCH Tagetik'], ['Planful', 'Planful'], ['Vena Solutions', 'Vena'], ['Prophix', 'Prophix'], ['Abacum', 'Abacum'],
  ['Board International', 'Board'], ['Hyperion', 'Oracle EPM'], ['Oracle EPM', 'Oracle EPM'], ['SAP Analytics Cloud', 'SAP Analytics Cloud']
];
const FORMS = '10-K,20-F,40-F';
function passages(text, term, max = 3, span = 700) {
  const out = [], low = text.toLowerCase(), t = term.toLowerCase();
  let i = low.indexOf(t);
  while (i >= 0 && out.length < max) {
    const a = Math.max(0, i - span), b = Math.min(text.length, i + t.length + span);
    out.push(text.slice(a, b));
    i = low.indexOf(t, b);
  }
  return out;
}
const strip = html => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '\'').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#\d+;|&\w+;/g, ' ').replace(/\s+/g, ' ');
const filerName = d => s(String(d || '').replace(/\s*\((?:CIK|[A-Z.\-]{1,6})[^)]*\)/g, '').replace(/\s*\/[A-Z]{2}\/\s*$/, ''), 120);
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const JUDGE = {
  name: 'judge_filing',
  description: 'Say whether the filer itself runs the named system for its own finance, treasury or planning, from the passages only.',
  input_schema: { type: 'object', properties: {
    uses: { type: 'boolean', description: 'true only when the passages say the filer runs, is implementing, or replaced this system for its own use. A competitor list, a customer, a supplier described as a business partner, a portfolio company or a loan, an acquisition target, or the vendor itself: false.' },
    status: { type: 'string', enum: ['live', 'implementing', 'previous'] },
    extract: { type: 'string', description: 'The words of the passages that say so, copied exactly, under 30 words.' },
    note: { type: 'string', description: 'One factual sentence.' } }, required: ['uses'] }
};
async function judge(cfg, stats, filer, system, term, parts) {
  const { callApi, cost } = require('./crawl');
  const res = await callApi(cfg, { model: cfg.model, max_tokens: 600, tools: [JUDGE], tool_choice: { type: 'tool', name: 'judge_filing' },
    system: 'You read passages of a company\'s annual report filed with the SEC. Decide only from them. Never guess.',
    messages: [{ role: 'user', content: 'Filer: ' + filer + '\nSystem: ' + system + ' (searched as "' + term + '")\n\nPassages:\n' + parts.map((p, k) => '[' + (k + 1) + '] ' + p).join('\n\n') }] });
  stats.costUsd = (stats.costUsd || 0) + cost(cfg, res.usage); stats.calls = (stats.calls || 0) + 1;
  const b = (res.content || []).find(x => x.type === 'tool_use' && x.name === 'judge_filing');
  return (b && b.input) || { uses: false };
}
async function filings(pool, cfg, stats = {}, budgetLeft = Infinity) {
  const B = bases(cfg), per = cfg.filingsPerRun != null ? cfg.filingsPerRun : 3;
  const out = stats.filings = stats.filings || { read: 0, added: 0, rejected: 0, errors: [] };
  /* the search for one term at a time, oldest first; each hit is a market_sources row of kind 'sec_filing' so it is read once */
  const term = (await pool.query(`select url from market_sources where kind = 'sec_search' order by read_at nulls first, added_at limit 1`)).rows[0];
  if (term) {
    const t = term.url.slice(4);
    try {
      const j = await getJson(B.secSearch + '/LATEST/search-index?q=' + encodeURIComponent('"' + t + '"') + '&forms=' + FORMS + '&startdt=2019-01-01');
      for (const h of (j.hits && j.hits.hits) || []) {
        const [adsh, file] = String(h._id || '').split(':'), src = h._source || {};
        const cik = String((src.ciks || [])[0] || '').replace(/^0+/, '');
        if (!adsh || !file || !cik) continue;
        const url = B.secFiles + '/Archives/edgar/data/' + cik + '/' + adsh.replace(/-/g, '') + '/' + file;
        await pool.query(`insert into market_sources (url, label, kind, notes) values ($1,$2,'sec_filing',$3) on conflict (url) do nothing`,
          [url, 'Filing: ' + filerName((src.display_names || [])[0]) + ' ' + (src.form || '') + ' ' + (src.file_date || ''), JSON.stringify({ term: t, filer: filerName((src.display_names || [])[0]), form: src.form || '', date: src.file_date || '' })]);
      }
    } catch (e) { out.errors.push('search ' + t + ': ' + s(e.message, 200)); }
    await pool.query('update market_sources set read_at = now(), attempts = attempts + 1 where url = $1', [term.url]);
  }
  const todo = (await pool.query(`select * from market_sources where kind = 'sec_filing' and status = 'queued' order by added_at limit $1`, [per])).rows;
  for (const src of todo) {
    if ((stats.costUsd || 0) >= budgetLeft) break;
    const meta = JSON.parse(src.notes), system = (SEC_TERMS.find(x => x[0] === meta.term) || [meta.term, meta.term])[1];
    const key = compKey(meta.filer);
    let status = 'done', found = 0;
    try {
      if (!key || NOT_A_USER.test(key) || compKey(canonSystem(system).system) === key) { out.rejected++; }
      else {
        await pause(B.wait);
        const r = await fetch(src.url, { headers: { 'user-agent': UA } });
        if (!r.ok) throw Object.assign(new Error('filing ' + r.status), { status: r.status });
        const text = strip(await r.text()), parts = passages(text, meta.term);
        out.read++;
        if (!parts.length) out.rejected++;
        else {
          const v = await judge(cfg, stats, meta.filer, system, meta.term, parts);
          /* the extract must be in the passages word for word, or nothing is written */
          if (v.uses && v.extract && parts.some(p => norm(p).includes(norm(v.extract)))) {
            const w = await upsertInstall(pool, { company: meta.filer, system, status: ['live', 'implementing', 'previous'].includes(v.status) ? v.status : 'live', kind: 'filing',
              url: src.url, date: meta.date, extract: v.extract, note: v.note || (meta.form + ' filed ' + meta.date + ' names ' + system) }, 'sec');
            if (w.ok) { out.added++; found = 1; } else out.rejected++;
          } else out.rejected++;
        }
      }
    } catch (e) { out.errors.push(src.url + ': ' + s(e.message, 200)); status = src.attempts + 1 >= 2 ? 'failed' : 'queued'; if (e.status === 429 || e.status === 403) break; }
    await pool.query('update market_sources set status = $2, read_at = now(), attempts = attempts + 1, found = found + $3 where url = $1', [src.url, status, found]);
  }
  return out;
}
const SEC_SOURCES = SEC_TERMS.map(([t, sys]) => ({ url: 'sec:' + t, label: 'SEC filings (10-K, 20-F, 40-F) that name ' + t + ' (' + sys + ')', kind: 'sec_search' }));

module.exports = { profiles, profileUK, filings, passages, strip, filerName, frSize, SEC_TERMS, SEC_SOURCES, UA };
