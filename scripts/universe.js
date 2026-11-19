'use strict';
/* The company universe (Synapse metadata design, Nov 2026): the denominator that turns "found for X companies" into "found for X of N".
 * France: every active legal unit the INSEE classes as large (GE) or mid-size (ETI), from recherche-entreprises.api.gouv.fr.
 * United States: every company with a ticker in SEC EDGAR, with its filer category (large accelerated, accelerated, other) read from its
 *   submissions; blank-check companies and funds are left out.
 * Each row keeps its registry id, link and source. A universe row is linked to a company on the map by registry id (scripts/registry.js)
 * or by the same name key, never by a guess. Loaded a few pages at a time inside the crawler's run, politely, and refreshed yearly.
 * Known lean, shown on the page: France counts legal units, so a group's French subsidiaries are separate rows; the US list is listed
 * companies only. */
const { compKey } = require('./market');
const { UA } = require('./registry');

const s = (v, max = 200) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const pause = ms => new Promise(r => setTimeout(r, ms));
function bases(cfg = {}) {
  return {
    fr: (cfg.frBase || process.env.REGISTRY_FR_BASE || 'https://recherche-entreprises.api.gouv.fr').replace(/\/$/, ''),
    secFiles: (cfg.secFiles || process.env.REGISTRY_SEC_FILES || 'https://www.sec.gov').replace(/\/$/, ''),
    secData: (cfg.secData || process.env.REGISTRY_SEC_DATA || 'https://data.sec.gov').replace(/\/$/, ''),
    wait: cfg.registryPauseMs != null ? cfg.registryPauseMs : 400
  };
}
async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw Object.assign(new Error('universe ' + r.status + ' ' + url), { status: r.status });
  return r.json();
}
const FR_CATS = [['GE', 'Large'], ['ETI', 'Mid-size']];
const FR_PER_PAGE = 25, FR_MAX_RESULTS = 10000;
/* SEC filer categories as EDGAR writes them */
function usBand(category) {
  const c = String(category || '').toLowerCase();
  if (/^large accelerated/.test(c)) return 'Large';
  if (/^accelerated/.test(c)) return 'Mid-size';
  return c ? 'Small' : '';
}
const US_SKIP_SIC = new Set(['6770', '6722', '6726']);   /* blank checks, open-end funds, other investment offices */

async function cursor(pool, key) {
  return (await pool.query('select * from universe_cursors where key = $1', [key])).rows[0] || { key, page: 0, done: false, at: null };
}
async function saveCursor(pool, key, page, done) {
  await pool.query(`insert into universe_cursors (key, page, done, at) values ($1,$2,$3,now())
    on conflict (key) do update set page = excluded.page, done = excluded.done, at = now()`, [key, page, done]);
}
/* a finished list is read again after a year */
async function due(pool, key) {
  const c = await cursor(pool, key);
  if (c.done && c.at && Date.now() - new Date(c.at).getTime() > 365 * 864e5) { await saveCursor(pool, key, 0, false); return { page: 0, done: false }; }
  return c;
}

