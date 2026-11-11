'use strict';
/* Hand-researched stages: data/people-seed*.json, each loaded once (on deploy, after the schema).
 * File shape: { people: [{ id, name, headline, org, region, segment, source }],
 *               stages: [{ url, label, kind, date, people: [id, ...] }] }
 * A person already on the map is never overwritten. Every stage is recorded as an occasion with one appearance per person
 * (a solo keynote counts too); every pair on the same stage gets a co-appearance whose evidence is unioned by url. */
const fs = require('fs');
const path = require('path');

const KIND_CONF = { podcast: 0.9, panel: 0.9, filing: 0.9, webinar: 0.8, executive: 0.7, article: 0.6, talk: 0.85 };
const SEGMENTS = new Set(['Corporate treasury', 'Banks', 'TMS & fintech', 'Advisors', 'Media', 'EPM & FP&A software']);
const str = v => (v == null ? '' : String(v)).trim();
const ID = /^[a-z0-9][a-z0-9-]{0,119}$/;

async function loadFile(pool, data) {
  const out = { people: 0, stages: 0, appearances: 0, pairs: 0, skipped: [] };
  const client = await pool.connect();
  try {
    await client.query('begin');
    /* someone who asked to be removed is never added back */
    const removed = new Set((await client.query("select person_id from submissions where status = 'approved' and kind = 'removal' and person_id is not null")).rows.map(r => r.person_id));
    for (const p of data.people || []) {
      if (p && removed.has(p.id)) { out.skipped.push('removed ' + p.id); continue; }
      if (!p || !ID.test(str(p.id)) || !str(p.name)) { out.skipped.push('person ' + JSON.stringify(p && p.id)); continue; }
      const r = await client.query(
        `insert into people (id, name, headline, org, region, segment, source, found_via, added_at)
         values ($1,$2,$3,$4,$5,$6,$7,'hand research',now()) on conflict (id) do nothing`,
        [p.id, str(p.name), str(p.headline), str(p.org), str(p.region) || 'Unknown', SEGMENTS.has(p.segment) ? p.segment : 'Corporate treasury', str(p.source)]);
      out.people += r.rowCount;
    }
    const known = new Set((await client.query('select id from people')).rows.map(r => r.id));
    for (const s of data.stages || []) {
      const url = str(s && s.url), ids = [...new Set((s && s.people) || [])].filter(x => known.has(x));
      if (!/^https?:\/\//.test(url) || /linkedin\.com/i.test(url) || !ids.length) { out.skipped.push('stage ' + url); continue; }
      const kind = KIND_CONF[s.kind] ? s.kind : 'article', label = str(s.label), date = str(s.date);
      const o = await client.query(
        `insert into occasions (url, kind, label, date) values ($1,$2,$3,$4)
         on conflict (url) do update set label = case when occasions.label = '' then excluded.label else occasions.label end,
           date = case when occasions.date = '' then excluded.date else occasions.date end returning id`, [url, kind, label, date]);
      out.stages++;
      for (const id of ids) out.appearances += (await client.query('insert into appearances (occasion_id, person_id) values ($1,$2) on conflict do nothing', [o.rows[0].id, id])).rowCount;
      const ev = { url, label, date, kind };
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const old = (await client.query('select evidence, confidence from co_appearances where a = $1 and b = $2', [a, b])).rows[0];
        if (!old) {
          await client.query('insert into co_appearances (a, b, kind, label, url, confidence, evidence, added_at) values ($1,$2,$3,$4,$5,$6,$7,now())',
            [a, b, kind, label, url, KIND_CONF[kind], JSON.stringify([ev])]);
          out.pairs++;
        } else if (!(old.evidence || []).some(x => x && x.url === url)) {
          await client.query('update co_appearances set evidence = $3, confidence = greatest(confidence, $4), updated_at = now() where a = $1 and b = $2',
            [a, b, JSON.stringify((old.evidence || []).concat([ev])), KIND_CONF[kind]]);
          out.pairs++;
        }
      }
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  return out;
}

/* data/people-updates.json: the newest dated title seen for each person, from every hand-researched page.
 * Applied on every deploy; it only ever moves a title forward in time, and never touches a title a reviewer locked. */
async function applyTitleUpdates(pool, file) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const u of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (!ID.test(str(u.id)) || !str(u.headline) || !/^\d{4}(-\d{2}){0,2}$/.test(str(u.date))) continue;
    if (u.confirm_only) {   /* same organisation: the title stands, now dated */
      n += (await pool.query(`update people set headline_date = $2, headline_source = $3 where id = $1 and not headline_locked and $2 >= '2025' and headline_date < $2`, [u.id, str(u.date), str(u.source)])).rowCount;
      continue;
    }
    const r = await pool.query(
      `update people set headline = $2, org = case when $3 = '' then org else $3 end, headline_date = $4, headline_source = $5, updated_at = now()
        where id = $1 and not headline_locked and $4 >= '2025' and headline_date < $4 and (headline is distinct from $2 or headline_date = '')`,
      [u.id, str(u.headline), str(u.org), str(u.date), str(u.source)]);
    n += r.rowCount;
  }
  return n;
}

async function seedPeople(pool, dir = path.join(__dirname, '..', 'data')) {
  if (process.env.PEOPLE_SEED === 'off') return {};   /* the tests compare the store with the dump alone */
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^people-seed.*\.json$/.test(f)).sort() : [];
  const done = new Set((await pool.query('select file from people_seed_files')).rows.map(r => r.file));
  const all = {};
  for (const f of files) {
    if (done.has(f)) continue;
    const r = await loadFile(pool, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    await pool.query('insert into people_seed_files (file, rows) values ($1,$2) on conflict do nothing', [f, r.stages]);
    all[f] = r;
  }
  const t = await applyTitleUpdates(pool, path.join(dir, 'people-updates.json'));
  if (t) all['titles moved forward'] = t;
  return all;
}

if (require.main === module) {
  const pool = require('./db').makePool();
  seedPeople(pool).then(async r => { console.log('people seed:', JSON.stringify(r)); await pool.end(); }).catch(async e => { console.error(e); await pool.end(); process.exit(1); });
}
module.exports = { seedPeople, loadFile, applyTitleUpdates };
