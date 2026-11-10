'use strict';
/* Render crawler: deepens cards from public pages, on the K-phi Anthropic key.
 * The model researches with the API's server tools (web search, web fetch) and reports through one client tool,
 * submit_findings. The code, not the model, enforces the rules:
 *   - a fact is kept only if its source URL was actually fetched in this session (never from a search snippet or memory)
 *   - topics, link kinds, system roles, regions and segments come from fixed lists
 *   - one link per pair, created only for people who appeared in the same session of a fetched page; evidence is merged by URL
 *   - LinkedIn and scraped-profile vendors are blocked at the API and again in code
 *   - new people are capped per run and in total; the owner's card and fields fixed by an approved correction are never overwritten
 *   - pages that could not be fetched become leads for the review page; queued leads (approved links) are read first
 *   - a card that gives nothing twice in a row is parked
 *   - a daily spend cap; every run is recorded in the runs table
 * Usage: node scripts/crawl.js            (Render cron)
 *        node scripts/crawl.js --dry-run  (pick the targets and print them, no API calls) */
const { makePool } = require('./db');

const TOPICS = ['AI in finance', 'Payments', 'Treasury technology', 'Cash forecasting', 'Liquidity', 'FP&A & planning', 'Risk & compliance', 'Fraud',
  'Bank connectivity', 'Debt & funding', 'Working capital', 'ESG & sustainable finance', 'FX & hedging', 'Crypto & stablecoins', 'AR/AP',
  'In-house banking', 'TMS selection', 'Consolidation', 'Commodities'];
const MAX_TOPICS = 6;
const PRAISE = /\b(leading|renowned|expert|visionary|world-class|thought leader|top|best|famous|influential)\b/i;
/* roles are jobs held at an organisation, not appearances at an event */
const NOT_A_ROLE = /\b(speaker|panell?ist|keynote|presenter|moderator|attendee|listing|alongside|described as|guest)\b/i;
const EVENT_ORG = /\b(conference|summit|forum|congress|webinar|podcast|expo|days?)\b|\b20\d\d\b|°/i;
/* systems are named products or platforms, not techniques */
const GENERIC_SYSTEM = /^(rpa|ai|gen ?ai|erp|tms|excel|spreadsheets?|api|apis|automation|machine learning|ml|cloud|blockchain|bi|robotics)$/i;
const KINDS = { podcast: 0.9, panel: 0.9, filing: 0.9, webinar: 0.8, executive: 0.7, article: 0.6, colleague: 0.5 };
const ROLES = ['uses', 'sells', 'implements', 'integrates', 'evaluated'];
const REGIONS = ['United States', 'United Kingdom', 'France', 'DACH', 'Benelux', 'Nordics', 'Southern Europe', 'Asia-Pacific', 'Other', 'Unknown'];
const SEGMENTS = ['Corporate treasury', 'Banks', 'TMS & fintech', 'Advisors', 'Media', 'EPM & FP&A software'];
const FIELDS = { headline: 'headline', org: 'org', city: 'city', region: 'region', segment: 'segment', knownFor: 'known_for' };
const BLOCKED = ['linkedin.com', 'lnkd.in', 'zoominfo.com', 'rocketreach.co', 'apollo.io', 'lusha.com', 'signalhire.com', 'contactout.com',
  'seamless.ai', 'leadiq.com', 'kaspr.io', 'salesql.com', 'adapt.io', 'uplead.com', 'datanyze.com', 'peopledatalabs.com', 'clearbit.com'];

function config(env = process.env) {
  const n = (k, d) => (env[k] != null && env[k] !== '' && !isNaN(Number(env[k])) ? Number(env[k]) : d);
  return {
    apiKey: env.ANTHROPIC_API_KEY || '',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.CRAWL_MODEL || 'claude-sonnet-5-5',
    targets: n('CRAWL_TARGETS', 2),             // cards (or queued leads) per run
    dailyUsd: n('CRAWL_DAILY_USD', 4),          // stop for the day past this estimate
    priceIn: n('CRAWL_PRICE_IN', 3),            // USD per million input tokens (set to the model's list price)
    priceOut: n('CRAWL_PRICE_OUT', 15),         // USD per million output tokens
    pricePerSearch: n('CRAWL_PRICE_SEARCH', 0.01),
    newPeoplePerRun: n('CRAWL_NEW_PEOPLE', 4),
    peopleCap: n('CRAWL_PEOPLE_CAP', 2100),
    maxCalls: n('CRAWL_MAX_CALLS', 10),         // API calls per target
    fetchesPerTarget: n('CRAWL_FETCHES', 6),
    searchesPerTarget: n('CRAWL_SEARCHES', 4),
    marketPages: n('CRAWL_MARKET_PAGES', 2),   // market sources (vendor case-study lists, single stories, job searches) per run
    marketFetches: n('CRAWL_MARKET_FETCHES', 4),
    marketSearches: n('CRAWL_MARKET_SEARCHES', 3),
    owner: env.OWNER_ID || 'vincent-donnat'
  };
}

