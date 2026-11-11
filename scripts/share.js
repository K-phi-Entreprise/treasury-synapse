'use strict';
/* A shareable link per person: /p/<id> serves the map with that person's own link preview,
   and /p/<id>.png draws the picture LinkedIn and others show on the card. */
const ID = /^[a-z0-9][a-z0-9-]{0,119}$/;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

async function personShare(pool, id) {
  if (!ID.test(String(id || ''))) return null;
  const p = await pool.query('select id, name, headline, org, region, segment from people where id = $1 and not hidden', [id]);
  if (!p.rows.length) return null;
  const person = p.rows[0];
  /* co-appearances: the stages they were on, and who shared them */
  const e = await pool.query(
    `select case when s.a = $1 then s.b else s.a end as other, s.label, s.url, s.kind, s.evidence
       from v_social s join people o on o.id = case when s.a = $1 then s.b else s.a end and not o.hidden
      where (s.a = $1 or s.b = $1)`, [id]);
  const stages = new Set(), others = new Map();
  const { recentEdge, recent } = require('./recency');
  e.rows.map(recentEdge).filter(Boolean).forEach(r => {
    (r.evidence && r.evidence.length ? r.evidence : [r]).filter(recent).forEach(x => stages.add(x.url || x.label || ''));
    others.set(r.other, (others.get(r.other) || 0) + 1);
  });
  const ids = [...others.keys()];
  const names = ids.length ? (await pool.query('select id, name, segment from people where id = any($1)', [ids])).rows : [];
  const byId = new Map(names.map(r => [r.id, r]));
  const peers = ids.map(x => ({ id: x, name: (byId.get(x) || {}).name || '', segment: (byId.get(x) || {}).segment || '', weight: others.get(x) }))
    .filter(x => x.name).sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  /* their organisation and what it runs, for people with no co-appearance yet */
  let org = null;
  if (person.org) {
    const c = await pool.query(
      `select c.name, coalesce(json_agg(distinct i.system) filter (where i.system is not null and i.status in ('live','implementing')), '[]') as systems
         from companies c left join installs i on i.company_id = c.id
        where lower(c.name) = lower($1) and not c.hidden group by c.name limit 1`, [person.org]).catch(() => ({ rows: [] }));
    if (c.rows.length) org = { name: c.rows[0].name, systems: c.rows[0].systems.slice(0, 6) };
  }
  return { person, stages: stages.size, peers, org };
}

function shareMeta(s, base) {
  const p = s.person;
  const bits = [];
  if (s.stages) bits.push(plural(s.stages, 'public stage'));
  if (s.peers.length) bits.push(plural(s.peers.length, 'co-speaker'));
  const title = p.name + ' on Treasury & FP&A Synapses';
  const who = [p.headline || '', p.org && !(p.headline || '').includes(p.org) ? p.org : ''].filter(Boolean).join(', ');
  const desc = (who ? who + '. ' : '') + (bits.length ? bits.join(', ') + ', all from public pages. ' : '') + 'See who runs which treasury and FP&A system. Are you on the map?';
  const url = base + '/p/' + p.id;
  return { title, desc, url, image: url + '.png' };
}

