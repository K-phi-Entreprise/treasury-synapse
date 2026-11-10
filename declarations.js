'use strict';
/* What a person says about their own work, on a claimed card: systems with what they did and on which topics,
 * topics they worked on or implemented, whether they are open to a reference call, whether they take projects.
 * Declarations are shown as "declared by them" and kept apart from the evidence: they never create links or change
 * bubble size. They go live at once; the owner can remove any of them from /review. */
const TOPICS = ['AI in finance', 'Payments', 'Treasury technology', 'Cash forecasting', 'Liquidity', 'FP&A & planning', 'Risk & compliance', 'Fraud',
  'Bank connectivity', 'Debt & funding', 'Working capital', 'ESG & sustainable finance', 'FX & hedging', 'Crypto & stablecoins', 'AR/AP',
  'In-house banking', 'TMS selection', 'Consolidation', 'Commodities'];
const SYSTEM_ROLES = ['uses', 'implements', 'integrates', 'evaluated', 'sells'];
const TOPIC_ROLES = ['worked_on', 'implemented'];
const REGIONS = ['United States', 'United Kingdom', 'France', 'DACH', 'Benelux', 'Nordics', 'Southern Europe', 'Asia-Pacific', 'Other'];
const MAX = { systems: 25, topics: 19 };

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const year = v => (/^(19|20)\d\d$/.test(clip(v, 4)) ? clip(v, 4) : '');

/* validate a whole card as sent by the editor; returns { rows, profile } or { error } */
function clean(body) {
  const b = body || {};
  const sys = Array.isArray(b.systems) ? b.systems : [], top = Array.isArray(b.topics) ? b.topics : [];
  if (sys.length > MAX.systems) return { error: 'at most ' + MAX.systems + ' systems' };
  const rows = [], seen = new Set();
  for (const s of sys) {
    const system = clip(s && s.system, 60), role = String(s && s.role || '');
    if (!system) continue;
    if (!SYSTEM_ROLES.includes(role)) return { error: 'unknown role for ' + system };
    const k = system.toLowerCase() + '|' + role;
    if (seen.has(k)) continue; seen.add(k);
    const topics = [...new Set((Array.isArray(s.topics) ? s.topics : []).filter(t => TOPICS.includes(t)))];
    rows.push({ kind: 'system', system, role, topics, from: year(s.from), to: year(s.to), referenceOk: !!s.referenceOk, note: clip(s.note, 200) });
  }
  const tseen = new Set();
  for (const t of top.slice(0, MAX.topics * 2)) {
    const topic = String(t && t.topic || ''), role = String(t && t.role || '');
    if (!TOPICS.includes(topic) || !TOPIC_ROLES.includes(role)) continue;
    if (tseen.has(topic + role)) continue; tseen.add(topic + role);
    rows.push({ kind: 'topic', system: '', role, topics: [topic], from: '', to: '', referenceOk: false, note: '' });
  }
  const p = b.profile || {};
  const profile = { forHire: !!p.forHire, regions: [...new Set((Array.isArray(p.regions) ? p.regions : []).filter(r => REGIONS.includes(r)))],
    languages: [...new Set((Array.isArray(p.languages) ? p.languages : String(p.languages || '').split(',')).map(l => clip(l, 30)).filter(Boolean))].slice(0, 8),
    note: clip(p.note, 300) };
  return { rows, profile };
}

