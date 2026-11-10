'use strict';
/* Find a consultant: advisors and people available for projects, ranked by what public pages show first
 * ("implements Nomentia, 4 sources"), then by what they declared on a claimed card, then by region.
 * Anyone whose pages or card say they sell the system is left out: they are a vendor for that search. */
function mount(app, { pool, topics, regions }) {
  const lc = s => String(s || '').toLowerCase().trim();
  app.get('/api/consultants', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-cache');
      const system = String(req.query.system || '').trim().slice(0, 60), topic = topics.includes(req.query.topic) ? req.query.topic : '', region = regions.includes(req.query.region) ? req.query.region : '';
      const sys = lc(system);
      /* "SAP" finds "SAP Treasury and Risk Management" too */
      const hit = name => { const n = lc(name); return n === sys || (sys.length >= 3 && (n.startsWith(sys + ' ') || n.includes(' ' + sys) || n.startsWith(sys))); };
      const base = (await pool.query(`select p.id, p.name, p.headline, p.org, p.region, p.segment,
          coalesce(pp.for_hire, false) for_hire, coalesce(pp.regions, '{}') hire_regions, coalesce(pp.languages, '{}') languages, coalesce(pp.note, '') hire_note,
          (c.confirmed_at is not null) claimed
        from people p left join person_profile pp on pp.person_id = p.id left join claims c on c.person_id = p.id and c.confirmed_at is not null
        where not p.hidden and (p.segment = 'Advisors' or coalesce(pp.for_hire, false))`)).rows;
      const ids = base.map(b => b.id);
      const [ev, dec, tp] = await Promise.all([
        pool.query(`select person_id, system, role, count(*)::int n from person_systems where person_id = any($1) group by 1,2,3`, [ids]),
        pool.query(`select d.person_id, d.kind, d.system, d.role, d.topics, d.reference_ok from declarations d join claims c on c.person_id = d.person_id and c.confirmed_at is not null
          where d.removed_at is null and d.person_id = any($1)`, [ids]),
        topic ? pool.query('select person_id from person_topics where topic = $1 and person_id = any($2)', [topic, ids]) : { rows: [] }]);
      const by = new Map(base.map(b => [b.id, Object.assign(b, { evidence: [], declared: [], sells: false, topicHit: false, score: 0 })]));
      for (const e of ev.rows) {
        const p = by.get(e.person_id);
        if (sys && !hit(e.system)) continue;
        if (e.role === 'sells') { if (sys) p.sells = true; continue; }
        if (['implements', 'integrates', 'evaluated', 'uses'].includes(e.role)) p.evidence.push({ system: e.system, role: e.role, sources: e.n });
      }
      for (const d of dec.rows) {
        const p = by.get(d.person_id);
        if (d.kind === 'topic') { if (topic && d.topics.includes(topic)) p.topicHit = true; continue; }
        if (sys && !hit(d.system)) continue;
        if (d.role === 'sells') { if (sys) p.sells = true; continue; }
        p.declared.push({ system: d.system, role: d.role, topics: d.topics, referenceOk: d.reference_ok });
        if (topic && d.topics.includes(topic)) p.topicHit = true;
      }
      for (const t of tp.rows) by.get(t.person_id).topicHit = true;
      const W = { implements: 3, integrates: 3, evaluated: 1, uses: 1 };
      let out = [...by.values()].filter(p => !p.sells);
      if (sys) out = out.filter(p => p.evidence.length || p.declared.length);
      if (topic) out = out.filter(p => p.topicHit);
      for (const p of out) {
        p.regionMatch = !!region && (p.region === region || p.hire_regions.includes(region));
        p.score = p.evidence.reduce((s, e) => s + W[e.role] * Math.min(e.sources, 5), 0) + p.declared.reduce((s, d) => s + (d.role === 'implements' || d.role === 'integrates' ? 2 : 1), 0)
          + (p.regionMatch ? 3 : 0) + (p.for_hire ? 2 : 0) + (p.claimed ? 1 : 0);
      }
      if (region) out = out.filter(p => p.regionMatch || !p.region || p.region === 'Unknown' || p.score >= 6);
      out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      res.json({ total: out.length, consultants: out.slice(0, 40).map(p => ({ id: p.id, name: p.name, headline: p.headline, org: p.org, region: p.region,
        available: p.for_hire, claimed: p.claimed, regionMatch: p.regionMatch, regions: p.hire_regions, languages: p.languages, note: p.hire_note,
        evidence: p.evidence.sort((a, b) => b.sources - a.sources).slice(0, 4), declared: p.declared.slice(0, 4) })) });
    } catch (e) { next(e); }
  });
}
module.exports = { mount };