/* the map's own page, with the head swapped to this person */
function sharePage(html, m) {
  const set = (re, tag) => { html = re.test(html) ? html.replace(re, tag) : html.replace('</head>', tag + '\n</head>'); };
  set(/<title>[^<]*<\/title>/, '<title>' + esc(m.title) + '</title>');
  set(/<link rel="canonical"[^>]*>/, '<link rel="canonical" href="' + esc(m.url) + '">');
  set(/<meta name="description"[^>]*>/, '<meta name="description" content="' + esc(m.desc) + '">');
  set(/<meta property="og:url"[^>]*>/, '<meta property="og:url" content="' + esc(m.url) + '">');
  set(/<meta property="og:title"[^>]*>/, '<meta property="og:title" content="' + esc(m.title) + '">');
  set(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="' + esc(m.desc) + '">');
  set(/<meta property="og:image" [^>]*>/, '<meta property="og:image" content="' + esc(m.image) + '">');
  set(/<meta property="og:image:alt"[^>]*>/, '<meta property="og:image:alt" content="' + esc(m.title + ': their public network in treasury and FP&A') + '">');
  set(/<meta name="twitter:title"[^>]*>/, '<meta name="twitter:title" content="' + esc(m.title) + '">');
  set(/<meta name="twitter:image"[^>]*>/, '<meta name="twitter:image" content="' + esc(m.image) + '">');
  return html;
}

module.exports = { personShare, shareMeta, sharePage, ID, esc };

/* ---------- the picture: 1200 x 628, drawn as SVG and rasterised with resvg ---------- */
const SEG = { 'Corporate treasury': '#4fd1e8', 'Banks': '#f3b35c', 'TMS & fintech': '#a98bff', 'Advisors': '#ff7d9e', 'Media': '#8ef0b6', 'EPM & FP&A software': '#f2dc6d' };
const ACCENT = '#e6ff00', W = 1200, H = 628;
const FONTS = ['Inter-Regular.otf', 'Inter-SemiBold.otf', 'Inter-Bold.otf'].map(f => require('path').join(__dirname, '..', 'assets', 'fonts', f));
function seeded(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; }; }
const cut = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
function wrap(t, n, lines) {
  const words = String(t || '').split(/\s+/).filter(Boolean), out = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = cut(out[lines - 1] + ' …', n).replace(/ …$/, '…'); if (!/…$/.test(out[lines - 1])) out[lines - 1] = cut(out[lines - 1], n - 1) + '…'; }
  return out;
}