function mount(app, { pool, claims, onChange, admin }) {
  async function load(id) {
    const [d, p] = await Promise.all([
      pool.query('select * from declarations where person_id = $1 and removed_at is null order by kind, system, role', [id]),
      pool.query('select * from person_profile where person_id = $1', [id])]);
    return { rows: d.rows, profile: p.rows[0] || null };
  }
  const view = ({ rows, profile }) => ({
    systems: rows.filter(r => r.kind === 'system').map(r => ({ id: r.id, system: r.system, role: r.role, topics: r.topics, from: r.from_year, to: r.to_year, referenceOk: r.reference_ok, note: r.note })),
    topics: rows.filter(r => r.kind === 'topic').map(r => ({ id: r.id, topic: r.topics[0], role: r.role })),
    profile: profile ? { forHire: profile.for_hire, regions: profile.regions, languages: profile.languages, note: profile.note } : { forHire: false, regions: [], languages: [], note: '' }
  });

  app.get('/api/me/card', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const m = await claims.me(req);
      if (!m) return res.status(401).json({ error: 'sign in to your card first' });
      res.json(Object.assign({ personId: m.id, name: m.name, choices: { topics: TOPICS, roles: SYSTEM_ROLES, regions: REGIONS } }, view(await load(m.id))));
    } catch (e) { next(e); }
  });

  app.put('/api/me/card', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const m = await claims.me(req);
      if (!m) return res.status(401).json({ error: 'sign in to your card first' });
      const c = clean(req.body);
      if (c.error) return res.status(400).json({ error: c.error });
      await client.query('begin');
      /* replace the person's live declarations; rows the owner removed stay removed */
      await client.query('delete from declarations where person_id = $1 and removed_at is null', [m.id]);
      for (const r of c.rows) {
        await client.query(`insert into declarations (person_id, kind, system, role, topics, from_year, to_year, reference_ok, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [m.id, r.kind, r.system, r.role, r.topics, r.from, r.to, r.referenceOk, r.note]);
      }
      await client.query(`insert into person_profile (person_id, for_hire, regions, languages, note, updated_at) values ($1,$2,$3,$4,$5,now())
        on conflict (person_id) do update set for_hire = excluded.for_hire, regions = excluded.regions, languages = excluded.languages, note = excluded.note, updated_at = now()`,
        [m.id, c.profile.forHire, c.profile.regions, c.profile.languages, c.profile.note]);
      await client.query('update people set updated_at = now() where id = $1', [m.id]);
      await client.query('commit');
      if (onChange) onChange();
      res.json(Object.assign({ ok: true }, view(await load(m.id))));
    } catch (e) { await client.query('rollback').catch(() => {}); next(e); } finally { client.release(); }
  });

  /* what every claimed card declares, for the map: small, so it is fetched apart from the graph */
  app.get('/api/declared', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-cache');
      const [d, p] = await Promise.all([
        pool.query(`select d.* from declarations d join claims c on c.person_id = d.person_id and c.confirmed_at is not null where d.removed_at is null order by d.kind, d.system`),
        pool.query(`select p.* from person_profile p join claims c on c.person_id = p.person_id and c.confirmed_at is not null`)]);
      const out = {};
      const get = id => out[id] || (out[id] = { systems: [], topics: [], profile: null });
      for (const r of d.rows) {
        if (r.kind === 'system') get(r.person_id).systems.push({ system: r.system, role: r.role, topics: r.topics, from: r.from_year, to: r.to_year, referenceOk: r.reference_ok, note: r.note });
        else get(r.person_id).topics.push({ topic: r.topics[0], role: r.role });
      }
      for (const r of p.rows) if (r.for_hire || r.regions.length || r.languages.length || r.note) get(r.person_id).profile = { forHire: r.for_hire, regions: r.regions, languages: r.languages, note: r.note };
      res.json({ people: out });
    } catch (e) { next(e); }
  });

  /* the owner sees what was declared lately and can take any of it down */
  app.get('/api/admin/declarations', admin, async (req, res, next) => {
    try {
      const r = await pool.query(`select d.*, p.name from declarations d join people p on p.id = d.person_id where d.removed_at is null order by d.added_at desc limit 200`);
      const f = await pool.query(`select pp.*, p.name from person_profile pp join people p on p.id = pp.person_id where pp.for_hire order by pp.updated_at desc limit 100`);
      res.json({ declarations: r.rows, available: f.rows });
    } catch (e) { next(e); }
  });
  app.post('/api/admin/declarations/:id', admin, async (req, res, next) => {
    try {
      const r = await pool.query('update declarations set removed_at = now() where id = $1 and removed_at is null returning person_id', [Number(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      await pool.query('update people set updated_at = now() where id = $1', [r.rows[0].person_id]);
      if (onChange) onChange();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post('/api/admin/available/:personId', admin, async (req, res, next) => {
    try {
      await pool.query('update person_profile set for_hire = false, updated_at = now() where person_id = $1', [String(req.params.personId).slice(0, 120)]);
      if (onChange) onChange();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { mount, clean, TOPICS, SYSTEM_ROLES, REGIONS };
