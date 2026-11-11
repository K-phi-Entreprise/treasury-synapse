'use strict';
/* D2: the map's chat on the K-phi Anthropic key.
 * The page runs the find_people tool itself (the graph lives in the browser); the server owns the prompt, the tool
 * definition, the model and the limits, so the endpoint cannot be used as a general-purpose Claude proxy.
 * One question = one quota unit; the follow-up calls of the same question's tool loop ride on a signed token. */
const crypto = require('crypto');

const SEGMENTS = ['Corporate treasury', 'Banks', 'TMS & fintech', 'Advisors', 'Media', 'EPM & FP&A software'];
const REGIONS = ['United States', 'United Kingdom', 'France', 'DACH', 'Benelux', 'Nordics', 'Southern Europe', 'Asia-Pacific', 'Other', 'Unknown'];
const MAX_STEPS = 5;           // API calls per question (tool loop)
const TOKEN_TTL_MS = 3 * 60 * 1000;

function systemPrompt(counts) {
  return 'You are the analyst built into "Treasury & FP&A Synapses", a map of treasury professionals built only from public sources: podcast episodes, conference panels, webinars, filings, vendor pages. ' +
    'Each person has a name, headline, organisation, city, region, segment (' + SEGMENTS.join(', ') + '), a count of links and the names they are linked to. ' +
    'A link means the two people appeared together publicly (same episode, panel, webinar, team); it is co-appearance, not acquaintance, and every link has a source URL. ' +
    'People may also carry what they are publicly known for, topics, the systems they use, sell, implement, integrate or evaluated, and past roles. ' +
    'The map currently holds ' + counts.people + ' people and ' + counts.edges + ' links. ' +
    'Answer every factual question by calling find_people first and never invent people, links, systems or numbers. The page highlights the matches on the map for you. ' +
    'Reply in plain text with no markdown, 2 to 5 short lines, readable on a phone. Name people by name and organisation. Say how many match and what stands out. ' +
    'If nothing matches, say so and suggest the nearest alternative. If the question is not about this map, say you can only answer about the map. ' +
    'Never give contact details, private information or opinions about people; describe only what public pages say they did.';
}

const FIND_PEOPLE = {
  name: 'find_people',
  description: 'Search the people on the map and highlight every match. Returns the total, up to `limit` people sorted by number of links (most connected first) with the names they are linked to, what they are known for, topics, systems and roles, and counts by region and segment. Filters are optional and combined with AND. Call it for every question about who is on the map.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "Part of a person's name." },
      org: { type: 'string', description: 'Part of an organisation name, for example HighRadius or Agicap.' },
      segment: { type: 'string', description: SEGMENTS.join(', ') + '.' },
      region: { type: 'string', description: REGIONS.join(', ') + '.' },
      city: { type: 'string', description: 'City name.' },
      role: { type: 'string', description: 'Keyword in the headline, for example treasurer, CEO, product.' },
      connected_to: { type: 'string', description: "A person's name; only people directly linked to them." },
      link_kind: { type: 'string', description: 'podcast, panel, webinar, colleague, executive, article or filing.' },
      topic: { type: 'string', description: 'A subject the person is publicly known for, for example liquidity, in-house banking, cash forecasting, FX, payments, AI.' },
      system: { type: 'string', description: 'A treasury or finance system, for example Kyriba, SAP, Anaplan. Matches people who use, sell, implement, integrate or evaluated it.' },
      system_role: { type: 'string', description: 'With system: uses, sells, implements, integrates or evaluated.' },
      min_links: { type: 'integer', description: 'Minimum number of links.' },
      limit: { type: 'integer', description: 'Max people returned, default 12, max 25.' }
    }
  }
};

/* ---------- request validation: only conversation turns and this tool's blocks ---------- */
function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 24) return null;
  if (JSON.stringify(raw).length > 80000) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content === 'string') {
      if (m.content.length > (m.role === 'user' ? 600 : 3000) || !m.content.trim()) return null;
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content) || !m.content.length) return null;
    const blocks = [];
    for (const b of m.content) {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length <= 3000) blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use' && m.role === 'assistant' && b.name === FIND_PEOPLE.name && typeof b.id === 'string')
        blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
      else if (b.type === 'tool_result' && m.role === 'user' && typeof b.tool_use_id === 'string' && typeof b.content === 'string' && b.content.length <= 16000)
        blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
      else return null;
    }
    out.push({ role: m.role, content: blocks });
  }
  if (out[0].role !== 'user') return null;
  for (let i = 1; i < out.length; i++) if (out[i].role === out[i - 1].role) return null;
  if (out[out.length - 1].role !== 'user') return null;
  return out;
}

