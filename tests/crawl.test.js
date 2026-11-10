'use strict';
/* D3: the Render crawler against a local stand-in for the Messages API that plays back web fetch results,
 * so the rules enforced in code are tested without a key or any spend. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makePool } = require('../scripts/db');
const { crawl, config } = require('../scripts/crawl');

const A = 'https://events.example.org/2026/treasury-forum/session-12';
const B = 'https://blocked.example.org/agenda';
let mock, pool, calls = [], script = null;

const fetchBlocks = (id, url, ok) => [
  { type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
  { type: 'web_fetch_tool_result', tool_use_id: id, content: ok
    ? { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Session 12 ...' }, title: 'Session 12' }, retrieved_at: '2026-11-10T10:00:00Z' }
    : { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } }];
const usage = { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } };

test.before(async () => {
  await require('./setup').ready({ reset: true });
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      calls.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(script(body, calls.length)));
    });
  });
  await new Promise(r => mock.listen(0, r));
  pool = makePool();
});
test.after(async () => { mock.close(); await pool.end(); });

const cfg = extra => Object.assign(config({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + mock.address().port, CRAWL_TARGETS: '1' }), extra || {});
async function only(id) {
  await pool.query("update people set deepened_at = now(), parked = false, empty_runs = 0; update leads set status = 'pending' where status = 'queued'; delete from runs where data->>'mode' = 'render'");
  await pool.query('update people set deepened_at = null where id = $1', [id]);
}
/* turn 1: the model fetches A (ok) and B (fails) and the turn pauses; turn 2: it submits */
const twoTurns = findings => (body) => {
  const last = body.messages[body.messages.length - 1];
  if (last.role === 'user' && body.messages.length === 1) return { stop_reason: 'pause_turn', usage, content: [{ type: 'text', text: 'Reading.' }, ...fetchBlocks('srv1', A, true), ...fetchBlocks('srv2', B, false)] };
  return { stop_reason: 'tool_use', usage, content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'tu_sub', name: 'submit_findings', input: findings }] };
};