/* ---------- helpers ---------- */
const str = (v, max = 400) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } };
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (!/^https?:$/.test(x.protocol)) return '';
    x.hash = '';
    return (x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch (e) { return ''; }
}
const blocked = u => { const h = host(u); return !h || BLOCKED.some(d => h === d || h.endsWith('.' + d)); };
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const normName = s => slug(s).replace(/-/g, ' ');
const leadId = u => slug(String(u).replace(/^https?:\/\/(www\.)?/, '')).slice(0, 60);
const yearish = v => (/^(19|20)\d\d(-\d\d){0,2}$/.test(str(v)) ? str(v) : '');

/* ---------- picking work ---------- */
async function pickTargets(pool, cfg) {
  const out = [];
  const leads = await pool.query(`select l.*, p.name as person_name from leads l left join people p on p.id = l.person_id
    where l.status = 'queued' order by l.added_at nulls first limit $1`, [cfg.targets]);
  for (const l of leads.rows) out.push({ type: 'lead', lead: l, personId: l.person_id });
  /* one slot per run for a private network lead (an importer's connection not yet on the map), treasury and finance titles first */
  if (out.length < cfg.targets) {
    const nl = await pool.query(`select n.*, o.name as owner_name from network_leads n join people o on o.id = n.owner_id
      where n.status = 'queued' and n.priority > 0 and n.expires_at > now() order by n.priority desc, n.added_at limit 1`);
    for (const l of nl.rows) out.push({ type: 'network', nlead: l, personId: null });
  }
  if (out.length < cfg.targets) {
    const ppl = await pool.query(`select id from people where not hidden and not parked
      order by deepened_at nulls first, deepen_attempts, added_at limit $1`, [cfg.targets - out.length]);
    for (const r of ppl.rows) out.push({ type: 'person', personId: r.id });
  }
  return out;
}

async function cardFor(pool, id) {
  if (!id) return null;
  const p = (await pool.query('select * from people where id = $1', [id])).rows[0];
  if (!p) return null;
  const [t, s, r, e] = await Promise.all([
    pool.query('select topic from person_topics where person_id = $1 order by topic', [id]),
    pool.query('select system, role from person_systems where person_id = $1', [id]),
    pool.query('select title, org, from_year, to_year from person_roles where person_id = $1 order by from_year', [id]),
    pool.query(`select case when c.a = $1 then c.b else c.a end as other, q.name, c.kind, c.url, c.evidence from co_appearances c
      join people q on q.id = case when c.a = $1 then c.b else c.a end where c.a = $1 or c.b = $1`, [id])]);
  const urls = new Set([p.source]);
  e.rows.forEach(x => { urls.add(x.url); (x.evidence || []).forEach(v => v && urls.add(v.url)); });
  return { p, topics: t.rows.map(x => x.topic), systems: s.rows, roles: r.rows, links: e.rows, knownUrls: [...urls].filter(Boolean) };
}