/* ---------- signed step token: same visitor, same question, few calls, short life ---------- */
function makeTokens(secret) {
  const sign = s => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  return {
    issue(ip, steps) { const body = ip + '.' + (Date.now() + TOKEN_TTL_MS) + '.' + steps; return body + '.' + sign(body); },
    check(token, ip) {
      const parts = String(token || '').split('.');
      if (parts.length !== 4) return null;
      const body = parts.slice(0, 3).join('.');
      const sig = Buffer.from(sign(body)), got = Buffer.from(parts[3]);
      if (sig.length !== got.length || !crypto.timingSafeEqual(sig, got)) return null;
      if (parts[0] !== ip || Number(parts[1]) < Date.now()) return null;
      const steps = Number(parts[2]);
      return steps < MAX_STEPS ? steps : null;
    }
  };
}

function mount(app, { pool, ipHash, apiKey, model, perVisitor, dailyCap, secret, baseUrl }) {
  const tokens = makeTokens(secret);
  let counts = { at: 0, people: 0, edges: 0 };
  async function getCounts() {
    if (Date.now() - counts.at < 300000) return counts;
    const r = await pool.query('select (select count(*) from people where not hidden)::int p, (select count(*) from co_appearances)::int e');
    counts = { at: Date.now(), people: r.rows[0].p, edges: r.rows[0].e };
    return counts;
  }
  async function used(h, kind) {
    const r = await pool.query('select coalesce(sum(n),0)::int n from quotas where ip_hash = $1 and day = current_date and kind = $2', [h, kind]);
    return r.rows[0].n;
  }
  async function bump(h, kind) {
    await pool.query(`insert into quotas (ip_hash, day, kind, n) values ($1, current_date, $2, 1)
      on conflict (ip_hash, day, kind) do update set n = quotas.n + 1`, [h, kind]);
  }

  app.get('/api/ask/status', async (req, res, next) => {
    try {
      if (!apiKey) return res.json({ enabled: false });
      const h = ipHash(req);
      const [mine, all] = await Promise.all([used(h, 'ask'), used('*', 'ask')]);
      res.json({ enabled: all < dailyCap, remaining: Math.max(0, perVisitor - mine) });
    } catch (e) { next(e); }
  });

  app.post('/api/ask', async (req, res, next) => {
    try {
      if (!apiKey) return res.status(503).json({ error: 'chat not configured' });
      const messages = cleanMessages(req.body && req.body.messages);
      if (!messages) return res.status(400).json({ error: 'bad conversation' });
      const h = ipHash(req);
      let steps;
      if (req.body.token) {
        steps = tokens.check(req.body.token, h);
        if (steps == null) return res.status(400).json({ error: 'question expired, ask again' });
      } else {
        if (await used('*', 'ask') >= dailyCap) return res.status(429).json({ error: 'the chat has reached its daily limit, try again tomorrow', code: 'global_limit' });
        if (await used(h, 'ask') >= perVisitor) return res.status(429).json({ error: 'daily limit reached, try again tomorrow', code: 'daily_limit' });
        await bump(h, 'ask'); await bump('*', 'ask');
        steps = 0;
      }
      const c = await getCounts();
      const r = await fetch(baseUrl + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 700, system: systemPrompt(c), tools: [FIND_PEOPLE], messages })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('anthropic', r.status, j && j.error);
        return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'busy, try again in a minute' : 'the chat is unavailable right now', code: r.status === 429 ? 'rate_limited' : 'unavailable' });
      }
      const content = (j.content || []).filter(b => b.type === 'text' || (b.type === 'tool_use' && b.name === FIND_PEOPLE.name));
      res.json({ content, stop_reason: j.stop_reason, token: tokens.issue(h, steps + 1), remaining: Math.max(0, perVisitor - await used(h, 'ask')) });
    } catch (e) { next(e); }
  });
}

module.exports = { mount, cleanMessages, makeTokens, FIND_PEOPLE, systemPrompt };
