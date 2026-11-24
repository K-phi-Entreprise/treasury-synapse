'use strict';
/* Topic trends: each topic's share of the dated public stages per quarter, since 2025.
 * Counts would measure what the crawler read, not what the market says (one conference loaded = a spike), so a topic is
 * measured as a share of all dated stages of the quarter. Big conferences are kept apart too: a series with
 * EVENT_MIN or more stages in one month (Sibos, AFP...) is an event, and the trend arrow is read on the stages
 * without events. Arrow: last two quarters against the two before, only when there is enough to read. */
const { topicsOf, TOPICS } = require('./topics');
const { FROM_YEAR, NOT_A_STAGE } = require('./recency');

const EVENT_MIN = 15;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  janv: 1, fév: 2, fevr: 2, févr: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, août: 8, sept: 9, déc: 12 };

/* 'YYYY-MM' from the stage's own date, otherwise from a month written in its label ("Oct 2025", "16 Oct 2026", "2026-01-21") */
function monthOf(date, label) {
  const d = String(date || '').match(/^(\d{4})-(\d{2})/);
  if (d) return d[1] + '-' + d[2];
  const s = String(label || '');
  const iso = s.match(/\b(20\d{2})-(\d{2})(?:-\d{2})?\b/);
  if (iso) return iso[1] + '-' + iso[2];
  const w = s.toLowerCase().match(/\b([a-zéû]{3,5})\.?\s+(20\d{2})\b/);
  if (w && MON[w[1]]) return w[2] + '-' + String(MON[w[1]]).padStart(2, '0');
  return null;
}
const quarterOf = m => m.slice(0, 4) + 'Q' + (Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1);
/* the series a stage belongs to: its label up to the first colon or comma, years kept ("Sibos 2026", "AFP 2026 conference") */
const seriesOf = label => String(label || '').split(/[:,]/)[0].replace(/\s+/g, ' ').trim().toLowerCase();

function quartersFrom(fromYear, today) {
  const out = [], end = quarterOf(today.toISOString().slice(0, 7));
  for (let y = fromYear; y <= today.getUTCFullYear(); y++) for (let q = 1; q <= 4; q++) { const k = y + 'Q' + q; out.push(k); if (k === end) return out; }
  return out;
}

/* stages: [{ label, date, kind }] one per public page */
function buildTrends(stages, today = new Date()) {
  const nowM = today.toISOString().slice(0, 7);
  const rows = [];
  for (const s of stages) {
    if (!s || NOT_A_STAGE.has(s.kind)) continue;
    const m = monthOf(s.date, s.label);
    if (!m || Number(m.slice(0, 4)) < FROM_YEAR || m > nowM) continue;
    rows.push({ m, q: quarterOf(m), series: seriesOf(s.label), name: String(s.label || '').split(/[:,]/)[0].trim(), topics: topicsOf(s.label) });
  }
  /* events: a series with many stages in a single month */
  const burst = new Map();
  const shown = new Map();
  rows.forEach(r => { const k = r.series + '|' + r.m; burst.set(k, (burst.get(k) || 0) + 1); if (!shown.has(r.series)) shown.set(r.series, r.name); });
  const events = [...burst].filter(([, n]) => n >= EVENT_MIN).map(([k, n]) => { const [series, month] = k.split('|'); return { series, name: shown.get(series), month, stages: n }; })
    .sort((a, b) => b.stages - a.stages);
  const isEvent = new Set(events.map(e => e.series + '|' + e.month));
  rows.forEach(r => { r.event = isEvent.has(r.series + '|' + r.m); });

  const quarters = quartersFrom(FROM_YEAR, today), qi = new Map(quarters.map((q, i) => [q, i]));
  const zero = () => quarters.map(() => 0);
  const total = zero(), totalCore = zero();
  const topics = {};
  TOPICS.forEach(t => { topics[t] = { all: zero(), core: zero() }; });
  rows.forEach(r => {
    const i = qi.get(r.q); if (i == null) return;
    total[i]++; if (!r.event) totalCore[i]++;
    r.topics.forEach(t => { topics[t].all[i]++; if (!r.event) topics[t].core[i]++; });
  });
  /* arrow: the last two quarters (the current one may be partial) against the two before, on stages without events */
  const n = quarters.length, sum = (a, from, to) => a.slice(Math.max(0, from), to).reduce((x, y) => x + y, 0);
  const recentTot = sum(totalCore, n - 2, n), priorTot = sum(totalCore, n - 4, n - 2);
  for (const t of TOPICS) {
    const o = topics[t];
    const rc = sum(o.core, n - 2, n), pc = sum(o.core, n - 4, n - 2);
    o.recentShare = recentTot ? rc / recentTot : 0;
    o.priorShare = priorTot ? pc / priorTot : 0;
    o.trend = null;
    if (recentTot >= 30 && priorTot >= 30 && rc + pc >= 6) {
      const r = o.recentShare, p = o.priorShare;
      o.trend = r >= p * 1.25 && r - p >= 0.02 ? 'up' : r <= p * 0.8 && p - r >= 0.02 ? 'down' : 'flat';
    }
  }
  return { from: FROM_YEAR, quarters, total, totalCore, events, eventMin: EVENT_MIN, topics,
    window: { recent: quarters.slice(Math.max(0, n - 2)), prior: quarters.slice(Math.max(0, n - 4), Math.max(0, n - 2)), recentStages: recentTot, priorStages: priorTot },
    counted: rows.length, leftOut: stages.length - rows.length };
}

module.exports = { buildTrends, monthOf, quarterOf, seriesOf, EVENT_MIN };