/* ---------- the conversation ---------- */
const SUBMIT = {
  name: 'submit_findings',
  description: 'Report what the pages you fetched in this session say. Call it exactly once, at the end. Every item must carry the URL of a page you fetched with web_fetch in this session; items sourced from search snippets, memory or pages you did not fetch are discarded by the server.',
  input_schema: {
    type: 'object',
    properties: {
      notes: { type: 'string', description: 'Two to four sentences for the next run: what you found, what was blocked, which lead to try next. Plain text.' },
      updates: { type: 'array', description: 'Corrections to the card, only when a fetched page states the value and it is newer than the card.', items: { type: 'object', properties: {
        field: { type: 'string', enum: Object.keys(FIELDS) }, value: { type: 'string' }, url: { type: 'string' } }, required: ['field', 'value', 'url'] } },
      topics: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string', enum: TOPICS }, url: { type: 'string' } }, required: ['topic', 'url'] } },
      systems: { type: 'array', description: 'Named products or platforms (Kyriba, SAP S/4HANA, Anaplan), not techniques such as RPA or AI.', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ROLES }, url: { type: 'string' }, date: { type: 'string' } }, required: ['name', 'role', 'url'] } },
      roles: { type: 'array', description: 'Jobs held at an organisation, with the years the page states (YYYY, empty if not stated). Short title such as "Head of Treasury". Not speaking or hosting at an event.', items: { type: 'object', properties: { title: { type: 'string' }, org: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, url: { type: 'string' } }, required: ['org', 'url'] } },
      links: { type: 'array', description: 'People who appeared with this person in the same session, episode, panel, webinar or leadership team on a fetched page. Not people who only appear elsewhere on the page.', items: { type: 'object', properties: {
        name: { type: 'string' }, person_id: { type: 'string', description: 'If you know the map id.' }, org: { type: 'string' },
        kind: { type: 'string', enum: Object.keys(KINDS) }, label: { type: 'string', description: 'Event or episode title, short.' }, date: { type: 'string', description: 'YYYY, YYYY-MM or YYYY-MM-DD.' },
        url: { type: 'string' }, same_session: { type: 'boolean' } }, required: ['name', 'kind', 'label', 'url', 'same_session'] } },
      new_people: { type: 'array', description: 'Only people you also listed in links who are not on the map, with what the page says about them.', items: { type: 'object', properties: {
        name: { type: 'string' }, headline: { type: 'string' }, org: { type: 'string' }, city: { type: 'string' }, region: { type: 'string', enum: REGIONS }, segment: { type: 'string', enum: SEGMENTS }, url: { type: 'string' } }, required: ['name', 'headline', 'org', 'url'] } },
      leads: { type: 'array', description: 'Pages worth reading next time that you could not fetch or did not have budget for.', items: { type: 'object', properties: { url: { type: 'string' }, snippet: { type: 'string' } }, required: ['url'] } }
    },
    required: ['notes']
  }
};

function system(cfg) {
  return 'You research one person for "Treasury Synapse", a map of treasury and finance professionals built only from public pages: podcast episodes, conference programmes, webinars, filings, vendor leadership pages, articles. ' +
    'Goal: depth on this one person, not breadth. Find what they spoke about, which systems they use, sell, implement, integrate or evaluated, their dated roles, and who appeared with them in the same session. ' +
    'Method: search, then fetch the pages that look like primary sources (event agenda or speaker page, episode page, press release, filing, company leadership page). Sibling pages of a useful page (other years of the same event, other episodes of the same show) are often the best next fetch. Podcast RSS feeds and programme PDFs are often readable when agenda pages are not. ' +
    'Never use LinkedIn or profile-scraping sites. Never guess. A link needs the two people in the same session of the same page; a speaker list of a whole conference is not a link. Use the map ids you are given when the person is already on the map. ' +
    'Topics must be one of: ' + TOPICS.join(', ') + ', at most ' + MAX_TOPICS + ' per person, only when a page shows them speaking, writing or quoted on it. ' +
    'knownFor is one factual sentence of at most 160 characters with no praise words. When a newer dated page gives a different current title or organisation, update headline and org and add the role. ' +
    'Write every field in English, whatever the language of the page. ' +
    'You have at most ' + cfg.searchesPerTarget + ' searches and ' + cfg.fetchesPerTarget + ' fetches. When done, call submit_findings once with everything the fetched pages support, then stop.';
}

function brief(card, target) {
  const lines = [];
  if (target.type === 'network') {
    const l = target.nlead;
    lines.push('Find public pages about ' + l.first_name + ' ' + l.last_name + (l.position ? ', ' + l.position : '') + (l.company ? ' at ' + l.company : '') + '. They are not on the map yet.');
    lines.push('Only if a fetched page shows this same person in a public professional role (speaker, panelist, podcast guest or host, author, named officer, quoted with their role), report them in new_people with that page, plus any topics, systems and roles the page attests and any people of the same session in links. If you find nothing reliable, submit empty lists: nothing is published about them.');
  }
  if (target.type === 'lead') {
    lines.push('A reviewer approved this page as a source: ' + target.lead.url + (target.lead.snippet ? ' (note: ' + str(target.lead.snippet, 300) + ')' : '') + '. Fetch it first and report what it attests.');
  }
  if (card) {
    const p = card.p;
    lines.push('Person: ' + p.name + ' (map id ' + p.id + '). Card: ' + [p.headline, p.org, p.city, p.region, p.segment].filter(Boolean).join(' | ') + '.');
    if (p.known_for) lines.push('Known for: ' + p.known_for);
    if (card.topics.length) lines.push('Topics already on the card: ' + card.topics.join(', ') + '.');
    if (card.systems.length) lines.push('Systems already on the card: ' + card.systems.map(s => s.role + ' ' + s.system).join(', ') + '.');
    if (card.roles.length) lines.push('Roles already on the card: ' + card.roles.map(r => [r.title, r.org, [r.from_year, r.to_year].filter(Boolean).join('-')].filter(Boolean).join(', ')).join('; ') + '.');
    if (card.links.length) lines.push('Already linked to (map id): ' + card.links.slice(0, 40).map(l => l.name + ' (' + l.other + ')').join(', ') + '.');
    if (card.knownUrls.length) lines.push('Pages already used, do not report them again unless they add something: ' + card.knownUrls.slice(0, 25).join(' '));
    if (p.insight_notes) lines.push('Notes from the last run: ' + str(p.insight_notes, 800));
  } else if (target.type === 'lead') {
    lines.push('No person is attached; report the people the page names in the same session, using links only between people on the map.');
  }
  return lines.join('\n');
}

