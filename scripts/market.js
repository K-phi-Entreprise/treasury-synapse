'use strict';
/* Market angle: which company runs which system, each fact with the public page that says so.
 * - companies and installs live in their own tables; person cards add the pairs they attest ("uses" at their organisation)
 * - the harvester reads vendor case-study indexes, single case studies and job searches with the API's web tools
 *   and reports through one client tool, submit_market; the code keeps only items whose page was fetched in the session
 * Usage: node scripts/market.js --seed   (load data/market-seed.json and the source list; idempotent) */
const fs = require('fs');
const path = require('path');

/* ---------- names ---------- */
const SUFFIX = /\b(incorporated|inc|corp|corporation|company|co|plc|ltd|limited|llc|llp|lp|sa|sas|sarl|ag|se|gmbh|kg|kgaa|nv|bv|spa|s\.p\.a|ab|asa|oyj|as|pty|holdings?|group|gruppe|groupe|the)\b/g;
function compKey(name) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ');
  const k = s.replace(/[.,']/g, '').replace(SUFFIX, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (k || s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 80);
}
/* vendor-level names, so "Reval", "Wallstreet Suite" and "ION Treasury" meet on one hub; the product stays on the line */
const ALIASES = [
  [/^(ripple treasury.*|gtreasury.*)$/i, 'GTreasury'],
  [/^(ion( treasury)?|reval( cloud platform)?|wall ?street suite|wallstreet|it2|its|city financials|openlink|treasura|ion cloud)\b.*$/i, 'ION Treasury'],
  [/^(bellin|tm5|coupa( treasury)?)\b.*$/i, 'Coupa Treasury'],
  [/^(fis( treasury.*)?|quantum|integrity|sungard( treasury)?)\b.*$/i, 'FIS'],
  [/^sap\b.*(treasury|trm|in-house cash|bank communication|cash management).*$/i, 'SAP Treasury'],
  [/^kyriba\b.*$/i, 'Kyriba'],
  [/^nomentia\b.*$/i, 'Nomentia'],
  [/^(tis|treasury intelligence solutions)\b.*$/i, 'TIS'],
  [/^highradius\b.*$/i, 'HighRadius'],
  [/^(microsoft )?excel|^spreadsheets?$|^manual spreadsheets$/i, 'Excel']
];
const PRODUCT_FROM = /^(reval|wall ?street suite|it2|its|city financials|openlink|treasura|ion cloud|quantum|integrity|bellin|tm5)\b/i;
function canonSystem(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!s) return { system: '', product: '' };
  for (const [re, name] of ALIASES) if (re.test(s)) return { system: name, product: PRODUCT_FROM.test(s) && name !== s ? s : '' };
  return { system: s, product: '' };
}

const STATUS = ['live', 'implementing', 'selecting', 'previous'];
const KINDS = ['case_study', 'press', 'job_post', 'talk', 'article', 'filing'];
const REGIONS = ['United States', 'United Kingdom', 'France', 'DACH', 'Benelux', 'Nordics', 'Southern Europe', 'Asia-Pacific', 'Other', 'Unknown'];
/* advisers and vendors show up in job posts and case studies; they are not users of the systems they implement */
const NOT_A_USER = /^(ey|ernst-and-young|pwc|pricewaterhousecoopers|deloitte|kpmg|accenture|zanders|clearsulting|bearingpoint|capgemini|rsm|grant-thornton|bdo|mazars|forvis-mazars|protiviti|talan|absys-cyborg|cognizant|infosys|wipro|tata-consultancy-services|genpact|redbridge|strategic-treasurer|actualize-consulting|treasury-alliance|real-treasury)$/;
const s = (v, max = 300) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const dateish = v => (/^(19|20)\d\d(-\d\d){0,2}$/.test(s(v)) ? s(v) : '');
const httpUrl = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch (e) { return ''; } };

