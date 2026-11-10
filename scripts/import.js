'use strict';
/* Imports a dump of the artifact store (people, edges, vendors, runs, leads, connections) into Postgres.
 * Usage: node scripts/import.js [--if-empty|--merge] data/seed/dump.json
 * --if-empty: do nothing when the people table already has rows (used by the Render pre-deploy step).
 * --merge: catch up a live store without undoing review decisions: people deleted by an approved removal stay deleted,
 *   fields fixed by an approved correction keep the reviewed value, link evidence is unioned by url (confidence = max),
 *   topics/systems/roles are only added, lead and connection statuses are never overwritten. */
const fs = require('fs');
const { makePool } = require('./db');

const KIND_CONF = { podcast: 0.9, panel: 0.9, filing: 0.9, webinar: 0.8, executive: 0.7, article: 0.6, colleague: 0.5 };
const ROLES = new Set(['uses', 'sells', 'implements', 'integrates', 'evaluated']);
const ts = v => { const t = Date.parse(v || ''); return isNaN(t) ? null : new Date(t).toISOString(); };
const LOCKABLE = { headline: 'headline', org: 'org', city: 'city', region: 'region', knownFor: 'known_for' };
const str = v => (v == null ? '' : String(v));

async function importDump(pool, dump, opts = {}) {
  const client = await pool.connect();
  const out = { people: 0, topics: 0, systems: 0, roles: 0, edges: 0, occasions: 0, vendors: 0, runs: 0, leads: 0, connections: 0, skippedEdges: 0 };
  try {
    if (opts.ifEmpty) {
      const r = await client.query('select count(*)::int as n from people');
      if (r.rows[0].n > 0) return Object.assign(out, { skipped: true, existing: r.rows[0].n });
    }
    await client.query('begin');
    const merge = !!opts.merge;
    const removed = new Set(), locked = new Map();
    if (merge) {
      out.removedSkipped = 0; out.lockedFields = 0; out.newPeople = 0; out.newEdges = 0; out.evidenceAdded = 0;
      const subs = await client.query("select kind, person_id, payload from submissions where status = 'approved' and kind in ('removal','correction') and person_id is not null");
      for (const r of subs.rows) {
        if (r.kind === 'removal') removed.add(r.person_id);
        else if (r.payload && LOCKABLE[r.payload.field]) (locked.get(r.person_id) || locked.set(r.person_id, new Set()).get(r.person_id)).add(r.payload.field);
      }
    }
    const existing = new Map();
    if (merge) for (const r of (await client.query('select id, headline, org, city, region, known_for from people')).rows) existing.set(r.id, r);
    const ids = new Set(existing.keys());
    for (const p of dump.people || []) {
      if (!p || !p.id || !p.name) continue;
      if (removed.has(p.id) && !existing.has(p.id)) { out.removedSkipped++; continue; }
      if (merge && !existing.has(p.id)) out.newPeople++;
      ids.add(p.id);
      const lock = locked.get(p.id), cur = existing.get(p.id);
      const keep = (field, v) => { if (lock && cur && lock.has(field)) { out.lockedFields++; return cur[LOCKABLE[field]]; } return v; };
      await client.query(
        `insert into people (id,name,headline,org,city,region,segment,seed,found_via,source,known_for,publishers,publisher_domains,followers,
           added_at,crawled_at,deepened_at,crawl_attempts,deepen_attempts,parked,parked_reason,insight_notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         on conflict (id) do update set name=excluded.name, headline=excluded.headline, org=excluded.org, city=excluded.city, region=excluded.region,
           segment=excluded.segment, seed=excluded.seed, found_via=excluded.found_via, source=excluded.source, known_for=excluded.known_for,
           publishers=excluded.publishers, publisher_domains=excluded.publisher_domains, followers=excluded.followers, added_at=excluded.added_at,
           crawled_at=excluded.crawled_at, deepened_at=excluded.deepened_at, crawl_attempts=excluded.crawl_attempts, deepen_attempts=excluded.deepen_attempts,
           parked=excluded.parked, parked_reason=excluded.parked_reason, insight_notes=excluded.insight_notes, updated_at=now()`,
        [p.id, str(p.name), keep('headline', str(p.headline)), keep('org', str(p.org)), keep('city', str(p.city)), keep('region', str(p.region) || 'Unknown'),
         str(p.segment) || 'Corporate treasury', !!p.seed, p.foundVia || null, str(p.source), keep('knownFor', str(p.knownFor)), Number(p.publishers) || 0, Array.isArray(p.publisherDomains) ? p.publisherDomains.map(String) : [],
         p.followers == null ? null : Number(p.followers), ts(p.addedAt), ts(p.crawledAt), ts(p.deepenedAt), Number(p.crawlAttempts) || 0,
         Number(p.deepenAttempts) || 0, !!p.parked, str(p.parkedReason), str(p.insightNotes)]);
      out.people++;
      for (const t of Array.isArray(p.topics) ? p.topics : []) {
        if (!t) continue;
        await client.query('insert into person_topics (person_id, topic) values ($1,$2) on conflict do nothing', [p.id, str(t)]);
        out.topics++;
      }
      for (const s of Array.isArray(p.systems) ? p.systems : []) {
        if (!s || !s.name || !ROLES.has(s.role)) continue;
        await client.query('insert into person_systems (person_id, system, role, url, date) values ($1,$2,$3,$4,$5) on conflict do nothing',
          [p.id, str(s.name), s.role, str(s.url), str(s.date)]);
        out.systems++;
      }
      for (const r of Array.isArray(p.roles) ? p.roles : []) {
        if (!r || !(r.title || r.org)) continue;
        await client.query('insert into person_roles (person_id, title, org, from_year, to_year, url) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
          [p.id, str(r.title), str(r.org), str(r.from), str(r.to), str(r.url)]);
        out.roles++;
      }
    }
    for (const e of dump.edges || []) {
      if (!e || !e.a || !e.b || e.a === e.b || !ids.has(e.a) || !ids.has(e.b)) { out.skippedEdges++; continue; }
      const [a, b] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
      const kind = KIND_CONF[e.kind] ? e.kind : 'article';
      let ev = Array.isArray(e.evidence) && e.evidence.length ? e.evidence : [{ url: str(e.url), label: str(e.label), date: '', kind }];
      let conf = Number(e.confidence) || KIND_CONF[kind], head = { kind, label: str(e.label), url: str(e.url) };
      if (merge) {
        const old = (await client.query('select kind, label, url, confidence, evidence from co_appearances where a = $1 and b = $2', [a, b])).rows[0];
        if (!old) out.newEdges++;
        else {
          const seen = new Set((old.evidence || []).map(x => x && x.url));
          const add = ev.filter(x => x && x.url && !seen.has(x.url));
          out.evidenceAdded += add.length;
          ev = (old.evidence || []).concat(add);
          conf = Math.max(conf, Number(old.confidence) || 0);
          head = { kind: old.kind, label: old.label, url: old.url };
        }
      }
      await client.query(
        `insert into co_appearances (a,b,kind,label,url,confidence,evidence,added_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (a,b) do update set kind=excluded.kind, label=excluded.label, url=excluded.url, confidence=excluded.confidence, evidence=excluded.evidence, updated_at=now()`,
        [a, b, head.kind, head.label, head.url, conf, JSON.stringify(ev), ts(e.addedAt)]);
      out.edges++;
      for (const x of ev) {
        if (!x || !x.url) continue;
        const o = await client.query(
          `insert into occasions (url, kind, label, date) values ($1,$2,$3,$4)
           on conflict (url) do update set label = case when occasions.label = '' then excluded.label else occasions.label end returning id, (xmax = 0) as inserted`,
          [str(x.url), KIND_CONF[x.kind] ? x.kind : kind, str(x.label), str(x.date)]);
        if (o.rows[0].inserted) out.occasions++;
        await client.query('insert into appearances (occasion_id, person_id) values ($1,$2),($1,$3) on conflict do nothing', [o.rows[0].id, a, b]);
      }
    }
    for (const c of dump.connections || []) {
      if (!c || !c.from || !c.to || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to) continue;
      await client.query(
        `insert into connections (from_id,to_id,status,note,by_viewer,added_at) values ($1,$2,$3,$4,$5,$6)
         on conflict (from_id,to_id) do ${merge ? 'nothing' : 'update set status=excluded.status, updated_at=now()'}`,
        [c.from, c.to, ['pending', 'confirmed', 'rejected'].includes(c.status) ? c.status : 'pending', str(c.note), str(c.by), ts(c.addedAt) || new Date().toISOString()]);
      out.connections++;
    }
    for (const v of dump.vendors || []) {
      if (!v || !v.id) continue;
      await client.query('insert into vendors (id, data) values ($1,$2) on conflict (id) do update set data=excluded.data', [v.id, JSON.stringify(v)]);
      out.vendors++;
    }
    for (const r of dump.runs || []) {
      if (!r || !r.id) continue;
      await client.query('insert into runs (id, data, started_at) values ($1,$2,$3) on conflict (id) do update set data=excluded.data', [r.id, JSON.stringify(r), ts(r.startedAt)]);
      out.runs++;
    }
    for (const l of dump.leads || []) {
      if (!l || !l.id || !l.url) continue;
      await client.query(
        `insert into leads (id,url,reason,person_id,snippet,status,added_at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
        [l.id, str(l.url), str(l.reason), l.personId || null, str(l.snippet), str(l.status) || 'pending', ts(l.addedAt)]);
      out.leads++;
    }
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const ifEmpty = args.includes('--if-empty'), merge = args.includes('--merge');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/import.js [--if-empty|--merge] <dump.json>'); process.exit(2); }
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pool = makePool();
  importDump(pool, dump, { ifEmpty, merge }).then(r => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { importDump };
