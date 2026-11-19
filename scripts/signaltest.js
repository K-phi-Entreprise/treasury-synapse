'use strict';
/* One-off test (Nov 2026): do licensed LinkedIn company posts carry dated customer decisions?
 * Reads the company-page posts of ten vendors from the Autobound Signal API (AUTOBOUND_API_KEY), once,
 * and keeps a summary: how many posts, how many dated, how many read like a customer selection, go-live or replacement.
 * Capped at 450 posts (900 of the 1,000 free credits). Company pages only, no personal posts. Temporary: remove after reading. */
const NAME = 'autobound-company-posts-v1';
/* vendors only. An entry may list fallbacks: Ripple Treasury is tried under its former GTreasury domain first (a domain not found costs nothing) */
const DOMAINS = ['kyriba.com', 'onestream.com', 'anaplan.com', 'agicap.com', 'jedox.com', 'trovata.io', 'planful.com', 'nomentia.com', ['gtreasury.com', 'ripple.com'], 'fisglobal.com'];
const PER = 45;
const DECISION = /\b(go(?:es|ne)?[- ]live|went live|now live (?:on|with)|is live (?:on|with)|selects?|selected|chooses?|chose|has chosen|replac(?:es|ed|ing)|migrat(?:es|ed|ing)|switch(?:es|ed) (?:to|from)|welcome(?:s)? .{0,60}(?:as a (?:new )?customer|to the .{0,30}(?:family|community))|implement(?:s|ed|ation) (?:of|at|with)|partner(?:s|ed) with .{0,60} to (?:implement|deploy|roll))\b/i;
const CUSTOMER = /\b(customer|client|case study|success story)\b/i;
const s = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
function sentence(text, re) {
  const m = re.exec(text); if (!m) return '';
  const a = Math.max(0, text.lastIndexOf('.', m.index) + 1), b = text.indexOf('.', m.index + m[0].length);
  return s(text.slice(a, b < 0 ? text.length : b + 1), 220);
}
function judge(sig) {
  const d = sig.data || {}, text = s(d.post_text, 6000);
  return { url: s(d.post_url, 300), date: s(d.posted_date, 30), decision: DECISION.test(text), customer: CUSTOMER.test(text),
    phrase: sentence(text, DECISION), tech: (d.technologies_mentioned || []).map(t => s(t && t.name, 40)).filter(Boolean).slice(0, 6) };
}
async function run(pool, opts = {}) {
  const key = opts.key != null ? opts.key : process.env.AUTOBOUND_API_KEY;
  if (!key) return null;
  if ((await pool.query('select 1 from signal_tests where name = $1', [NAME])).rows.length) return null;
  const base = (opts.base || 'https://signals.autobound.ai').replace(/\/$/, '');
  const out = { at: new Date().toISOString(), companies: [], posts: 0, dated: 0, decisions: 0, decisionsWithCustomerWord: 0, earliest: '', latest: '', creditsRemaining: null, errors: [], flagged: [] };
  for (const entry of DOMAINS) for (const domain of [].concat(entry)) {
    if (out.posts >= 450) break;
    if (entry !== domain && out.companies.some(c => c.status === 200 && c.posts && [].concat(entry).includes(c.domain))) break;
    try {
      const r = await fetch(base + '/v1/companies/enrich', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ domain, signal_types: ['linkedin-post-company'], limit: Math.min(PER, 450 - out.posts) }) });
      const rem = r.headers.get('x-credits-remaining'); if (rem != null) out.creditsRemaining = Number(rem);
      if (!r.ok) { out.companies.push({ domain, status: r.status, posts: 0 }); if (r.status === 401 || r.status === 402) { out.errors.push(domain + ': ' + r.status); break; } continue; }
      const j = await r.json(), sigs = j.signals || [];
      const c = { domain, status: 200, posts: sigs.length, dated: 0, decisions: 0, range: (j.coverage && j.coverage.date_range) || null, available: (j.coverage && j.coverage.total_before_filters) || null };
      for (const sig of sigs) {
        const v = judge(sig);
        out.posts++;
        if (v.date) { c.dated++; out.dated++; if (!out.earliest || v.date < out.earliest) out.earliest = v.date; if (!out.latest || v.date > out.latest) out.latest = v.date; }
        if (v.decision) { c.decisions++; out.decisions++; if (v.customer) out.decisionsWithCustomerWord++; out.flagged.push({ domain, date: v.date, url: v.url, phrase: v.phrase, tech: v.tech }); }
      }
      out.companies.push(c);
    } catch (e) { out.errors.push(domain + ': ' + s(e.message, 160)); }
  }
  /* a refused key or an empty balance is not a finished test: nothing is stored, so the next run tries again */
  if (!out.posts && out.errors.length) return out;
  await pool.query('insert into signal_tests (name, data) values ($1,$2) on conflict (name) do nothing', [NAME, JSON.stringify(out)]);
  return out;
}
module.exports = { run, judge, NAME, DOMAINS };
