'use strict';
/* Topic trends: what public stages are about, since 2025.
 * Big conferences are set apart: a series with EVENT_MIN or more stages in one month (Sibos, AFP...) is an event,
 * and the trend is read on the other stages. The chart shows each topic's share of the dated stages per quarter.
 * Rising, falling or steady compares the last six months with the six before (same length, the current month
 * included) and needs the count AND the share to agree:
 *   rising  : at least MIN_MOVE more stages, at least 25% more, and its share of all stages did not fall;
 *   falling : at least MIN_MOVE fewer stages, at least 20% fewer, and its share did not rise;
 *   steady  : anything else, once there are MIN_DATA stages on it across the two periods.
 * A count alone would follow what the crawler read; a share alone would make 2 stages out of 10 look like a wave.
 * Each move also says whether it is beyond chance (a two-proportion z-test at 95%) or an early signal. */
const { topicsOf, TOPICS } = require('./topics');
const { FROM_YEAR, NOT_A_STAGE } = require('./recency');

const EVENT_MIN = 15;
const Z95 = 1.96, MIN_MOVE = 3, MIN_DATA = 5, MONTHS = 6;
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
  /* rising / falling / steady: last MONTHS months against the MONTHS before, stages without events */
  const back = k => { const d = new Date(Date.UTC(Number(nowM.slice(0, 4)), Number(nowM.slice(5, 7)) - 1 - k, 1)); return d.toISOString().slice(0, 7); };
  const recentFrom = back(MONTHS - 1), priorFrom = back(2 * MONTHS - 1);
  const inRecent = r => r.m >= recentFrom, inPrior = r => r.m >= priorFrom && r.m < recentFrom;
  const core = rows.filter(r => !r.event);
  const recentTot = core.filter(inRecent).length, priorTot = core.filter(inPrior).length;
  for (const t of TOPICS) {
    const o = topics[t];
    const rc = core.filter(r => inRecent(r) && r.topics.includes(t)).length, pc = core.filter(r => inPrior(r) && r.topics.includes(t)).length;
    o.recent = rc; o.prior = pc;
    o.recentShare = recentTot ? rc / recentTot : 0;
    o.priorShare = priorTot ? pc / priorTot : 0;
    o.trend = null; o.z = 0; o.confirmed = false;
    if (rc + pc < MIN_DATA || !recentTot || !priorTot) continue;
    const up = rc - pc >= MIN_MOVE && rc >= pc * 1.25 && o.recentShare >= o.priorShare;
    const down = pc - rc >= MIN_MOVE && rc <= pc * 0.8 && o.recentShare <= o.priorShare;
    o.trend = up ? 'up' : down ? 'down' : 'flat';
    const pool = (rc + pc) / (recentTot + priorTot), se = Math.sqrt(pool * (1 - pool) * (1 / recentTot + 1 / priorTot));
    o.z = se ? (o.recentShare - o.priorShare) / se : 0;
    o.confirmed = o.trend !== 'flat' && Math.abs(o.z) >= Z95;
  }
  return { from: FROM_YEAR, quarters, total, totalCore, events, eventMin: EVENT_MIN, topics,
    window: { recent: recentFrom + ' to ' + nowM, prior: priorFrom + ' to ' + back(MONTHS), recentStages: recentTot, priorStages: priorTot, minMove: MIN_MOVE, minData: MIN_DATA },
    counted: rows.length, leftOut: stages.length - rows.length };
}

module.exports = { buildTrends, monthOf, quarterOf, seriesOf, EVENT_MIN };