async function loadFrance(pool, B, pages, out) {
  for (const [cat, band] of FR_CATS) {
    const key = 'FR:' + cat;
    let c = await due(pool, key);
    while (!c.done && pages > 0) {
      const page = c.page + 1;
      const j = await getJson(B.fr + '/search?categorie_entreprise=' + cat + '&etat_administratif=A&per_page=' + FR_PER_PAGE + '&page=' + page);
      pages--; out.pages++;
      const rows = j.results || [];
      for (const r of rows) {
        if (!r.siren || (r.etat_administratif && r.etat_administratif !== 'A')) continue;
        const fin = r.finances || {}, year = Object.keys(fin).sort().pop();
        await pool.query(`insert into universe (id, name, country, band, category, headcount, revenue, revenue_year, activity, url, source)
          values ($1,$2,'France',$3,$4,$5,$6,$7,$8,$9,'INSEE Sirene, via recherche-entreprises.api.gouv.fr')
          on conflict (id) do update set name = excluded.name, band = excluded.band, category = excluded.category, headcount = excluded.headcount,
            revenue = excluded.revenue, revenue_year = excluded.revenue_year, activity = excluded.activity, fetched_at = now()`,
        ['FR:' + r.siren, s(r.nom_complet || r.nom_raison_sociale, 160), band, cat, s(r.tranche_effectif_salarie, 4),
          year && fin[year] && fin[year].ca != null ? Number(fin[year].ca) : null, year || '', s(r.activite_principale, 10),
          'https://annuaire-entreprises.data.gouv.fr/entreprise/' + r.siren]);
        out.rows++;
      }
      const done = !rows.length || page * FR_PER_PAGE >= Math.min(Number(j.total_results) || 0, FR_MAX_RESULTS);
      await saveCursor(pool, key, page, done);
      c = { page, done };
      await pause(B.wait);
    }
  }
}
async function loadUS(pool, B, n, out) {
  const key = 'US:tickers';
  const c = await due(pool, key);
  if (!c.done) {
    const j = await getJson(B.secFiles + '/files/company_tickers_exchange.json');
    out.pages++;
    for (const [cik, name, ticker, exchange] of j.data || []) {
      if (!cik || !exchange) continue;
      const id = 'US:' + String(cik).padStart(10, '0');
      await pool.query(`insert into universe (id, name, country, ticker, exchange, url, source) values ($1,$2,'United States',$3,$4,$5,'SEC EDGAR')
        on conflict (id) do update set name = excluded.name, ticker = excluded.ticker, exchange = excluded.exchange, fetched_at = now()`,
      [id, s(name, 160), s(ticker, 12), s(exchange, 20), 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + String(cik).padStart(10, '0')]);
      out.rows++;
    }
    await saveCursor(pool, key, 1, true);
  }
  /* the filer category, a few companies per run */
  const todo = (await pool.query("select id from universe where country = 'United States' and category = '' and not skipped order by fetched_at limit $1", [n])).rows;
  for (const r of todo) {
    try {
      const sub = await getJson(B.secData + '/submissions/CIK' + r.id.slice(3) + '.json');
      out.pages++;
      const skip = US_SKIP_SIC.has(String(sub.sic || ''));
      const cat = s(sub.category, 60) || 'Not stated';
      await pool.query('update universe set category = $2, band = $3, industry = $4, activity = $5, skipped = $6, fetched_at = now() where id = $1',
        [r.id, cat, usBand(cat), s(sub.sicDescription, 120), s(sub.sic, 6), skip]);
    } catch (e) {
      out.errors.push(r.id + ': ' + s(e.message, 160));
      if (e.status === 429 || e.status === 403) break;
      await pool.query("update universe set category = 'Not found', fetched_at = now() where id = $1", [r.id]);
    }
    await pause(B.wait);
  }
}
/* universe rows meet the map by registry id first, then by the same name key */
async function link(pool) {
  await pool.query("update universe u set company_id = c.id from companies c where c.registry <> '' and c.registry = u.id and u.company_id is distinct from c.id");
  const keys = new Set((await pool.query('select id from companies where not hidden')).rows.map(r => r.id));
  const rows = (await pool.query('select id, name from universe where company_id is null')).rows;
  let n = 0;
  for (const r of rows) { const k = compKey(r.name); if (k && keys.has(k)) { await pool.query('update universe set company_id = $2 where id = $1 and company_id is null', [r.id, k]); n++; } }
  return n;
}
async function grow(pool, cfg = {}, stats = {}) {
  const B = bases(cfg);
  const out = stats.universe = stats.universe || { pages: 0, rows: 0, linked: 0, errors: [] };
  try { await loadFrance(pool, B, cfg.universePages != null ? cfg.universePages : 8, out); } catch (e) { out.errors.push('FR: ' + s(e.message, 200)); }
  try { await loadUS(pool, B, cfg.universeUS != null ? cfg.universeUS : 60, out); } catch (e) { out.errors.push('US: ' + s(e.message, 200)); }
  out.linked = await link(pool);
  return out;
}

/* ---------- for the page: what share of the universe each system is found at, per country and band ---------- */
async function coverage(pool) {
  const base = (await pool.query(`select country, band, count(*)::int n, count(company_id)::int on_map,
      count(*) filter (where exists (select 1 from installs i where i.company_id = u.company_id and i.status in ('live', 'implementing')))::int with_system
    from universe u where not skipped and band in ('Large', 'Mid-size') group by country, band order by country, band`)).rows;
  const bySystem = (await pool.query(`select u.country, u.band, i.system, count(distinct u.id)::int n,
      count(distinct u.id) filter (where i.evidence @> '[{"level":"declared"}]')::int declared
    from universe u join installs i on i.company_id = u.company_id and i.status in ('live', 'implementing') and i.system <> ''
    where not u.skipped and u.band in ('Large', 'Mid-size') group by u.country, u.band, i.system`)).rows;
  const loading = (await pool.query("select key, page, done from universe_cursors")).rows;
  const pendingUS = (await pool.query("select count(*)::int n from universe where country = 'United States' and category = '' and not skipped")).rows[0].n;
  return { asOf: new Date().toISOString().slice(0, 10), base, bySystem, loading, pendingUS,
    note: 'France counts legal units (a group\'s French subsidiaries are separate rows). The United States counts listed companies only, by SEC filer category.' };
}

module.exports = { grow, coverage, link, usBand };
