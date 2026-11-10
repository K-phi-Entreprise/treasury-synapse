'use strict';
/* Request help: a private request (never on the map) from someone choosing or running a treasury or finance system.
 * The owner sees it on /review with suggested people: consultants available for projects on those systems, and users
 * open to a reference call. Introductions are made by email to both sides, and only to claimed cards (they have an address).
 * Vendors are suggested only if the requester ticked that box. Eight weeks later the requester is asked what they chose and why. */
const crypto = require('crypto');

const KINDS = { selection: 'Choosing a system', forecasting: 'A cash forecasting project', implementation: 'Help with an implementation', reference: 'A reference call with a user', other: 'Something else' };
const SIZES = ['<50', '50-250', '250-1000', '1000-5000', '5000+'];
const TIMING = { now: 'Now', '3m': 'Within 3 months', '6m': 'Within 6 months', later: 'Later or not sure' };
const FOLLOW_DAYS = 56;
const clip = (v, n) => String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, n);

function clean(b, { topics, regions }) {
  const kind = String(b.kind || '');
  if (!KINDS[kind]) return { error: 'what kind of help is it?' };
  const out = {
    kind, name: clip(b.name, 120), role: clip(b.role, 120), company: clip(b.company, 120),
    region: regions.includes(b.region) ? b.region : '', size: SIZES.includes(b.size) ? b.size : '', erp: clip(b.erp, 80),
    systems: [...new Set((Array.isArray(b.systems) ? b.systems : String(b.systems || '').split(',')).map(s => clip(s, 60)).filter(Boolean))].slice(0, 10),
    topics: [...new Set((Array.isArray(b.topics) ? b.topics : []).filter(t => topics.includes(t)))],
    timing: TIMING[b.timing] ? b.timing : '', details: String(b.details || '').trim().slice(0, 1500),
    targetId: String(b.targetId || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120) || null,
    viaIds: [...new Set((Array.isArray(b.viaIds) ? b.viaIds : []).map(v => String(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120)).filter(Boolean))].slice(0, 5),
    routing: { consultants: b.routing ? !!b.routing.consultants : true, references: b.routing ? !!b.routing.references : true, vendors: !!(b.routing && b.routing.vendors) }
  };
  if (!out.details && !out.systems.length && !out.topics.length) return { error: 'tell us a little about what you need' };
  return out;
}