/* one fact in; merges with what is there: evidence is added by URL, empty fields are filled, nothing is overwritten */
async function upsertInstall(db, r, source = 'harvest') {
  const name = s(r.company, 120), key = compKey(name);
  const c = canonSystem(r.system);
  const status = STATUS.includes(r.status) ? r.status : 'live';
  const url = httpUrl(r.url);
  if (!key || !url) return { ok: false, reason: 'company and url are required' };
  if (!c.system && status !== 'selecting') return { ok: false, reason: 'no system' };
  if (NOT_A_USER.test(key)) return { ok: false, reason: 'an adviser, not a user' };
  if (c.system && compKey(c.system) === key) return { ok: false, reason: 'the vendor itself' };
  const kind = KINDS.includes(r.kind) ? r.kind : 'case_study';
  const region = REGIONS.includes(r.region) ? r.region : 'Unknown';
  const { verticalOf, sizeOf } = require('./enrich');
  const emp = Number(r.employees) > 0 ? Math.round(Number(r.employees)) : null;
  await db.query(`insert into companies (id, name, region, industry, vertical, employees, size) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (id) do update set region = case when companies.region = 'Unknown' then excluded.region else companies.region end,
      industry = case when companies.industry = '' then excluded.industry else companies.industry end,
      vertical = case when companies.vertical = '' then excluded.vertical else companies.vertical end,
      employees = coalesce(companies.employees, excluded.employees), size = case when companies.size = '' then excluded.size else companies.size end,
      updated_at = case when (companies.region = 'Unknown' and excluded.region <> 'Unknown') or (companies.industry = '' and excluded.industry <> '')
        or (companies.vertical = '' and excluded.vertical <> '') or (companies.employees is null and excluded.employees is not null) then now() else companies.updated_at end`,
  [key, name, region, s(r.industry, 80), verticalOf([r.industry]), emp, sizeOf(emp)]);
  const ev = { url, kind, date: dateish(r.date), note: s(r.note, 300) };
  const row = [key, c.system, status, s(r.product, 120) || c.product, dateish(r.since) || s(r.since, 10).replace(/[^0-9]/g, '').slice(0, 4), dateish(r.date),
    s(r.partner, 120), s(r.replaced, 120), s(r.person, 120), s(r.personTitle || r.person_title, 120), url, kind, s(r.note, 300), JSON.stringify([ev]), source];
  const old = (await db.query('select evidence, url from installs where company_id = $1 and system = $2 and status = $3', [key, c.system, status])).rows[0];
  if (!old) {
    await db.query(`insert into installs (company_id, system, status, product, since, date, partner, replaced, person, person_title, url, kind, note, evidence, source)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, row);
    return { ok: true, added: true, company: key };
  }
  const known = (old.evidence || []).some(x => x && x.url === url);
  /* a single story is better evidence to show than the vendor's list it came from */
  const upgrade = INDEX_URLS.has(old.url) && !INDEX_URLS.has(url);
  await db.query(`update installs set
      product = case when product = '' then $4 else product end, since = case when since = '' then $5 else since end,
      date = case when $6 > date then $6 else date end, partner = case when partner = '' then $7 else partner end,
      replaced = case when replaced = '' then $8 else replaced end, person = case when person = '' then $9 else person end,
      person_title = case when person_title = '' then $10 else person_title end,
      url = case when $16 then $11 else url end, kind = case when $16 then $12 else kind end,
      note = case when note = '' or ($16 and $13 <> '') then $13 else note end,
      evidence = case when $15 then evidence else evidence || $14::jsonb end, updated_at = now()
    where company_id = $1 and system = $2 and status = $3`, row.slice(0, 14).concat([known, upgrade]));
  return { ok: true, added: false, merged: !known, company: key };
}

/* ---------- where the harvester reads ---------- */
const CS = 'https://www.casestudies.com/company/';
/* One method for every vendor: its public customer stories (casestudies.com lists, its own reference pages) and one search for its
 * named customers in the press and in talks. No vendor gets more searches than another; searches that name no vendor come on top. */
const VENDORS = [
  ['Kyriba', ['kyriba']], ['GTreasury', ['gtreasury', 'ripple-treasury-powered-by-gtreasury']], ['ION Treasury', ['ion-treasury', 'ion', 'reval']],
  ['Nomentia', ['nomentia'], ['https://nomentia.com/references']], ['Agicap', ['agicap']], ['Embat', ['embat']], ['Atlar', ['atlar']], ['Trovata', ['trovata']],
  ['HighRadius', ['highradius']], ['TIS', ['treasury-intelligence-solutions-tis']], ['DataLog Finance', ['datalog-finance']], ['Coprocess', ['coprocess']],
  ['Kantox', ['kantox']], ['FiREapps', ['fireapps']], ['HedgeFlows', ['hedgeflows']], ['Cashforce', ['cashforce']], ['CashAnalytics', ['cashanalytics']],
  ['Finance Active', ['finance-active']], ['AccessPay', ['accesspay']], ['Bottomline', ['bottomline-technologies']], ['Serrala', ['serrala']],
  ['Coupa Treasury', ['coupa-software']], ['FIS', ['fis']], ['SAP Treasury', ['sap']], ['Centime', ['centime']], ['Statement', ['statement']],
  ['Tesorio', ['tesorio']], ['Cashbook', ['cashbook']], ['Hazeltree', ['hazeltree']], ['Derivative Path', ['derivative-path']], ['Eurobase', ['eurobase']],
  ['Bound', ['bound']], ['ZenTreasury', ['zentreasury']], ['Planixs', ['planixs']], ['Salmon Software', ['salmon-software']], ['Visual Risk', ['visual-risk']],
  ['Round Treasury', ['round-treasury']], ['Nilus', ['nilus']], ['Modern Treasury', ['modern-treasury-corp']], ['Finastra', ['finastra']],
  ['Diapason', []], ['Piteco', []], ['Sage XRT', []], ['Allevo', []], ['Exalog', []], ['Cegid treasury', []], ['Treasury Next', []],
  /* EPM and FP&A */
  ['Anaplan', ['anaplan']], ['Board', ['board-international']], ['Pigment', ['pigment']], ['OneStream', ['onestream']], ['Workday Adaptive Planning', ['workday-adaptive-planning']],
  ['Jedox', ['jedox']], ['CCH Tagetik', ['cch-tagetik']], ['Planful', ['planful']], ['Vena', ['vena-solutions']], ['Prophix', ['prophix']], ['Abacum', ['abacum']],
  ['Cube', ['cube']], ['Oracle EPM', []], ['SAP Analytics Cloud', []]
];
/* the industries of the Market filters (scripts/enrich.js maps Wikidata industries onto them) */
const INDUSTRIES = ['Commodities & trading', 'Energy & utilities', 'Pharma & healthcare', 'Financial services', 'Technology & software', 'Telecom & media',
  'Food & beverage', 'Consumer & retail', 'Transport & logistics', 'Automotive & aerospace', 'Chemicals & materials', 'Industrials & manufacturing',
  'Real estate & construction', 'Professional services', 'Hospitality & leisure', 'Public sector & non-profit'];
const SOURCES = [].concat(
  ...VENDORS.map(([name, slugs, pages]) => slugs.map(v => ({ url: CS + v, label: 'Customer stories: ' + name, kind: 'index' }))
    .concat((pages || []).map(u => ({ url: u, label: 'Customer references: ' + name, kind: 'index' })))
    .concat([{ url: 'search:' + name + ' customer case study', label: 'Named customers of ' + name + ': its own reference pages, press releases, conference talks', kind: 'search' }])),
  [{ url: 'search:treasury management system implementation job post', label: 'Job posts asking someone to select or implement a TMS', kind: 'search' },
    { url: 'search:company selects treasury management system press release', label: 'Press releases: a company selects or goes live with a TMS', kind: 'search' },
    { url: 'search:treasury management system replaced spreadsheets case study', label: 'Case studies of moves from spreadsheets to a TMS', kind: 'search' }],
  /* one search per industry, the same for each, so no industry is favoured */
  INDUSTRIES.map(v => ({ url: 'search:' + v + ' treasury and finance systems case study', label: 'Organisations in ' + v + ' and the treasury and planning systems they run', kind: 'search' })));

const INDEX_URLS = new Set(SOURCES.filter(x => x.kind === 'index').map(x => x.url));

/* every data/market-seed*.json is loaded once; the first file predates the bookkeeping, so seed rows already there count as it */
async function seed(pool, dir = path.join(__dirname, '..', 'data')) {
  let n = 0;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^market-seed.*\.json$/.test(f)).sort() : [];
  const done = new Set((await pool.query('select file from market_seed_files')).rows.map(r => r.file));
  if (!done.has('market-seed.json') && (await pool.query("select count(*)::int n from installs where source = 'seed'")).rows[0].n > 0) {
    await pool.query("insert into market_seed_files (file, rows) values ('market-seed.json', 0) on conflict do nothing"); done.add('market-seed.json');
  }
  for (const f of files) {
    if (done.has(f)) continue;
    let k = 0;
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) { const x = await upsertInstall(pool, r, 'seed'); if (x.ok) k++; }
    await pool.query('insert into market_seed_files (file, rows) values ($1,$2) on conflict do nothing', [f, k]);
    n += k;
  }
  for (const x of SOURCES) await pool.query('insert into market_sources (url, label, kind) values ($1,$2,$3) on conflict (url) do nothing', [x.url, x.label, x.kind]);
  /* searches outside the method (an earlier, uneven list) are dropped */
  await pool.query("delete from market_sources where kind = 'search' and not (url = any($1))", [SOURCES.filter(x => x.kind === 'search').map(x => x.url)]);
  /* a vertical for companies whose industry is known but not yet mapped */
  const { verticalOf } = require('./enrich');
  for (const c of (await pool.query("select id, industry from companies where vertical = '' and industry <> ''")).rows) {
    const v = verticalOf([c.industry]); if (v) await pool.query('update companies set vertical = $2, updated_at = now() where id = $1', [c.id, v]);
  }
  return n;
}

/* ---------- for the page ---------- */
async function loadMarket(pool, since) {
  const p = since ? [since] : [];
  const companies = (await pool.query(`select * from companies where not hidden${since ? ' and updated_at > $1' : ''} order by added_at`, p)).rows;
  const installs = (await pool.query(`select i.* from installs i join companies c on c.id = i.company_id and not c.hidden${since ? ' where i.updated_at > $1' : ''} order by i.added_at`, p)).rows;
  const out = {
    companies: companies.map(c => ({ id: c.id, name: c.name, region: c.region, industry: c.industry, vertical: c.vertical, size: c.size, employees: c.employees, country: c.country,
      wikidata: c.wikidata, addedAt: c.added_at && c.added_at.toISOString() })),
    installs: installs.map(i => ({ company: i.company_id, system: i.system, status: i.status, product: i.product, since: i.since, date: i.date, partner: i.partner,
      replaced: i.replaced, person: i.person, personTitle: i.person_title, url: i.url, kind: i.kind, note: i.note, sources: (i.evidence || []).length, addedAt: i.added_at && i.added_at.toISOString() }))
  };
  if (since) return out;
  /* person cards: "uses X" at their organisation is a pair too; people at a company (now or before) are who to ask */
  const ppl = (await pool.query(`select p.id, p.org, p.region, p.segment, s.system, s.url, s.date from people p join person_systems s on s.person_id = p.id
    where not p.hidden and s.role = 'uses' and p.org <> '' and p.segment in ('Corporate treasury', 'Banks')`)).rows;
  const byKey = new Map(out.companies.map(c => [c.id, c]));
  for (const r of ppl) {
    const key = compKey(r.org), c = canonSystem(r.system);
    if (!key || !c.system || NOT_A_USER.test(key) || compKey(c.system) === key) continue;
    if (!byKey.has(key)) { const co = { id: key, name: r.org, region: r.region || 'Unknown', industry: r.segment === 'Banks' ? 'Financial services' : '', vertical: r.segment === 'Banks' ? 'Financial services' : '', size: '', employees: null, country: '', wikidata: '', addedAt: null }; byKey.set(key, co); out.companies.push(co); }
    if (!out.installs.some(i => i.company === key && i.system === c.system && i.status === 'live'))
      out.installs.push({ company: key, system: c.system, status: 'live', product: c.product, since: '', date: r.date || '', partner: '', replaced: '', person: '', personTitle: '',
        url: r.url || '', kind: 'person', note: 'From the card of someone who works there', sources: 1, personId: r.id, addedAt: null });
  }
  const staff = (await pool.query(`select p.id, p.org, null::text as past from people p where not p.hidden and p.org <> ''
    union all select r.person_id, r.org, coalesce(nullif(r.to_year, ''), 'before') from person_roles r join people p on p.id = r.person_id and not p.hidden where r.org <> ''`)).rows;
  const ids = new Set(out.companies.map(c => c.id)), people = {};
  for (const r of staff) {
    const key = compKey(r.org); if (!ids.has(key)) continue;
    const list = people[key] || (people[key] = []);
    const had = list.find(x => x.id === r.id);
    if (!had) list.push({ id: r.id, past: r.past || '' }); else if (!r.past) had.past = '';
  }
  out.companyPeople = people;
  return out;
}

/* ---------- the harvester ---------- */
const SUBMIT = {
  name: 'submit_market',
  description: 'Report which organisations run, implement, are selecting, or replaced which systems, as the pages you fetched in this session state. Call it exactly once, at the end. Every item must carry the URL of a page you fetched with web_fetch in this session.',
  input_schema: {
    type: 'object',
    properties: {
      notes: { type: 'string', description: 'Two or three sentences for the next run: what the page held, what was blocked.' },
      installs: { type: 'array', items: { type: 'object', properties: {
        company: { type: 'string', description: 'The organisation that uses the system for its own finance or treasury. Never the vendor, a consultancy or an integrator.' },
        system: { type: 'string', description: 'Product or vendor name (Kyriba, GTreasury, ION Treasury Reval, SAP Treasury, Excel). Empty only for a selection where no product is named.' },
        status: { type: 'string', enum: STATUS, description: 'live: runs it; implementing: project under way; selecting: choosing a system now or a shortlist; previous: what the organisation replaced.' },
        product: { type: 'string' }, since: { type: 'string', description: 'Go-live year if the page states it.' },
        date: { type: 'string', description: 'Date of the page or post, YYYY, YYYY-MM or YYYY-MM-DD.' },
        partner: { type: 'string', description: 'Implementation partner named by the page.' },
        replaced: { type: 'string', description: 'What it replaced, in the page\'s words (Excel, a legacy TMS, a named product).' },
        person: { type: 'string', description: 'A named employee of the organisation quoted or credited on the page.' }, person_title: { type: 'string' },
        region: { type: 'string', enum: REGIONS, description: 'Where the organisation is based.' }, industry: { type: 'string', description: 'Its industry in a few words (food retail, pharmaceuticals, commodity trading).' },
        employees: { type: 'number', description: 'Number of employees, only if the page states it.' },
        kind: { type: 'string', enum: KINDS }, note: { type: 'string', description: 'One factual sentence, no praise words.' },
        url: { type: 'string' } }, required: ['company', 'status', 'url'] } },
      next_pages: { type: 'array', description: 'Single case studies, press releases or job posts worth reading next for detail (year, partner, what was replaced, person).', items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] } }
    },
    required: ['notes']
  }
};
function systemPrompt(cfg) {
  return 'You collect facts for the Market view of "Treasury Synapse": which organisation runs which treasury, cash, payments or FP&A system, from public pages only. ' +
    'Report an organisation only for its own use of the system. A vendor, a consultancy or an integrator is never the user; a bank is a user only when it runs the system for its own treasury. ' +
    'A job post shows the system the employer runs ("our Kyriba platform") or a selection in progress ("select and implement a new TMS"); a post that only asks for experience with a product says nothing about the employer, skip it. ' +
    'Also report the ERP, the planning (EPM, FP&A) and the bank or payment platforms the page names for the same organisation, each as its own live line (SAP S/4HANA, Oracle NetSuite, Microsoft Dynamics 365, Anaplan, OneStream). ' +
    'When a case study says what was used before (Excel, spreadsheets, a legacy system, a named product), report it as replaced on the same line, and as its own previous line when a product or Excel is named. Never guess. ' +
    'Never use LinkedIn or profile-scraping sites. Write every field in English. You have at most ' + cfg.marketSearches + ' searches and ' + cfg.marketFetches + ' fetches. When done, call submit_market once with everything the fetched pages support, then stop.';
}
function briefFor(src) {
  if (src.kind === 'search') return 'Find recent public pages for: ' + src.label + '. Search, fetch the primary pages (the post, the release, the case study), and report what they state.' + (src.notes ? '\nNotes from the last run: ' + src.notes : '');
  if (src.kind === 'index') return 'Fetch ' + src.url + ' (' + src.label + '). It lists customer stories of one vendor. Report every named customer as a live install of that vendor, with what the listing states. Unnamed customers ("a leading retailer") are skipped. Put single stories worth reading for detail in next_pages, at most 15.';
  return 'Fetch ' + src.url + (src.label ? ' (' + src.label + ')' : '') + ' and report what it states: the organisation, the system, the year, the partner, what it replaced and the person credited.';
}

async function pickSources(pool, n) {
  return (await pool.query(`select * from market_sources where status = 'queued' or (status = 'done' and kind <> 'page' and read_at < now() - interval '30 days')
    order by case kind when 'index' then 0 when 'page' then 1 else 2 end, read_at nulls first, attempts, added_at limit $1`, [n])).rows;
}

async function harvest(pool, cfg, stats, budgetLeft) {
  const { callApi, cost, withCache, normUrl, BLOCKED } = require('./crawl');
  const blocked = u => { try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return BLOCKED.some(d => h === d || h.endsWith('.' + d)); } catch (e) { return true; } };
  stats.market = stats.market || { sources: [], added: 0, merged: 0, rejected: 0, nextPages: 0 };
  for (const src of await pickSources(pool, cfg.marketPages)) {
    if (stats.costUsd >= budgetLeft) break;
    await pool.query('update market_sources set attempts = attempts + 1 where url = $1', [src.url]);
    const fetched = new Set();
    const pending = new Map();
    const messages = [{ role: 'user', content: briefFor(src) }];
    const tools = [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: cfg.marketFetches, blocked_domains: BLOCKED, max_content_tokens: 12000 }, SUBMIT];
    if (src.kind === 'search') tools.unshift({ type: 'web_search_20250305', name: 'web_search', max_uses: cfg.marketSearches, blocked_domains: BLOCKED });
    let found = null, nudged = false;
    try {
      for (let call = 0; call < cfg.maxCalls; call++) {
        const res = await callApi(cfg, { model: cfg.model, max_tokens: 8000, system: systemPrompt(cfg), tools, messages: withCache(messages) });
        stats.costUsd += cost(cfg, res.usage); stats.calls++;
        if (res.usage && res.usage.server_tool_use) stats.searches += res.usage.server_tool_use.web_search_requests || 0;
        const content = Array.isArray(res.content) ? res.content : [];
        for (const b of content) {
          if (b.type === 'server_tool_use' && b.name === 'web_fetch') pending.set(b.id, b.input && b.input.url);
          if (b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_result' && b.content.url) {
            stats.pagesRead++; fetched.add(normUrl(b.content.url)); const asked = pending.get(b.tool_use_id); if (asked) fetched.add(normUrl(asked));
          }
        }
        messages.push({ role: 'assistant', content });
        if (res.stop_reason === 'pause_turn') continue;
        const sub = content.find(b => b.type === 'tool_use' && b.name === 'submit_market');
        if (sub) { found = sub.input || {}; break; }
        const strays = content.filter(b => b.type === 'tool_use');
        if (strays.length) { messages.push({ role: 'user', content: strays.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Unknown tool.', is_error: true })) }); continue; }
        if (nudged) break;
        nudged = true; messages.push({ role: 'user', content: 'Call submit_market now with what the pages you fetched support. Empty lists are fine.' });
      }
    } catch (e) {
      stats.errors.push('market ' + src.url + ': ' + s(e.message, 300));
      if ([401, 403, 429, 529].includes(e.status)) break;
      continue;
    }
    let kept = 0;
    const f = found || {};
    for (const it of Array.isArray(f.installs) ? f.installs.slice(0, 200) : []) {
      if (!it || !fetched.has(normUrl(it.url)) || blocked(it.url)) { stats.market.rejected++; continue; }
      const r = await upsertInstall(pool, it, 'harvest');
      if (!r.ok) { stats.market.rejected++; continue; }
      kept++; if (r.added) stats.market.added++; else if (r.merged) stats.market.merged++;
    }
    for (const p of Array.isArray(f.next_pages) ? f.next_pages.slice(0, 15) : []) {
      const u = httpUrl(p && p.url); if (!u || blocked(u)) continue;
      const r = await pool.query("insert into market_sources (url, label, kind) values ($1,$2,'page') on conflict (url) do nothing", [u, s(p.label, 200)]);
      stats.market.nextPages += r.rowCount;
    }
    const read = src.kind === 'search' ? true : fetched.has(normUrl(src.url));
    await pool.query(`update market_sources set status = $2, read_at = now(), found = found + $3, notes = $4 where url = $1`,
      [src.url, read ? (src.kind === 'search' ? 'queued' : 'done') : (src.attempts + 1 >= 2 ? 'failed' : 'queued'), kept, s(f.notes, 800)]);
    stats.market.sources.push(src.url + ' (' + kept + ')');
  }
  return stats.market;
}

if (require.main === module && process.argv.includes('--seed')) {
  const { makePool } = require('./db');
  const pool = makePool();
  seed(pool).then(async n => { console.log('market seed: ' + n + ' facts'); await pool.end(); }).catch(async e => { console.error(e); await pool.end(); process.exit(1); });
}
module.exports = { compKey, canonSystem, upsertInstall, seed, loadMarket, harvest, SOURCES, VENDORS, INDUSTRIES, NOT_A_USER };