function shareSvg(s) {
  const p = s.person, rnd = seeded(p.id), cx = 830, cy = 314;
  const color = SEG[p.segment] || '#ecedf7';
  let stars = '';
  for (let i = 0; i < 90; i++) stars += `<circle cx="${(rnd() * W).toFixed(1)}" cy="${(rnd() * H).toFixed(1)}" r="${(0.5 + rnd() * 1.1).toFixed(2)}" fill="#ffffff" opacity="${(0.12 + rnd() * 0.35).toFixed(2)}"/>`;
  let lines = '', nodes = '', labels = '';
  const label = (x, y, ang, text, size, fill) => {
    const right = Math.cos(ang) >= 0, dx = right ? 1 : -1;
    labels += `<text x="${(x + dx * 14).toFixed(1)}" y="${(y + size * 0.35).toFixed(1)}" font-size="${size}" font-weight="600" fill="${fill}" text-anchor="${right ? 'start' : 'end'}">${esc(text)}</text>`;
  };
  if (s.peers.length) {
    const shown = s.peers.slice(0, 28), n = shown.length, maxW = shown[0].weight;
    /* names on about ten nodes spread around the ring, always on the outer ring so they never sit on a dot */
    const named = new Set(); if (n <= 10) shown.forEach((q, k) => named.add(k)); else for (let i = 0; i < 10; i++) named.add(Math.round(i * n / 10));
    shown.forEach((q, k) => {
      const ang = -Math.PI / 2 + (k / n) * Math.PI * 2 + (n > 1 ? 0 : 0.6);
      const r = n <= 10 ? 175 : named.has(k) ? 212 : (k % 2 ? 175 : 140) + rnd() * 12;
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r * 0.92, c = SEG[q.segment] || '#c9cbe0';
      const sz = 6 + 9 * Math.sqrt(q.weight / maxW);
      lines += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c}" stroke-width="${(1 + q.weight / maxW * 1.6).toFixed(2)}" opacity=".5"/>`;
      nodes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(sz * 1.9).toFixed(1)}" fill="${c}" opacity=".13"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sz.toFixed(1)}" fill="${c}"/>`;
      if (named.has(k)) label(x + Math.cos(ang) * sz * 0.4, y, ang, cut(q.name, 20), 15, '#dfe0ee');
    });
  } else if (s.org) {
    const ox = cx + 120, oy = cy - 40, sys = s.org.systems;
    lines += `<line x1="${cx}" y1="${cy}" x2="${ox}" y2="${oy}" stroke="#ecedf7" stroke-width="2" opacity=".5"/>`;
    nodes += `<circle cx="${ox}" cy="${oy}" r="13" fill="#ecedf7"/>`;
    label(ox, oy - 26, 0, cut(s.org.name, 22), 16, '#ecedf7');
    sys.forEach((x, k) => {
      const ang = -Math.PI / 2 + (k + 0.5) / Math.max(sys.length, 1) * Math.PI * 1.2, sx = ox + Math.cos(ang) * 150, sy = oy + Math.sin(ang) * 150;
      lines += `<line x1="${ox}" y1="${oy}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" stroke="${ACCENT}" stroke-width="1.6" opacity=".55"/>`;
      nodes += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="22" fill="${ACCENT}" opacity=".15"/><circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="8" fill="${ACCENT}"/>`;
      label(sx, sy, ang, cut(x, 20), 15, '#dfe0ee');
    });
  } else {
    nodes += `<circle cx="${cx}" cy="${cy}" r="120" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-dasharray="4 8"/>`;
  }
  const head = [p.headline || '', p.org && !(p.headline || '').includes(p.org) ? p.org : ''].filter(Boolean).join(', ');
  const nameSize = Math.max(38, Math.min(64, Math.floor(430 / (Math.max(p.name.length, 8) * 0.56))));
  const nameLines = wrap(p.name, Math.floor(430 / (nameSize * 0.56)), 2);
  const headLines = wrap(head, 36, 3);
  const stat = s.peers.length ? [s.stages ? plural(s.stages, 'public stage') : '', plural(s.peers.length, 'co-speaker')].filter(Boolean).join('  ·  ')
    : s.org && s.org.systems.length ? plural(s.org.systems.length, 'system') + ' at ' + cut(s.org.name, 24) : 'New on the map';
  let y = 150, text = `<text x="56" y="92" font-size="15" font-weight="600" letter-spacing="2.4" fill="${ACCENT}">TREASURY &amp; FP&amp;A SYNAPSES</text>`;
  nameLines.forEach(l => { y += nameSize * 1.08; text += `<text x="56" y="${y.toFixed(0)}" font-size="${nameSize}" font-weight="700" fill="#f4f5fb">${esc(l)}</text>`; });
  y += 18;
  headLines.forEach(l => { y += 31; text += `<text x="56" y="${y.toFixed(0)}" font-size="23" fill="#a9abc7">${esc(l)}</text>`; });
  text += `<text x="56" y="532" font-size="22" font-weight="600" fill="#ecedf7">${esc(stat)}</text>`;
  text += `<text x="56" y="572" font-size="18" fill="#7d7f9c">synapse.k-phi.com  ·  every link from a public page</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">
<defs><radialGradient id="bg" cx="69%" cy="50%" r="70%"><stop offset="0" stop-color="#17172e"/><stop offset=".55" stop-color="#0c0c19"/><stop offset="1" stop-color="#07070f"/></radialGradient>
<radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="${color}" stop-opacity=".9"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${stars}
<g filter="url(#glow)" opacity=".7">${lines}</g><g>${lines}</g><g>${nodes}</g>
<circle cx="${cx}" cy="${cy}" r="62" fill="url(#core)"/><circle cx="${cx}" cy="${cy}" r="17" fill="#ffffff"/>
<g>${labels}</g>${text}</svg>`;
}

let Resvg = null;
function shareImage(s) {
  if (!Resvg) Resvg = require('@resvg/resvg-js').Resvg;
  const r = new Resvg(shareSvg(s), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } });
  return r.render().asPng();
}

module.exports.shareSvg = shareSvg;
module.exports.shareImage = shareImage;
