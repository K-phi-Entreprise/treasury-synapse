'use strict';
/* D3: visitor submissions, email confirmation, the review actions and the digest.
 * Mail goes to a local stand-in for the Resend API (RESEND_BASE_URL). Needs the store loaded (store.test.js runs first). */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mailbox = [], mailSrv, server, base, pool;
const TOKEN = 'review-test-token';

test.before(async () => {
  await require('./setup').ready({ reset: true });
  mailSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { mailbox.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end('{"id":"m1"}'); });
  });
  await new Promise(r => mailSrv.listen(0, r));
  Object.assign(process.env, { RESEND_BASE_URL: 'http://127.0.0.1:' + mailSrv.address().port, RESEND_API_KEY: 're_test', MAIL_FROM: 'Synapse <synapse@k-phi.com>', ADMIN_TOKEN: TOKEN, PUBLIC_URL: 'https://synapse.example' });
  delete require.cache[require.resolve('../server')];
  const s = require('../server');
  pool = s.pool;
  await pool.query("delete from quotas; delete from submissions;");
  await new Promise(r => { server = s.app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); mailSrv.close(); await pool.end(); });

const send = (body) => fetch(base + '/api/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const adminPost = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const queue = () => fetch(base + '/api/admin/queue', { headers: { 'x-admin-token': TOKEN } }).then(r => r.json());
const person = id => pool.query('select * from people where id = $1', [id]).then(r => r.rows[0]);

test('bad submissions are refused with a reason a visitor understands', async () => {
  const cases = [
    [{ kind: 'correction', personId: 'craig-jeffery', payload: { field: 'headline', value: '' } }, /missing/],
    [{ kind: 'correction', personId: 'craig-jeffery', payload: { field: 'region', value: 'Mars' } }, /missing/],
    [{ kind: 'link', personId: 'craig-jeffery', payload: { url: 'not a url' } }, /web address/],
    [{ kind: 'link', personId: 'craig-jeffery', payload: { url: 'https://www.linkedin.com/in/someone' } }, /LinkedIn/],
    [{ kind: 'removal', personId: 'craig-jeffery', payload: {} }, /email is needed/],
    [{ kind: 'correction', personId: 'craig-jeffery', payload: { field: 'org', value: 'X' }, email: 'nope' }, /email/],
    [{ kind: 'correction', personId: 'nobody-at-all', payload: { field: 'org', value: 'X' } }, /unknown person/]
  ];
  for (const [body, re] of cases) {
    const r = await send(body);
    assert.ok(r.status >= 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.equal(mailbox.length, 0);
});

test('a correction waits for review, the email is confirmed by link, approval applies the reviewed value and tells the sender', async () => {
  const before = await person('craig-jeffery');
  const r = await send({ kind: 'correction', personId: 'craig-jeffery', payload: { field: 'headline', value: 'Founder & Managing Partner, Strategic Treasurer', note: 'from the 2026 bio' }, email: 'reader@example.org' });
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.confirmation, 'sent');
  assert.equal((await person('craig-jeffery')).headline, before.headline, 'nothing changes before review');
  const m = mailbox.shift();
  assert.equal(m.auth, 'Bearer re_test');
  assert.deepEqual(m.body.to, ['reader@example.org']);
  const link = m.body.text.match(/https:\/\/synapse\.example(\/api\/confirm\/\S+)/)[1];
  const page = await fetch(base + link).then(r => r.text());
  assert.match(page, /Request confirmed/);
  let q = await queue();
  const item = q.submissions.find(s => s.id === r.body.id);
  assert.ok(item.confirmed_at, 'confirmed');
  assert.equal(item.person_headline, before.headline, 'review page sees the current value');
  const a = await adminPost('/api/admin/submissions/' + r.body.id, { status: 'approved', value: 'Managing Partner, Strategic Treasurer' });
  assert.equal(a.status, 200);
  assert.equal((await person('craig-jeffery')).headline, 'Managing Partner, Strategic Treasurer', 'the reviewed wording wins');
  assert.match(mailbox.shift().body.text, /card has been updated/);
  q = await queue();
  assert.ok(!q.submissions.some(s => s.id === r.body.id), 'out of the queue');
  assert.equal((await adminPost('/api/admin/submissions/' + r.body.id, { status: 'approved' })).status, 404, 'cannot be applied twice');
});

test('an approved link becomes a queued lead for the crawler; discuss keeps it in the queue and mails the question', async () => {
  const r = await send({ kind: 'link', personId: 'ernie-humphrey', payload: { url: 'https://example.org/agenda-2026', note: 'panel with Craig' }, email: 'a@example.org' });
  mailbox.length = 0;
  await adminPost('/api/admin/submissions/' + r.body.id, { status: 'discuss', note: 'Which session is it?' });
  let q = await queue();
  assert.equal(q.submissions.find(s => s.id === r.body.id).status, 'discuss');
  assert.match(mailbox.shift().body.text, /Which session is it\?/);
  await adminPost('/api/admin/submissions/' + r.body.id, { status: 'approved' });
  const lead = (await pool.query("select * from leads where id = $1", ['sub-' + r.body.id])).rows[0];
  assert.equal(lead.status, 'queued');
  assert.equal(lead.url, 'https://example.org/agenda-2026');
  assert.equal(lead.person_id, 'ernie-humphrey');
});

test('removal: hidden at once, restored on rejection, deleted on approval', async () => {
  const id = 'adam-drew';
  let r = await send({ kind: 'removal', personId: id, payload: { self: true }, email: 'adam@example.org' });
  assert.equal((await person(id)).hidden, true);
  let g = await fetch(base + '/api/graph').then(r => r.json());
  assert.ok(!g.people.some(p => p.id === id));
  await adminPost('/api/admin/submissions/' + r.body.id, { status: 'rejected', note: 'Public filing, kept.' });
  assert.equal((await person(id)).hidden, false);
  r = await send({ kind: 'removal', personId: id, payload: {}, email: 'adam@example.org' });
  const q = await queue();
  assert.equal(q.submissions[0].kind, 'removal', 'removals come first in the queue');
  await adminPost('/api/admin/submissions/' + r.body.id, { status: 'approved' });
  assert.equal(await person(id), undefined, 'deleted');
  const edges = await pool.query("select count(*)::int n from co_appearances where a = $1 or b = $1", [id]);
  assert.equal(edges.rows[0].n, 0, 'their links go with them');
});

test('admin endpoints refuse a wrong token; leads can be dismissed', async () => {
  const bad = await fetch(base + '/api/admin/queue', { headers: { 'x-admin-token': 'nope' } });
  assert.equal(bad.status, 401);
  const q = await queue();
  const lead = q.leads[0];
  assert.ok(lead);
  assert.equal((await adminPost('/api/admin/leads/' + encodeURIComponent(lead.id), { status: 'dismissed' })).status, 200);
  assert.ok(!(await queue()).leads.some(l => l.id === lead.id));
});

test('the digest counts what waits and what the crawler did', async () => {
  const { digest } = require('../scripts/digest');
  const d = await digest(pool);
  assert.match(d.subject, /Treasury Synapse: /);
  assert.match(d.text, /Review: https:\/\/synapse\.example\/review/);
  assert.equal(typeof d.counts.leads, 'number');
});

test('the review page is served, not indexed, and the map carries the form', async () => {
  const r = await fetch(base + '/review');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(await r.text(), /What is waiting for you/);
  assert.match(await fetch(base + '/robots.txt').then(r => r.text()), /Disallow: \/review/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="d-edit"') && html.includes("fetch('/api/submissions'"));
  const review = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  for (const f of [html, review]) assert.ok(!/\balert\(|confirm\(|prompt\(/.test(f.replace(/confirm\/|confirmed|confirmation|Confirm/g, '')), 'no browser dialogs');
});

test('LinkedIn import: only known people, one batch, a daily limit, confirmable at once on the review page', async () => {
  await pool.query("delete from quotas where kind = 'import'; delete from connections where note = 'LinkedIn connections import';");
  const imp = (body, consent = true) => fetch(base + '/api/connections/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign(consent ? { consent: true } : {}, body)) }).then(async r => ({ status: r.status, body: await r.json() }));
  const noConsent = await imp({ from: 'vincent-donnat', to: ['jouni-kirjola'] }, false);
  assert.equal(noConsent.status, 400, 'nothing is imported without agreeing to make it public');
  assert.match(noConsent.body.error, /publicly/);
  assert.equal((await imp({ from: 'nobody-here', to: ['craig-jeffery'] })).status, 404);
  assert.equal((await imp({ from: 'vincent-donnat', to: [] })).status, 400);
  const r = await imp({ from: 'vincent-donnat', to: ['jouni-kirjola', 'melania-maior', 'craig-jeffery', 'not-on-the-map', 'vincent-donnat', 'craig-jeffery'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 3, 'self, duplicates and unknown ids dropped');
  assert.equal(r.body.unknown, 1);
  const q = await queue();
  const mine = q.connections.filter(c => c.batch === r.body.batch);
  assert.equal(mine.length, 3);
  assert.equal(mine[0].batch_pending, 3);
  assert.equal((await pool.query("select count(*)::int n from connections where batch = $1 and public_consent_at is not null", [r.body.batch])).rows[0].n, 3, 'the agreement is recorded');
  const g = await fetch(base + '/api/graph?since=2000-01-01T00:00:00Z').then(r => r.json());
  assert.ok(g.connections.some(c => c.from === 'vincent-donnat' && c.to === 'jouni-kirjola' && c.status === 'pending'), 'shown pending in the connections angle');
  const s = await adminPost('/api/admin/connections-batch/' + r.body.batch, { status: 'confirmed' });
  assert.equal(s.body.updated, 3);
  assert.ok(!(await queue()).connections.some(c => c.batch === r.body.batch));
  const r2 = await imp({ from: 'vincent-donnat', to: ['jouni-kirjola'] });
  assert.equal(r2.body.added, 0, 'already declared');
  assert.equal((await imp({ from: 'vincent-donnat', to: ['adam-larson'] })).status, 429, 'third import of the day refused');
  /* the private list for the crawler: kept only with the second agreement, treasury and finance titles first */
  await pool.query("delete from quotas where kind = 'import'");
  const leads = [{ first: 'Anna', last: 'Treasury', company: 'Acme', position: 'Group Treasurer' }, { first: 'Bob', last: 'Builder', company: 'Bricks', position: 'Site manager' }, { first: 'Cleo', last: 'Money', company: 'Big Co', position: 'Financial controller' }];
  const n0 = await imp({ from: 'vincent-donnat', to: ['adam-larson'], leads });
  assert.equal(n0.body.leadsKept, 0, 'nothing kept without the second agreement');
  const n1 = await imp({ from: 'vincent-donnat', to: ['ernie-humphrey'], leads, leadsConsent: true });
  assert.deepEqual([n1.body.leadsKept, n1.body.leadsPriority], [3, 2]);
  const rows = (await pool.query("select first_name, priority, status, expires_at > now() + interval '11 months' as long from network_leads where owner_id = 'vincent-donnat' order by priority desc")).rows;
  assert.deepEqual(rows.map(r => [r.first_name, r.priority, r.status, r.long]), [['Anna', 3, 'queued', true], ['Cleo', 1, 'queued', true], ['Bob', 0, 'queued', true]]);
  assert.ok(!(await fetch(base + '/api/graph').then(r => r.text())).includes('Anna Treasury'), 'never on the map');
  await pool.query("delete from network_leads");
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="d-import"') && html.includes("fetch('/api/connections/import'"));
  const imp2 = html.slice(html.indexOf('id="imp-wrap"'));
  assert.ok(imp2.includes('{from:me.id,to:ids,consent:true}') && imp2.includes('map(c=>({first:c.first,last:c.last,company:c.company,position:c.position}))') && !/FormData|file\.text\(\)\)\s*\}/.test(imp2), 'only the matched ids are sent, never the file');
});

test('catch-up import from /review: adds people, links and evidence, never undoes a review decision', async () => {
  const dump = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'dump.json'), 'utf8'));
  const craig = (await person('craig-jeffery')).headline;
  assert.equal(craig, 'Managing Partner, Strategic Treasurer', 'set by the approved correction earlier');
  assert.equal(await person('adam-drew'), undefined, 'deleted by the approved removal earlier');
  const edge = dump.edges.find(e => e.id === 'jouni-kirjola__vincent-donnat');
  const before = (await pool.query("select evidence, confidence from co_appearances where a = 'jouni-kirjola' and b = 'vincent-donnat'")).rows[0];
  const dismissed = (await pool.query("select id from leads where status = 'dismissed' limit 1")).rows[0];
  /* what the crawler would have added since the deploy */
  const p = dump.people.find(x => x.id === 'craig-jeffery');
  Object.assign(p, { headline: 'An older headline from the crawler', insightNotes: 'new insight', topics: p.topics.concat(['Cash pooling']) });
  dump.people.push({ id: 'new-person-test', name: 'New Person', headline: 'Treasurer, Example SA', org: 'Example SA', region: 'Europe', topics: ['Liquidity'] });
  dump.edges.push({ id: 'craig-jeffery__new-person-test', a: 'craig-jeffery', b: 'new-person-test', kind: 'panel', label: 'Panel', url: 'https://example.org/panel', confidence: 0.9 });
  edge.evidence = (edge.evidence || []).concat([{ url: 'https://example.org/new-evidence', label: 'Another panel', kind: 'panel', date: '2026-10' }]);
  edge.confidence = 0.1;
  if (dismissed) dump.leads.push({ id: dismissed.id, url: 'https://example.org/x', status: 'pending' });
  const body = JSON.stringify(dump);
  assert.ok(body.length > 64 * 1024, 'bigger than the normal request limit');
  const bad = await fetch(base + '/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': 'nope' }, body });
  assert.equal(bad.status, 401);
  const r = await fetch(base + '/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN }, body }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.result;
  assert.equal(x.newPeople, 1);
  assert.equal(x.newEdges, 1);
  assert.ok(x.evidenceAdded >= 1, 'the new evidence, plus what reversed duplicate rows in the dump used to overwrite');
  assert.equal(x.removedSkipped, 1);
  assert.ok(x.lockedFields >= 1);
  assert.equal(await person('adam-drew'), undefined, 'a deleted card stays deleted');
  const c = await person('craig-jeffery');
  assert.equal(c.headline, craig, 'the approved correction wins over the crawler');
  assert.equal(c.insight_notes, 'new insight', 'insight is updated');
  const t = await pool.query("select 1 from person_topics where person_id = 'craig-jeffery' and topic = 'Cash pooling'");
  assert.equal(t.rows.length, 1);
  const after = (await pool.query("select evidence, confidence from co_appearances where a = 'jouni-kirjola' and b = 'vincent-donnat'")).rows[0];
  assert.equal(after.evidence.length, before.evidence.length + 1, 'evidence unioned by url');
  assert.equal(after.confidence, before.confidence, 'confidence is the max, never lowered');
  if (dismissed) assert.equal((await pool.query('select status from leads where id = $1', [dismissed.id])).rows[0].status, 'dismissed', 'lead decision kept');
  const g = await fetch(base + '/api/graph').then(r => r.json());
  assert.ok(g.people.some(q => q.id === 'new-person-test'), 'the map sees the new card at once');
  const again = await fetch(base + '/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN }, body }).then(r => r.json());
  assert.equal(again.result.newPeople + again.result.newEdges + again.result.evidenceAdded, 0, 'running it twice changes nothing');
  assert.equal((await pool.query("select evidence from co_appearances where a = 'jouni-kirjola' and b = 'vincent-donnat'")).rows[0].evidence.length, after.evidence.length);
  const review = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.ok(review.includes("fetch('/api/admin/import'") && review.includes('id="imp-file"'));
});

test('Add to the map: a person or what an organisation runs, with a public page, appears only once approved', async () => {
  await pool.query("delete from quotas");
  const bad = [
    [{ kind: 'add_person', payload: { name: 'Solo', url: 'https://example.org/talk' } }, /full name/],
    [{ kind: 'add_person', payload: { name: 'Ada Example', url: 'https://www.linkedin.com/in/ada' } }, /LinkedIn/],
    [{ kind: 'add_install', payload: { org: 'Acme', system: 'Kyriba' } }, /public page/],
    [{ kind: 'add_person', payload: { name: 'Craig Jeffery', url: 'https://example.org/talk' } }, /already on the map/]
  ];
  for (const [b, re] of bad) { const r = await send(b); assert.ok(r.status >= 400, JSON.stringify(r)); assert.match(r.body.error, re); }
  const p = await send({ kind: 'add_person', payload: { name: 'Ada Example', title: 'Group treasurer', org: 'Acme Foods', region: 'France', segment: 'Corporate treasury', self: true, url: 'https://example.org/panel-2026' } });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.status, 'pending');
  assert.strictEqual(await person('ada-example'), undefined, 'nothing appears before review');
  const i = await send({ kind: 'add_install', payload: { org: 'Acme Foods', system: 'Kyriba', status: 'implementing', url: 'https://example.org/press/acme-kyriba' } });
  assert.strictEqual(i.status, 200);
  const q = await queue();
  const sp = q.submissions.find(s => s.kind === 'add_person'), si = q.submissions.find(s => s.kind === 'add_install');
  assert.ok(sp && si);
  assert.strictEqual((await adminPost('/api/admin/submissions/' + sp.id, { status: 'approved' })).status, 200);
  assert.strictEqual((await adminPost('/api/admin/submissions/' + si.id, { status: 'approved' })).status, 200);
  const a = await person('ada-example');
  assert.deepStrictEqual({ name: a.name, headline: a.headline, org: a.org, region: a.region, source: a.source }, { name: 'Ada Example', headline: 'Group treasurer', org: 'Acme Foods', region: 'France', source: 'https://example.org/panel-2026' });
  const row = (await pool.query("select status, url, source from installs where company_id = 'acme-foods' and system = 'Kyriba'")).rows[0];
  assert.deepStrictEqual(row, { status: 'implementing', url: 'https://example.org/press/acme-kyriba', source: 'submission' });
  await pool.query("delete from installs where company_id = 'acme-foods'; delete from companies where id = 'acme-foods'; delete from people where id = 'ada-example'");
});