test('a deepen run keeps only facts from fetched pages, links people of the same session, adds a newcomer and records the run', async () => {
  await only('ernie-humphrey');
  await pool.query("delete from person_topics where person_id = 'ernie-humphrey' and topic in ('Commodities', 'Fraud')");
  await pool.query("delete from person_topics where person_id = 'ernie-humphrey' and topic = (select topic from person_topics where person_id = 'ernie-humphrey' order by topic limit 1) and (select count(*) from person_topics where person_id = 'ernie-humphrey') >= 6");
  const before = (await pool.query("select evidence from co_appearances where a = 'craig-jeffery' and b = 'ernie-humphrey'")).rows[0];
  calls = [];
  script = twoTurns({
    notes: 'Spoke at the 2026 Treasury Forum, session 12. Try the 2025 programme next.',
    updates: [{ field: 'headline', value: 'Treasurer, Example Corp', url: A }, { field: 'org', value: 'Other Corp', url: 'https://not-fetched.example.org/x' }],
    topics: [{ topic: 'Commodities', url: A }, { topic: 'Bananas', url: A }, { topic: 'Fraud', url: A }],
    systems: [{ name: 'Kyriba', role: 'uses', url: A, date: '2026' }],
    roles: [{ title: 'Treasurer', org: 'Example Corp', from: '2024', url: A }],
    links: [
      { name: 'Craig Jeffery', kind: 'panel', label: 'Treasury Forum 2026, session 12', url: A, date: '2026-05', same_session: true },
      { name: 'Jane Newcomer', kind: 'panel', label: 'Treasury Forum 2026, session 12', url: A, same_session: true },
      { name: 'Keynote Person', kind: 'panel', label: 'Treasury Forum 2026', url: A, same_session: false },
      { name: 'Craig Jeffery', kind: 'podcast', label: 'Profile', url: 'https://www.linkedin.com/in/someone', same_session: true }],
    new_people: [{ name: 'Jane Newcomer', headline: 'Head of Treasury, Newco', org: 'Newco', region: 'France', segment: 'Corporate treasury', url: A }],
    leads: [{ url: 'https://events.example.org/2025/treasury-forum', snippet: 'previous year' }]
  });
  const r = await crawl(pool, cfg());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.deepened, ['ernie-humphrey']);
  assert.equal(calls.length, 2, 'pause_turn was continued, then the findings ended the loop');
  /* request shape */
  const b0 = calls[0].body;
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(b0.model, 'claude-sonnet-5-5');
  assert.deepEqual(b0.tools.map(t => t.type || t.name), ['web_search_20250305', 'web_fetch_20250910', 'submit_findings']);
  for (const t of b0.tools.slice(0, 2)) assert.ok(t.blocked_domains.includes('linkedin.com') && t.max_uses > 0);
  assert.match(b0.messages[0].content[0].text, /Ernie Humphrey \(map id ernie-humphrey\)/);
  assert.equal(calls[1].body.messages[1].role, 'assistant', 'paused turn sent back as is');
  /* what was kept */
  const p = (await pool.query("select * from people where id = 'ernie-humphrey'")).rows[0];
  assert.equal(p.headline, 'Treasurer, Example Corp');
  assert.notEqual(p.org, 'Other Corp', 'a fact from a page not fetched is discarded');
  assert.ok(p.publisher_domains.includes('events.example.org'));
  assert.match(p.insight_notes, /2025 programme/);
  assert.ok(p.deepened_at && p.deepen_attempts >= 1);
  assert.equal((await pool.query("select 1 from person_topics where person_id = 'ernie-humphrey' and topic = 'Bananas'")).rows.length, 0);
  assert.equal((await pool.query("select count(*)::int n from person_topics where person_id = 'ernie-humphrey'")).rows[0].n, 6, 'six topics at most');
  assert.ok(r.rejections.some(x => /Fraud \(already 6 topics\)/.test(x)));
  assert.equal((await pool.query("select 1 from person_topics where person_id = 'ernie-humphrey' and topic = 'Commodities' and url = $1", [A])).rows.length, 1);
  assert.equal((await pool.query("select 1 from person_systems where person_id = 'ernie-humphrey' and system = 'Kyriba' and role = 'uses'")).rows.length, 1);
  const after = (await pool.query("select evidence from co_appearances where a = 'craig-jeffery' and b = 'ernie-humphrey'")).rows[0];
  assert.equal(after.evidence.length, before.evidence.length + 1, 'one link per pair, evidence added to it');
  const jane = (await pool.query("select * from people where id = 'jane-newcomer'")).rows[0];
  assert.ok(jane && jane.region === 'France' && jane.found_via === 'ernie-humphrey');
  assert.equal((await pool.query("select 1 from co_appearances where a = 'ernie-humphrey' and b = 'jane-newcomer'")).rows.length, 1);
  assert.equal((await pool.query("select 1 from people where name = 'Keynote Person'")).rows.length, 0, 'not in the same session: no link, no card');
  /* leads: the failed fetch and the one left for later */
  const leads = (await pool.query("select url, reason from leads where person_id = 'ernie-humphrey' and added_at > now() - interval '1 minute'")).rows;
  assert.ok(leads.some(l => l.url === B && /url_not_accessible/.test(l.reason)));
  assert.ok(leads.some(l => l.url === 'https://events.example.org/2025/treasury-forum'));
  /* the run record */
  const run = (await pool.query('select data from runs where id = $1', [r.id])).rows[0].data;
  assert.equal(run.mode, 'render');
  assert.equal(run.peopleAdded, 1);
  assert.equal(run.edgesAdded, 1);
  assert.equal(run.evidenceAdded, 1);
  assert.ok(run.rejected >= 4);
  assert.ok(run.costUsd > 0);
  assert.ok(run.rejections.some(x => /not fetched/.test(x)));
});

test("the owner's card is never edited by the crawler; additions with a source are kept", async () => {
  await only('vincent-donnat');
  const before = (await pool.query("select headline, org from people where id = 'vincent-donnat'")).rows[0];
  script = twoTurns({ notes: 'x', updates: [{ field: 'headline', value: 'Something else', url: A }], systems: [{ name: 'Nomentia', role: 'evaluated', url: A }] });
  const r = await crawl(pool, cfg());
  assert.deepEqual(r.deepened, ['vincent-donnat']);
  const p = (await pool.query("select headline, org from people where id = 'vincent-donnat'")).rows[0];
  assert.deepEqual(p, before);
  assert.equal((await pool.query("select 1 from person_systems where person_id = 'vincent-donnat' and system = 'Nomentia' and role = 'evaluated'")).rows.length, 1);
});

