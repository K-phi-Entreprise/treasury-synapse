'use strict';
/* The People view counts stages from 2025 on. A source dated before then is left out; a source with no date is kept.
 * The year comes from the evidence's own date, otherwise from a year written in its label ("5 episodes (2019-2022)" → 2022). */
const FROM_YEAR = 2025;
function evidenceYear(x) {
  if (!x) return null;
  const d = String(x.date || '').match(/\b(19|20)\d{2}\b/);
  if (d) return Number(d[0]);
  const ys = String(x.label || '').match(/\b(?:19|20)\d{2}\b/g);
  return ys ? Math.max(...ys.map(Number)) : null;
}
const recent = x => { const y = evidenceYear(x); return y == null || y >= FROM_YEAR; };
/* an edge row ({kind,label,url,evidence,...}) trimmed to its recent evidence, or null when none is left */
function recentEdge(e) {
  const ev = Array.isArray(e.evidence) && e.evidence.length ? e.evidence : [{ url: e.url, label: e.label, date: '', kind: e.kind }];
  const keep = ev.filter(recent);
  if (!keep.length) return null;
  if (keep.length === ev.length) return e;
  const head = keep.find(x => x.url === e.url) || keep[0];
  return Object.assign({}, e, { evidence: keep, url: head.url || e.url, label: head.label || e.label, kind: head.kind || e.kind });
}
module.exports = { FROM_YEAR, evidenceYear, recent, recentEdge };
