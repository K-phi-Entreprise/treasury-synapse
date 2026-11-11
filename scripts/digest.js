'use strict';
/* Daily digest to the owner: what waits in the review queue and what the crawler did in the last 24 hours.
 * Render cron job; prints the digest when mail is not configured. */
const { makePool } = require('./db');
const mail = require('../mail');

async function digest(pool) {
  const q = await pool.query(`select
    (select count(*)::int from submissions where status = 'pending' and kind = 'removal') removals,
    (select count(*)::int from submissions where status = 'pending' and kind = 'correction') corrections,
    (select count(*)::int from submissions where status = 'pending' and kind = 'link') links,
    (select count(*)::int from submissions where status = 'discuss') discuss,
    (select count(*)::int from connections where status = 'pending') connections,
    (select count(*)::int from leads where status = 'pending') leads,
    (select count(*)::int from people where added_at > now() - interval '1 day') new_people,
    (select count(*)::int from co_appearances where added_at > now() - interval '1 day') new_links,
    (select count(*)::int from people where deepened_at > now() - interval '1 day') deepened,
    (select count(*)::int from people where not hidden) people,
    (select count(*)::int from requests where status in ('new','in_progress') and confirmed_at is not null) requests,
    (select count(*)::int from submissions where status = 'pending' and kind = 'claim') claims,
    (select count(*)::int from runs where data->>'mode' = 'render' and started_at > now() - interval '1 day') crawl_runs,
    (select coalesce(sum((data->>'costUsd')::numeric), 0)::float from runs where data->>'mode' = 'render' and started_at > now() - interval '1 day') crawl_usd,
    (select count(*)::int from runs where data->>'mode' = 'render' and started_at > now() - interval '1 day' and jsonb_array_length(coalesce(data->'errors', '[]')) > 0) crawl_errors`);
  const r = q.rows[0];
  const waiting = r.removals + r.corrections + r.links + r.discuss + r.connections + r.leads + r.requests + r.claims;
  const base = (process.env.PUBLIC_URL || 'https://synapse.k-phi.com').replace(/\/$/, '');
  const lines = [
    'Waiting for you: ' + (waiting ? waiting : 'nothing'),
    r.requests ? '  ' + r.requests + ' request(s) for help to answer' : '',
    r.claims ? '  ' + r.claims + ' card claim(s) to check' : '',
    r.removals ? '  ' + r.removals + ' removal request(s), cards hidden until you decide' : '',
    r.corrections ? '  ' + r.corrections + ' correction(s)' : '',
    r.links ? '  ' + r.links + ' public link(s)' : '',
    r.connections ? '  ' + r.connections + ' declared connection(s)' : '',
    r.discuss ? '  ' + r.discuss + ' in discussion' : '',
    r.leads ? '  ' + r.leads + ' page(s) the crawler could not read' : '',
    '',
    'Last 24 hours: ' + r.deepened + ' people deepened, ' + r.new_people + ' added, ' + r.new_links + ' new links. ' + r.people + ' people on the map.',
    'Crawler: ' + r.crawl_runs + ' run(s), about ' + r.crawl_usd.toFixed(2) + ' USD' + (r.crawl_errors ? ', ' + r.crawl_errors + ' with errors' : '') + '.',
    '',
    'Review: ' + base + '/review'
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0));
  return { counts: r, waiting, subject: 'Treasury & FP&A Synapses: ' + (waiting ? waiting + ' waiting for review' : 'nothing to review'), text: lines.join('\n') + '\n' };
}

if (require.main === module) {
  const pool = makePool();
  digest(pool).then(async d => {
    /* the eight-week "what did you choose, and why?" emails go out with the digest */
    try { const n = await require('../requests').mount(require('express')(), { pool, mail, ipHash: () => '', underQuota: async () => true, publicUrl: (process.env.PUBLIC_URL || 'https://synapse.k-phi.com').replace(/\/$/, ''), emailRe: /./, admin: (q, s, n) => n(), topics: [], regions: [] }).sendFollowUps(); if (n) console.log('follow-ups sent:', n); } catch (e) { console.error('follow-ups failed', e.message); }
    console.log(d.text);
    if (process.env.OWNER_EMAIL) console.log(JSON.stringify(await mail.send({ to: process.env.OWNER_EMAIL, subject: d.subject, text: d.text })));
    await pool.end();
  }).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { digest };