test('an approved link is read first and closed; a card that gives nothing twice is parked', async () => {
  await only('craig-jeffery');
  await pool.query("insert into leads (id, url, reason, person_id, snippet, status, added_at) values ('sub-test', $1, 'submitted by a visitor, approved', 'adam-larson', 'panel', 'queued', now()) on conflict (id) do update set status = 'queued'", [A]);
  script = twoTurns({ notes: 'nothing new' });
  let r = await crawl(pool, cfg());
  assert.deepEqual(r.leadsRead, ['sub-test'], 'the queued lead goes before any card');
  assert.equal((await pool.query("select status from leads where id = 'sub-test'")).rows[0].status, 'done');
  await pool.query("update people set deepened_at = now(); update people set deepened_at = null where id = 'craig-jeffery'");
  r = await crawl(pool, cfg());
  assert.deepEqual(r.deepened, ['craig-jeffery']);
  let p = (await pool.query("select parked, empty_runs from people where id = 'craig-jeffery'")).rows[0];
  assert.deepEqual(p, { parked: false, empty_runs: 1 });
  await pool.query("update people set deepened_at = null where id = 'craig-jeffery'");
  await crawl(pool, cfg());
  p = (await pool.query("select parked, parked_reason from people where id = 'craig-jeffery'")).rows[0];
  assert.equal(p.parked, true);
  assert.match(p.parked_reason, /two deepen runs/);
});

test('the daily spend cap stops the crawler before any call, and the run says so', async () => {
  await only('adam-larson');
  await pool.query(`insert into runs (id, data, started_at) values ('spent-today', '{"mode":"render","costUsd":5}', now())`);
  calls = [];
  const r = await crawl(pool, cfg({ dailyUsd: 4 }));
  assert.equal(calls.length, 0);
  assert.match(r.notes, /Daily spend cap reached/);
  assert.ok((await pool.query('select 1 from runs where id = $1', [r.id])).rows.length);
  const d = await crawl(pool, cfg({ apiKey: '' }), { dryRun: true });
  assert.ok(d.dryRun && d.spentToday >= 5);
});

test('an API error is recorded and stops the run without touching the card', async () => {
  await pool.query("delete from runs where id = 'spent-today'");
  await only('adam-larson');
  const before = (await pool.query("select deepen_attempts from people where id = 'adam-larson'")).rows[0];
  script = () => ({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  const srv = mock; const orig = srv.listeners('request')[0];
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => { req.resume(); req.on('end', () => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(script())); }); });
  const r = await crawl(pool, cfg());
  srv.removeAllListeners('request'); srv.on('request', orig);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /API 401: invalid x-api-key/);
  assert.equal((await pool.query("select deepen_attempts from people where id = 'adam-larson'")).rows[0].deepen_attempts, before.deepen_attempts);
});

test('the review page lists the crawler runs with what they kept and discarded', async () => {
  process.env.ADMIN_TOKEN = 'crawl-test';
  delete require.cache[require.resolve('../server')];
  const s = require('../server');
  const server = await new Promise(r => { const x = s.app.listen(0, () => r(x)); });
  await pool.query(`insert into runs (id, data, started_at) values ('review-view', '{"mode":"render","deepened":["ernie-humphrey"],"factsAdded":3,"costUsd":0.31}', now()) on conflict (id) do nothing`);
  try {
    const q = await fetch('http://127.0.0.1:' + server.address().port + '/api/admin/queue', { headers: { 'x-admin-token': 'crawl-test' } }).then(r => r.json());
    assert.ok(q.runs.length >= 2, 'the error run and this one');
    assert.ok(q.runs.some(r => (r.data.errors || []).length), 'errors are shown');
    const withWork = q.runs.find(r => (r.data.deepened || []).includes('ernie-humphrey'));
    assert.equal(withWork.names['ernie-humphrey'], 'Ernie Humphrey');
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'review.html'), 'utf8');
    assert.ok(html.includes("['run','Crawler']") && html.includes('function runItem'));
  } finally { server.close(); await s.pool.end(); }
});
