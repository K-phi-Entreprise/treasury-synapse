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
  const imp = body => fetch(base + '/api/connections/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
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
  const g = await fetch(base + '/api/graph?since=2000-01-01T00:00:00Z').then(r => r.json());
  assert.ok(g.connections.some(c => c.from === 'vincent-donnat' && c.to === 'jouni-kirjola' && c.status === 'pending'), 'shown pending in the connections angle');
  const s = await adminPost('/api/admin/connections-batch/' + r.body.batch, { status: 'confirmed' });
  assert.equal(s.body.updated, 3);
  assert.ok(!(await queue()).connections.some(c => c.batch === r.body.batch));
  const r2 = await imp({ from: 'vincent-donnat', to: ['jouni-kirjola'] });
  assert.equal(r2.body.added, 0, 'already declared');
  assert.equal((await imp({ from: 'vincent-donnat', to: ['adam-larson'] })).status, 429, 'third import of the day refused');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="d-import"') && html.includes("fetch('/api/connections/import'"));
  const imp2 = html.slice(html.indexOf('id="imp-wrap"'));
  assert.ok(imp2.includes('body:JSON.stringify({from:me.id,to:ids})') && !/FormData|file\.text\(\)\)\s*\}/.test(imp2), 'only the matched ids are sent, never the file');
});