function mount(app, { pool, mail, ipHash, underQuota, publicUrl, emailRe, admin, topics, regions }) {
  const lc = s => String(s || '').toLowerCase().trim();

  app.post('/api/requests', async (req, res, next) => {
    try {
      const email = clip(String(req.body.email || '').replace(/\s+/g, ''), 200).toLowerCase();
      if (!emailRe.test(email)) return res.status(400).json({ error: 'an email is needed so we can answer you' });
      const c = clean(req.body || {}, { topics, regions });
      if (c.error) return res.status(400).json({ error: c.error });
      if (!(await underQuota(req, 'request'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
      const token = crypto.randomBytes(18).toString('base64url'), outcome = crypto.randomBytes(18).toString('base64url');
      if (c.targetId && !(await pool.query('select 1 from people where id = $1', [c.targetId])).rows.length) c.targetId = null;
      if (c.viaIds.length) c.viaIds = (await pool.query('select id from people where id = any($1)', [c.viaIds])).rows.map(x => x.id);
      const r = await pool.query(`insert into requests (kind, email, name, role, company, region, size, erp, systems, topics, timing, details, routing, ip_hash, confirm_token, outcome_token, target_id, via_ids)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
        [c.kind, email, c.name, c.role, c.company, c.region, c.size, c.erp, c.systems, c.topics, c.timing, c.details, JSON.stringify(c.routing), ipHash(req), token, outcome, c.targetId, c.viaIds]);
      const sent = await mail.send({ to: email, subject: 'Treasury Synapse: please confirm your request',
        text: 'Hello' + (c.name ? ' ' + c.name : '') + ',\n\nThanks for asking: ' + KINDS[c.kind].toLowerCase() + (c.systems.length ? ' (' + c.systems.join(', ') + ')' : '') + '.\n\nConfirm it here so we can get to work:\n' + publicUrl + '/api/requests/confirm/' + token +
          '\n\nYour request stays private: it is never shown on the map, and nobody is introduced to you without your contact details being shared on purpose, by email, to both sides.\n\nTreasury Synapse, by K-phi\n' });
      res.json({ id: r.rows[0].id, status: 'received', mail: sent.sent ? 'sent' : 'not sent' });
    } catch (e) { next(e); }
  });

  app.get('/api/requests/confirm/:token', async (req, res, next) => {
    try {
      const r = await pool.query("update requests set confirmed_at = coalesce(confirmed_at, now()) where confirm_token = $1 returning id", [String(req.params.token).slice(0, 64)]);
      res.set('X-Robots-Tag', 'noindex').type('html').send(page(r.rows.length ? 'Request confirmed' : 'Link not recognised',
        r.rows.length ? '<p>Thank you. We read every request and come back to you by email, usually within two working days.</p>' : '<p>This link is not valid.</p>'));
    } catch (e) { next(e); }
  });

  /* who could help: consultants available for projects, users open to a reference call, vendors only if asked.
     Public evidence counts first (pages that say they implement or use it), then what the person declared. */
  async function suggest(rq) {
    const sys = rq.systems.map(lc), want = new Set(sys);
    const ev = sys.length ? (await pool.query(`select s.person_id, s.system, s.role, count(*)::int n from person_systems s join people p on p.id = s.person_id and not p.hidden
        where lower(s.system) = any($1) group by 1,2,3`, [sys])).rows : [];
    const dec = (await pool.query(`select d.*, c.email from declarations d join claims c on c.person_id = d.person_id and c.confirmed_at is not null where d.removed_at is null and d.kind = 'system'`)).rows;
    const prof = (await pool.query(`select pp.*, c.email from person_profile pp join claims c on c.person_id = pp.person_id and c.confirmed_at is not null`)).rows;
    const people = new Map();
    const get = id => people.get(id) || people.set(id, { id, evidence: [], declared: [], forHire: false, referenceOn: [], regions: [], claimed: false, sells: [] }).get(id);
    ev.forEach(e => { const p = get(e.person_id); if (e.role === 'sells') p.sells.push(e.system); else p.evidence.push(e.role + ' ' + e.system + (e.n > 1 ? ' (' + e.n + ' sources)' : '')); });
    dec.forEach(d => {
      const p = get(d.person_id); p.claimed = true;
      const match = want.has(lc(d.system)) || (!sys.length && d.topics.some(t => rq.topics.includes(t)));
      if (!match) return;
      if (d.role === 'sells') p.sells.push(d.system);
      else { p.declared.push(d.role + ' ' + d.system + (d.topics.length ? ': ' + d.topics.join(', ') : '')); if (d.reference_ok) p.referenceOn.push(d.system); }
    });
    prof.forEach(x => { const p = people.get(x.person_id); if (p) { p.claimed = true; p.forHire = x.for_hire; p.regions = x.regions; } });
    const ids = [...people.keys()];
    const names = ids.length ? (await pool.query('select id, name, headline, org, region from people where id = any($1)', [ids])).rows : [];
    const info = new Map(names.map(n => [n.id, n]));
    const claimedIds = new Set((await pool.query('select person_id from claims where confirmed_at is not null and person_id = any($1)', [ids])).rows.map(r => r.person_id));
    const rows = [...people.values()].filter(p => info.has(p.id)).map(p => Object.assign(p, info.get(p.id), { claimed: claimedIds.has(p.id), regionMatch: !!rq.region && (p.regions.includes(rq.region) || (info.get(p.id) || {}).region === rq.region) }));
    const score = p => p.evidence.length * 3 + p.declared.length * 2 + (p.regionMatch ? 2 : 0) + (p.claimed ? 1 : 0);
    const consultants = rq.routing.consultants ? rows.filter(p => p.forHire && (p.evidence.length || p.declared.length) && !p.sells.length).sort((a, b) => score(b) - score(a)).slice(0, 8) : [];
    const references = rq.routing.references ? rows.filter(p => p.referenceOn.length && !p.sells.length).sort((a, b) => score(b) - score(a)).slice(0, 8) : [];
    const vendors = rq.routing.vendors ? rows.filter(p => p.sells.length).sort((a, b) => score(b) - score(a)).slice(0, 6) : [];
    return { consultants, references, vendors };
  }

  app.get('/api/admin/requests', admin, async (req, res, next) => {
    try {
      const r = await pool.query("select * from requests where status not in ('closed','spam') order by added_at desc limit 100");
      const intro = await pool.query('select i.*, p.name from introductions i join people p on p.id = i.person_id where i.request_id = any($1)', [r.rows.map(x => x.id)]);
      const out = [];
      const named = [...new Set(r.rows.flatMap(x => [x.target_id].concat(x.via_ids || [])).filter(Boolean))];
      const who = named.length ? Object.fromEntries((await pool.query('select p.id, p.name, p.headline, (c.confirmed_at is not null) claimed from people p left join claims c on c.person_id = p.id where p.id = any($1)', [named])).rows.map(x => [x.id, x])) : {};
      for (const rq of r.rows) out.push(Object.assign({}, rq, { confirm_token: undefined, outcome_token: undefined, kindLabel: KINDS[rq.kind], suggestions: await suggest(rq), introductions: intro.rows.filter(i => i.request_id === rq.id),
        target: rq.target_id ? who[rq.target_id] || null : null, via: (rq.via_ids || []).map(id => who[id]).filter(Boolean) }));
      const outcomes = (await pool.query("select id, kind, systems, outcome, outcome_at from requests where outcome is not null order by outcome_at desc limit 50")).rows;
      res.json({ requests: out, outcomes });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/requests/:id', admin, async (req, res, next) => {
    try {
      const status = String(req.body.status || '');
      if (!['new', 'in_progress', 'introduced', 'closed', 'spam'].includes(status)) return res.status(400).json({ error: 'bad status' });
      const r = await pool.query('update requests set status = $2, owner_note = $3 where id = $1 returning id', [Number(req.params.id), status, clip(req.body.note, 1000)]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* an introduction: one email to each side, each with the other's address. Only claimed cards have an address. */
  app.post('/api/admin/requests/:id/introduce', admin, async (req, res, next) => {
    try {
      const rq = (await pool.query('select * from requests where id = $1', [Number(req.params.id)])).rows[0];
      if (!rq) return res.status(404).json({ error: 'not found' });
      const personId = String(req.body.personId || '').slice(0, 120);
      const p = (await pool.query('select p.id, p.name, p.headline, c.email from people p join claims c on c.person_id = p.id and c.confirmed_at is not null where p.id = $1', [personId])).rows[0];
      if (!p) return res.status(400).json({ error: 'only people who claimed their card can be introduced (we need their address)' });
      const note = clip(req.body.note, 800);
      const who = (rq.name || 'Someone') + (rq.role ? ', ' + rq.role : '') + (rq.company ? ' at ' + rq.company : '');
      const what = KINDS[rq.kind] + (rq.systems.length ? ' (' + rq.systems.join(', ') + ')' : '') + (rq.topics.length ? ', on ' + rq.topics.join(', ') : '');
      const a = await mail.send({ to: rq.email, subject: 'Treasury Synapse: an introduction to ' + p.name,
        text: 'Hello' + (rq.name ? ' ' + rq.name : '') + ',\n\nAbout your request (' + what + '), you may want to talk to ' + p.name + (p.headline ? ', ' + p.headline : '') + '.\n\n' + (note ? note + '\n\n' : '') +
          'Their address: ' + p.email + '\nThey have your address too and know what you are looking for.\n\nTreasury Synapse, by K-phi\n' });
      const b = await mail.send({ to: p.email, subject: 'Treasury Synapse: someone would like to talk to you',
        text: 'Hello ' + p.name.split(' ')[0] + ',\n\n' + who + ' is looking for: ' + what + '.' + (rq.details ? '\n\nIn their words:\n' + rq.details : '') + '\n\n' + (note ? note + '\n\n' : '') +
          'Their address: ' + rq.email + '\nYou are receiving this because your card says you are open to it. You can change that on your card at any time.\n\nTreasury Synapse, by K-phi\n' });
      await pool.query("insert into introductions (request_id, person_id) values ($1,$2) on conflict do nothing", [rq.id, p.id]);
      await pool.query("update requests set status = 'introduced' where id = $1 and status in ('new','in_progress')", [rq.id]);
      res.json({ ok: true, mailed: a.sent && b.sent });
    } catch (e) { next(e); }
  });

  /* eight weeks later: what did you choose, and why? */
  app.get('/outcome/:token', async (req, res, next) => {
    try {
      const rq = (await pool.query('select id, systems, outcome from requests where outcome_token = $1', [String(req.params.token).slice(0, 64)])).rows[0];
      if (!rq) return res.status(404).type('html').send(page('Link not recognised', '<p>This link is not valid.</p>'));
      res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }).type('html').send(page('What did you choose?', rq.outcome ? '<p>Thank you, we have your answer.</p>' :
        '<form method="post" style="display:grid;gap:12px">' +
        '<label>Where did you land?<br><select name="result" style="' + FIELD + '"><option value="chose">We chose a system</option><option value="kept">We kept what we had</option><option value="paused">We paused or stopped</option><option value="ongoing">Still deciding</option></select></label>' +
        '<label>Which system, if any?<br><input name="chosen" maxlength="80" style="' + FIELD + '" value=""></label>' +
        '<label>Which others did you seriously consider?<br><input name="considered" maxlength="200" style="' + FIELD + '" value="' + esc(rq.systems.join(', ')) + '"></label>' +
        '<label>What decided it?<br><textarea name="why" maxlength="1500" rows="5" style="' + FIELD + '"></textarea></label>' +
        '<label>Did the introductions help?<br><select name="helped" style="' + FIELD + '"><option value="">No introduction</option><option value="yes">Yes</option><option value="somewhat">Somewhat</option><option value="no">No</option></select></label>' +
        '<button style="padding:12px;border:0;border-radius:10px;background:#6ee7f0;color:#05101a;font:600 15px system-ui;cursor:pointer">Send</button>' +
        '<p style="color:#8b93b8;font-size:13px">Only K-phi reads this. It is never published with your name.</p></form>'));
    } catch (e) { next(e); }
  });
  app.post('/outcome/:token', require('express').urlencoded({ extended: false, limit: '16kb' }), async (req, res, next) => {
    try {
      const b = req.body || {};
      const o = { result: ['chose', 'kept', 'paused', 'ongoing'].includes(b.result) ? b.result : '', chosen: clip(b.chosen, 80), considered: clip(b.considered, 200), why: String(b.why || '').trim().slice(0, 1500), helped: ['yes', 'somewhat', 'no'].includes(b.helped) ? b.helped : '' };
      const r = await pool.query('update requests set outcome = $2, outcome_at = now() where outcome_token = $1 and outcome is null returning id', [String(req.params.token).slice(0, 64), JSON.stringify(o)]);
      res.type('html').send(page(r.rows.length ? 'Thank you' : 'Already answered', '<p>' + (r.rows.length ? 'That helps us understand how these choices are really made.' : 'We already have your answer.') + '</p>'));
    } catch (e) { next(e); }
  });

  /* called by the daily digest: send the eight-week follow-ups that are due */
  async function sendFollowUps() {
    const due = (await pool.query(`select * from requests where confirmed_at is not null and followup_sent_at is null and outcome is null and status <> 'spam'
      and added_at < now() - ($1 || ' days')::interval`, [String(FOLLOW_DAYS)])).rows;
    let n = 0;
    for (const rq of due) {
      const m = await mail.send({ to: rq.email, subject: 'Treasury Synapse: how did it go?',
        text: 'Hello' + (rq.name ? ' ' + rq.name : '') + ',\n\nTwo months ago you asked for help: ' + KINDS[rq.kind].toLowerCase() + (rq.systems.length ? ' (' + rq.systems.join(', ') + ')' : '') + '.\n\nWhat did you choose, and why? Five questions, one minute:\n' + publicUrl + '/outcome/' + rq.outcome_token +
          '\n\nOnly K-phi reads your answer; it is never published with your name.\n\nTreasury Synapse, by K-phi\n' });
      if (m.sent) { await pool.query('update requests set followup_sent_at = now() where id = $1', [rq.id]); n++; }
    }
    return n;
  }
  return { suggest, sendFollowUps };
}

const FIELD = 'width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border-radius:9px;border:1px solid #2a3158;background:#0e1328;color:#e8ecff;font:15px system-ui';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, body) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Treasury Synapse</title>' +
  '<body style="background:#080b17;color:#e8ecff;font:16px system-ui;padding:40px 20px;max-width:560px;margin:auto"><h1 style="font-size:22px">' + title + '</h1>' + body + '<p><a style="color:#6ee7f0" href="/">Back to the map</a></p>';

module.exports = { mount, clean, KINDS, SIZES, TIMING, FOLLOW_DAYS };