async function callApi(cfg, body) {
  const r = await fetch(cfg.baseUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('API ' + r.status + ': ' + str(j.error && j.error.message, 300)), { status: r.status });
  return j;
}

function cost(cfg, u) {
  if (!u) return 0;
  const tin = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return (tin * cfg.priceIn + (u.output_tokens || 0) * cfg.priceOut) / 1e6 + searches * cfg.pricePerSearch;
}

/* mark the last user block as a cache breakpoint so each step of the loop re-reads the pages at the cached rate */
function withCache(messages) {
  const m = messages.map(x => ({ role: x.role, content: x.content }));
  const last = m[m.length - 1];
  if (last.role !== 'user') return m;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map(b => Object.assign({}, b));
  blocks[blocks.length - 1] = Object.assign({}, blocks[blocks.length - 1], { cache_control: { type: 'ephemeral' } });
  last.content = blocks;
  return m;
}

/* one target: run the tool loop, collect what was fetched, apply the findings */
async function research(pool, cfg, target, stats) {
  const card = await cardFor(pool, target.personId);
  if (target.type === 'person' && !card) return { skipped: 'card gone' };
  if (target.type === 'network') await pool.query('update network_leads set attempts = attempts + 1, searched_at = now() where id = $1', [target.nlead.id]);
  const fetched = new Map();   // normalized url -> url as fetched
  const failed = new Map();    // url -> error code
  const pending = new Map();   // server_tool_use id -> requested url
  const messages = [{ role: 'user', content: brief(card, target) }];
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: cfg.searchesPerTarget, blocked_domains: BLOCKED },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: cfg.fetchesPerTarget, blocked_domains: BLOCKED, max_content_tokens: 9000 },
    SUBMIT];
  let result = null, nudged = false;
  for (let call = 0; call < cfg.maxCalls; call++) {
    const res = await callApi(cfg, { model: cfg.model, max_tokens: 4000, system: system(cfg), tools, messages: withCache(messages) });
    stats.costUsd += cost(cfg, res.usage);
    stats.calls++;
    if (res.usage && res.usage.server_tool_use) stats.searches += res.usage.server_tool_use.web_search_requests || 0;
    const content = Array.isArray(res.content) ? res.content : [];
    for (const b of content) {
      if (b.type === 'server_tool_use' && b.name === 'web_fetch') pending.set(b.id, b.input && b.input.url);
      if (b.type === 'web_fetch_tool_result') {
        const c = b.content || {};
        const asked = pending.get(b.tool_use_id);
        if (c.type === 'web_fetch_result' && c.url) {
          stats.pagesRead++;
          fetched.set(normUrl(c.url), c.url);
          if (asked) fetched.set(normUrl(asked), c.url);
        } else if (asked) failed.set(asked, c.error_code || 'unavailable');
      }
    }
    messages.push({ role: 'assistant', content });
    if (res.stop_reason === 'pause_turn') continue;   /* a long server-tool turn: send it back as is and let it go on */
    const submit = content.find(b => b.type === 'tool_use' && b.name === 'submit_findings');
    if (submit) {
      result = await apply(pool, cfg, target, card, submit.input || {}, fetched, stats);
      const others = content.filter(b => b.type === 'tool_use' && b.id !== submit.id);
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: submit.id, content: JSON.stringify({ kept: result.kept, discarded: result.rejected.slice(0, 12) }) }]
        .concat(others.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Unknown tool.', is_error: true }))) });
      break;
    }
    const strays = content.filter(b => b.type === 'tool_use');
    if (strays.length) { messages.push({ role: 'user', content: strays.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Unknown tool.', is_error: true })) }); continue; }
    if (nudged) break;
    nudged = true;
    messages.push({ role: 'user', content: 'Call submit_findings now with what the pages you fetched support. Empty lists are fine.' });
  }
  /* pages that could not be read go to the review page as leads */
  for (const [url, code] of failed) {
    if (blocked(url) || fetched.has(normUrl(url))) continue;
    const r = await pool.query(`insert into leads (id, url, reason, person_id, snippet, status, added_at) values ($1,$2,$3,$4,'', 'pending', now()) on conflict (id) do nothing`,
      [leadId(url), url, 'crawler could not read it (' + code + ')', target.personId || null]);
    stats.leadsAdded += r.rowCount;
  }
  if (target.type === 'lead') {
    const read = fetched.has(normUrl(target.lead.url));
    await pool.query('update leads set status = $2, reason = $3 where id = $1', [target.lead.id, read ? 'done' : 'pending',
      read ? target.lead.reason : 'crawler could not read it (' + (failed.get(target.lead.url) || 'not fetched') + ')']);
  }
  if (!result) result = { kept: 0, rejected: [{ what: 'run', reason: 'no findings submitted' }] };
  if (card) await settleCard(pool, card.p.id, result.kept, (result.notes || '') || card.p.insight_notes);
  return result;
}

async function settleCard(pool, id, kept, notes) {
  await pool.query(`update people set deepened_at = now(), deepen_attempts = deepen_attempts + 1, insight_notes = $3,
      empty_runs = case when $2 > 0 then 0 else empty_runs + 1 end,
      parked = case when $2 = 0 and empty_runs + 1 >= 2 then true else parked end,
      parked_reason = case when $2 = 0 and empty_runs + 1 >= 2 then 'two deepen runs found nothing new' else parked_reason end,
      updated_at = now() where id = $1`, [id, kept, str(notes, 1500)]);
}

/* ---------- the rules, in code ---------- */
async function apply(pool, cfg, target, card, f, fetched, stats) {
  const rejected = [];
  let kept = 0;
  const reject = (what, reason) => { rejected.push({ what: str(what, 120), reason }); stats.rejected++; };
  const src = u => {
    const n = normUrl(u);
    if (!n) return null;
    if (blocked(u)) return null;
    return fetched.has(n) ? fetched.get(n) : null;
  };
  const client = await pool.connect();
  try {
    await client.query('begin');
    let id = card && card.p.id;
    const domains = new Set();
    const used = u => { const h = host(u); if (h) domains.add(h); kept++; };
    /* a private network lead becomes a card only from a fetched public page that shows them; then the importer's line appears */
    if (target.type === 'network') {
      const l = target.nlead, want = normName(l.first_name + ' ' + l.last_name);
      const n = (Array.isArray(f.new_people) ? f.new_people : []).find(x => normName(x && x.name) === want);
      const nurl = n && src(n.url);
      const total = (await client.query('select count(*)::int n from people')).rows[0].n;
      let pid = null;
      if (n && nurl) {
        const existing = (await client.query('select id from people where id = $1', [slug(n.name)])).rows[0];
        const removedIds = new Set((await client.query("select person_id from submissions where kind = 'removal' and status = 'approved'")).rows.map(r => r.person_id));
        if (existing) pid = existing.id;
        else if (removedIds.has(slug(n.name))) reject(n.name, 'removed from the map at their request');
        else if (total + stats.peopleAdded >= cfg.peopleCap) reject(n.name, 'people cap reached');
        else {
          pid = slug(n.name);
          await client.query(`insert into people (id, name, headline, org, city, region, segment, seed, source, added_at, crawled_at, updated_at)
            values ($1,$2,$3,$4,$5,$6,$7,false,$8,now(),now(),now())`, [pid, str(n.name, 120), str(n.headline, 200) || str(l.position, 200), str(n.org, 120) || str(l.company, 120), str(n.city, 80),
            REGIONS.includes(n.region) ? n.region : 'Unknown', SEGMENTS.includes(n.segment) ? n.segment : 'Corporate treasury', nurl]);
          stats.peopleAdded++; stats.newPeople.push(pid); used(nurl);
        }
      } else if (n) reject(n.name, 'source not fetched in this session');
      if (pid) {
        await client.query(`insert into connections (from_id, to_id, status, note, public_consent_at) values ($1,$2,'pending','LinkedIn connections import',now()) on conflict (from_id, to_id) do nothing`, [l.owner_id, pid]);
        await client.query("update network_leads set status = 'found', person_id = $2 where id = $1", [l.id, pid]);
        stats.networkFound = (stats.networkFound || 0) + 1;
        id = pid;
        f = Object.assign({}, f, { updates: [], new_people: (f.new_people || []).filter(x => normName(x && x.name) !== want) });
      } else {
        await client.query("update network_leads set status = 'none' where id = $1 and attempts >= 1", [l.id]);
      }
    }
    /* fields */
    if (id) {
      const locked = new Set((await client.query("select payload->>'field' f from submissions where person_id = $1 and kind = 'correction' and status = 'approved'", [id])).rows.map(r => r.f));
      for (const u of Array.isArray(f.updates) ? f.updates.slice(0, 8) : []) {
        const url = src(u && u.url), field = u && u.field, value = str(u && u.value, field === 'knownFor' ? 160 : 200);
        if (!FIELDS[field] || !value) { reject(field, 'unknown field or empty value'); continue; }
        if (!url) { reject(field + ': ' + value, 'source not fetched in this session'); continue; }
        if (id === cfg.owner) { reject(field, "the owner's card is edited by hand only"); continue; }
        if (locked.has(field)) { reject(field, 'fixed by an approved correction'); continue; }
        if (field === 'region' && !REGIONS.includes(value)) { reject(field, 'not a known region'); continue; }
        if (field === 'segment' && !SEGMENTS.includes(value)) { reject(field, 'not a known segment'); continue; }
        if (field === 'knownFor' && PRAISE.test(value)) { reject(field + ': ' + value, 'praise word; facts only'); continue; }
        await client.query(`update people set ${FIELDS[field]} = $2, updated_at = now() where id = $1`, [id, value]);
        stats.factsAdded++; used(url);
      }
      let ntopics = (await client.query('select count(*)::int n from person_topics where person_id = $1', [id])).rows[0].n;
      for (const t of Array.isArray(f.topics) ? f.topics.slice(0, 12) : []) {
        const url = src(t && t.url);
        if (!TOPICS.includes(t && t.topic)) { reject(t && t.topic, 'not in the topic list'); continue; }
        if (!url) { reject(t.topic, 'source not fetched in this session'); continue; }
        if (ntopics >= MAX_TOPICS) { reject(t.topic, 'already ' + MAX_TOPICS + ' topics'); continue; }
        ntopics++;
        const r = await client.query('insert into person_topics (person_id, topic, url) values ($1,$2,$3) on conflict do nothing', [id, t.topic, url]);
        if (r.rowCount) { stats.factsAdded++; used(url); }
      }
      for (const s of Array.isArray(f.systems) ? f.systems.slice(0, 12) : []) {
        const url = src(s && s.url), name = str(s && s.name, 80);
        if (!name || !ROLES.includes(s.role)) { reject(name, 'missing system or unknown role'); continue; }
        if (name.length > 40 || /[()\/]/.test(name) || GENERIC_SYSTEM.test(name)) { reject(name, 'not a named product'); continue; }
        if (!url) { reject(s.role + ' ' + name, 'source not fetched in this session'); continue; }
        const r = await client.query('insert into person_systems (person_id, system, role, url, date) values ($1,$2,$3,$4,$5) on conflict do nothing', [id, name, s.role, url, yearish(s.date)]);
        if (r.rowCount) { stats.factsAdded++; used(url); }
      }
      for (const x of Array.isArray(f.roles) ? f.roles.slice(0, 12) : []) {
        const url = src(x && x.url), org = str(x && x.org, 120), title = str(x && x.title, 160);
        if (!org) { reject(title, 'role without organisation'); continue; }
        if (title.length > 80 || NOT_A_ROLE.test(title) || EVENT_ORG.test(org)) { reject(title + ', ' + org, 'an appearance, not a job'); continue; }
        if (!url) { reject(title + ', ' + org, 'source not fetched in this session'); continue; }
        const r = await client.query('insert into person_roles (person_id, title, org, from_year, to_year, url) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
          [id, title, org, yearish(x.from).slice(0, 4), yearish(x.to).slice(0, 4), url]);
        if (r.rowCount) { stats.factsAdded++; used(url); }
      }
    }
    /* links: one per pair, same session only, to people on the map or new people within the caps */
    const total = (await client.query('select count(*)::int n from people')).rows[0].n;
    const newcomers = new Map((Array.isArray(f.new_people) ? f.new_people : []).map(n => [normName(n && n.name), n]));
    const byName = async name => {
      const rows = (await client.query("select id, name from people where lower(name) = lower($1) and not hidden", [str(name, 120)])).rows;
      if (rows.length === 1) return rows[0].id;
      const all = (await client.query("select id, name from people where not hidden and id like $1", [slug(name).split('-')[0] + '%'])).rows.filter(r => normName(r.name) === normName(name));
      return all.length === 1 ? all[0].id : null;
    };
    const removed = new Set((await client.query("select person_id from submissions where kind = 'removal' and status = 'approved'")).rows.map(r => r.person_id));
    for (const l of Array.isArray(f.links) ? f.links.slice(0, 30) : []) {
      const url = src(l && l.url), name = str(l && l.name, 120);
      const anchor = id || null;
      if (!name || !KINDS[l.kind]) { reject(name, 'missing name or unknown kind'); continue; }
      if (!l.same_session) { reject(name, 'not in the same session'); continue; }
      if (!url) { reject(name, 'source not fetched in this session'); continue; }
      if (!anchor) { reject(name, 'no person attached to this page'); continue; }
      let other = null;
      if (l.person_id) { const r = await client.query('select id from people where id = $1 and not hidden', [str(l.person_id, 100)]); if (r.rows[0]) other = r.rows[0].id; }
      if (!other) other = await byName(name);
      if (!other) {
        const n = newcomers.get(normName(name));
        const nid = slug(name);
        if (!n) { reject(name, 'not on the map and not described in new_people'); continue; }
        if (removed.has(nid)) { reject(name, 'removed from the map at their request'); continue; }
        if (stats.peopleAdded >= cfg.newPeoplePerRun || total + stats.peopleAdded >= cfg.peopleCap) { reject(name, 'new-people cap reached'); continue; }
        const nurl = src(n.url) || url;
        const exists = (await client.query('select 1 from people where id = $1', [nid])).rows.length;
        if (exists || !nid) { reject(name, 'id taken by someone else'); continue; }
        await client.query(`insert into people (id, name, headline, org, city, region, segment, seed, found_via, source, added_at, crawled_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,now(),now(),now())`,
          [nid, name, str(n.headline, 200), str(n.org, 120), str(n.city, 80), REGIONS.includes(n.region) ? n.region : 'Unknown',
           SEGMENTS.includes(n.segment) ? n.segment : 'Corporate treasury', anchor, nurl]);
        stats.peopleAdded++; stats.newPeople.push(nid);
        other = nid;
      }
      if (other === anchor) { reject(name, 'same person'); continue; }
      const [a, b] = anchor < other ? [anchor, other] : [other, anchor];
      const ev = { url, label: str(l.label, 200), kind: l.kind, date: yearish(l.date) };
      const old = (await client.query('select evidence, confidence from co_appearances where a = $1 and b = $2', [a, b])).rows[0];
      if (!old) {
        await client.query(`insert into co_appearances (a, b, kind, label, url, confidence, evidence, added_at) values ($1,$2,$3,$4,$5,$6,$7,now())`,
          [a, b, l.kind, ev.label, url, KINDS[l.kind], JSON.stringify([ev])]);
        stats.edgesAdded++;
      } else if (!(old.evidence || []).some(x => x && normUrl(x.url) === normUrl(url))) {
        await client.query('update co_appearances set evidence = $3, confidence = greatest(confidence, $4), updated_at = now() where a = $1 and b = $2',
          [a, b, JSON.stringify((old.evidence || []).concat([ev])), KINDS[l.kind]]);
        stats.evidenceAdded++;
      } else { reject(name, 'this page is already evidence for the pair'); continue; }
      const o = await client.query(`insert into occasions (url, kind, label, date) values ($1,$2,$3,$4)
        on conflict (url) do update set label = case when occasions.label = '' then excluded.label else occasions.label end returning id`, [url, l.kind, ev.label, ev.date]);
      await client.query('insert into appearances (occasion_id, person_id) values ($1,$2),($1,$3) on conflict do nothing', [o.rows[0].id, a, b]);
      used(url);
    }
    for (const x of Array.isArray(f.leads) ? f.leads.slice(0, 10) : []) {
      const url = str(x && x.url, 500);
      if (!normUrl(url) || blocked(url) || fetched.has(normUrl(url))) continue;
      const r = await client.query(`insert into leads (id, url, reason, person_id, snippet, status, added_at) values ($1,$2,'left for a later run',$3,$4,'pending',now()) on conflict (id) do nothing`,
        [leadId(url), url, id || null, str(x.snippet, 300)]);
      stats.leadsAdded += r.rowCount;
    }
    /* publisher domains: the sites that gave this card a kept fact */
    if (id && domains.size) {
      await client.query(`update people set publisher_domains = (select array(select distinct d from unnest(publisher_domains || $2::text[]) d order by d)),
          updated_at = now() where id = $1`, [id, [...domains]]);
      await client.query('update people set publishers = coalesce(array_length(publisher_domains, 1), 0) where id = $1', [id]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally { client.release(); }
  return { kept, rejected, notes: str(f.notes, 1500) };
}

/* ---------- one run ---------- */
async function spentToday(pool) {
  const r = await pool.query("select coalesce(sum((data->>'costUsd')::numeric), 0)::float n from runs where data->>'mode' = 'render' and started_at >= date_trunc('day', now())");
  return r.rows[0].n;
}

async function crawl(pool, cfg = config(), opts = {}) {
  const startedAt = new Date();
  const id = startedAt.toISOString().slice(0, 16).replace(':', '-') + '-render';
  await pool.query('delete from network_leads where expires_at < now()').catch(() => {});
  const stats = { mode: 'render', model: cfg.model, startedAt: startedAt.toISOString(), deepened: [], leadsRead: [], newPeople: [], peopleAdded: 0, edgesAdded: 0,
    evidenceAdded: 0, factsAdded: 0, rejected: 0, rejections: [], leadsAdded: 0, pagesRead: 0, searches: 0, calls: 0, costUsd: 0, errors: [], notes: '' };
  const spent = await spentToday(pool);
  const targets = await pickTargets(pool, cfg);
  if (opts.dryRun) {
    const ms = cfg.marketPages > 0 ? (await pool.query("select url from market_sources where status = 'queued' order by case kind when 'page' then 0 when 'index' then 1 else 2 end, read_at nulls first limit $1", [cfg.marketPages])).rows.map(r => 'market:' + r.url) : [];
    return { dryRun: true, spentToday: spent, targets: targets.map(t => t.type + ':' + (t.type === 'lead' ? t.lead.url : t.personId)).concat(ms) };
  }
  if (!cfg.apiKey) stats.notes = 'ANTHROPIC_API_KEY is not set; nothing done.';
  else if (spent >= cfg.dailyUsd) stats.notes = 'Daily spend cap reached (' + spent.toFixed(2) + ' of ' + cfg.dailyUsd + ' USD); nothing done.';
  else {
    /* the Market view first (the primary angle): company-system sources, inside the same daily cap */
    if (cfg.marketPages > 0) {
      try { await require('./market').harvest(pool, cfg, stats, cfg.dailyUsd - spent); }
      catch (e) { stats.errors.push('market: ' + str(e.message, 300)); }
    }
    for (const t of targets) {
      if (stats.errors.some(x => / 40[13]:| 429:| 529:/.test(x))) break;
      if (spent + stats.costUsd >= cfg.dailyUsd) { stats.notes = 'Stopped at the daily spend cap.'; break; }
      try {
        const r = await research(pool, cfg, t, stats);
        if (t.type === 'lead') stats.leadsRead.push(t.lead.id);
        if (t.type === 'network') stats.networkSearched = (stats.networkSearched || 0) + 1;
        if (t.personId) stats.deepened.push(t.personId);
        stats.rejections.push(...(r.rejected || []).slice(0, 8).map(x => (t.personId || 'lead') + ': ' + x.what + ' (' + x.reason + ')'));
      } catch (e) {
        stats.errors.push((t.personId || t.lead && t.lead.id) + ': ' + str(e.message, 300));
        if (e.status === 401 || e.status === 403) break;
        if (e.status === 429 || e.status === 529) break;
      }
    }
  }
  stats.costUsd = Math.round(stats.costUsd * 10000) / 10000;
  stats.finishedAt = new Date().toISOString();
  await pool.query('insert into runs (id, data, started_at) values ($1,$2,$3) on conflict (id) do update set data = excluded.data', [id, JSON.stringify(stats), stats.startedAt]);
  return Object.assign({ id }, stats);
}

if (require.main === module) {
  const pool = makePool();
  crawl(pool, config(), { dryRun: process.argv.includes('--dry-run') })
    .then(async r => { console.log(JSON.stringify(r, null, 1)); await pool.end(); if (r.errors && r.errors.length && !r.calls) process.exit(1); })
    .catch(async e => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
}
module.exports = { crawl, config, normUrl, TOPICS, BLOCKED, callApi, cost, withCache };
