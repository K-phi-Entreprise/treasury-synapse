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
    `select case when s.a = $1 then s.b else s.a end as other, s.label, s.url
       from v_social s join people o on o.id = case when s.a = $1 then s.b else s.a end and not o.hidden
      where (s.a = $1 or s.b = $1)`, [id]);
  const stages = new Set(), others = new Map();
  e.rows.forEach(r => { stages.add(r.url || r.label || ''); others.set(r.other, (others.get(r.other) || 0) + 1); });
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
