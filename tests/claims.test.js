'use strict';
/* Claimed cards: work-email check, magic link, signed cookie, review path, sign-in on another device. Mail goes to a local stand-in. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { domainMatches, brand } = require('../claims');

let mailbox = [], mailSrv, server, base, pool;
const TOKEN = 'claims-test-token';

test.before(async () => {
  await require('./setup').ready({ reset: true });
  mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { mailbox.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end('{"id":"m"}'); }); });
  await new Promise(r => mailSrv.listen(0, r));
  Object.assign(process.env, { RESEND_BASE_URL: 'http://127.0.0.1:' + mailSrv.address().port, RESEND_API_KEY: 're_test', MAIL_FROM: 'Synapse <synapse@k-phi.com>', ADMIN_TOKEN: TOKEN, PUBLIC_URL: 'https://synapse.example' });
  delete require.cache[require.resolve('../server')];
  const s = require('../server');
  pool = s.pool;
  await pool.query('delete from quotas');
  await new Promise(r => { server = s.app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); mailSrv.close(); await pool.end(); });

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const linkIn = m => m.text.match(/https:\/\/synapse\.example(\/api\/(?:claim|confirm)\/\S+)/)[1];
const follow = p => fetch(base + p, { redirect: 'manual' });
const meWith = cookie => fetch(base + '/api/me', { headers: { cookie } }).then(r => r.json());

test('the work email has to belong to the organisation on the card', () => {
  assert.equal(brand('eu.kyriba.com'), 'kyriba');
  assert.equal(brand('ing.co.uk'), 'ing');
  const ok = (email, org, hosts) => domainMatches(email, { org, headline: '' }, hosts || []).ok;
  assert.ok(ok('j@nomentia.com', 'Nomentia'));
  assert.ok(ok('c@strategictreasurer.com', 'Strategic Treasurer'));
  assert.ok(ok('a@eu.kyriba.com', 'Kyriba'));
  assert.ok(ok('x@agicap.fr', 'Agicap SAS'));
  assert.ok(ok('x@k-phi.com', 'Somewhere Else', ['www.k-phi.com']), 'the site the card comes from counts');
  assert.ok(!ok('x@gmail.com', 'Nomentia'));
  assert.equal(domainMatches('x@gmail.com', { org: 'Nomentia' }, []).reason, 'personal address');
  assert.ok(!ok('x@kyriba.com', 'Nomentia'));
  assert.ok(!ok('x@ab.com', 'Abacus Bank'), 'two letters are not enough to match a company');
});

test('claim with a work email: one link, the card is claimed, the browser is signed in, the link works once', async () => {
  mailbox = [];
  const r = await post('/api/claims', { personId: 'craig-jeffery', email: 'Craig@StrategicTreasurer.com' });
  assert.deepEqual(r.body, { status: 'sent', mail: 'sent' });
  assert.deepEqual(mailbox[0].to, ['craig@strategictreasurer.com']);
  const link = linkIn(mailbox[0]);
  assert.match(link, /^\/api\/claim\//);
  assert.equal((await fetch(base + '/api/claimed').then(r => r.json())).ids.includes('craig-jeffery'), false, 'nothing before the link is opened');
  const res = await follow(link);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?card=craig-jeffery&claimed=1');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await meWith(cookie)).personId, 'craig-jeffery');
  assert.ok((await fetch(base + '/api/claimed').then(r => r.json())).ids.includes('craig-jeffery'));
  const again = await follow(link);
  assert.equal(again.status, 200);
  assert.match(await again.text(), /Link not recognised/);
  /* a forged or tampered cookie signs nobody in */
  assert.deepEqual(await meWith('syn_card=craig-jeffery.9999999999999.forged'), {});
  assert.deepEqual(await meWith(cookie.replace('craig-jeffery', 'ernie-humphrey')), {});
  const out = await fetch(base + '/api/me/logout', { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('a personal address goes to review: confirm, approve on /review, the person gets a sign-in link', async () => {
  mailbox = [];
  const r = await post('/api/claims', { personId: 'ernie-humphrey', email: 'ernie.h@gmail.com', note: 'I run my own firm' });
  assert.equal(r.body.status, 'review');
  assert.equal(r.body.reason, 'personal address');
  await follow(linkIn(mailbox.shift()));
  const q = await fetch(base + '/api/admin/queue', { headers: { 'x-admin-token': TOKEN } }).then(r => r.json());
  const item = q.submissions.find(s => s.kind === 'claim' && s.person_id === 'ernie-humphrey');
  assert.ok(item && item.confirmed_at);
  assert.equal(item.payload.note, 'I run my own firm');
  const a = await post('/api/admin/submissions/' + item.id, { status: 'approved' }, { 'x-admin-token': TOKEN });
  assert.equal(a.status, 200);
  const m = mailbox.shift();
  assert.match(m.text, /The card is now yours/);
  const res = await follow(linkIn(m));
  assert.equal(res.headers.get('location'), '/?card=ernie-humphrey');
  assert.equal((await meWith(res.headers.get('set-cookie').split(';')[0])).personId, 'ernie-humphrey');
  const c = (await pool.query("select method from claims where person_id = 'ernie-humphrey'")).rows[0];
  assert.equal(c.method, 'review');
});

test('another address on a claimed card goes to review; sign-in on another device reveals nothing about unknown addresses', async () => {
  mailbox = [];
  const r = await post('/api/claims', { personId: 'craig-jeffery', email: 'someone@strategictreasurer.com' });
  assert.equal(r.body.status, 'review');
  assert.match(r.body.reason, /already claimed/);
  mailbox = [];
  const known = await post('/api/claims/login', { email: 'craig@strategictreasurer.com' });
  const unknown = await post('/api/claims/login', { email: 'nobody@example.org' });
  assert.deepEqual(known.body, unknown.body, 'same answer either way');
  assert.equal(mailbox.length, 1, 'only the known address gets a link');
  assert.match(mailbox[0].text, /sign in to the card of Craig Jeffery/);
  const res = await follow(linkIn(mailbox[0]));
  assert.equal(res.headers.get('location'), '/?card=craig-jeffery');
});

test('claims are limited per visitor per day, and the page carries the claim flow', async () => {
  await pool.query("delete from quotas where kind = 'claim'");
  let last;
  for (let i = 0; i < 6; i++) last = await post('/api/claims', { personId: 'jouni-kirjola', email: 'j' + i + '@nomentia.com' });
  assert.equal(last.status, 429);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const t of ['id="cl-wrap"', "fetch(mode==='claim'?'/api/claims':'/api/claims/login'", "fetch('/api/me'", 'synapse:detail', 'window.synapseFocus=']) assert.ok(html.includes(t), t);
  const review = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.ok(review.includes("['claim','Claims']"));
});

test('declarations: only the signed-in owner edits a card, values come from fixed lists, they show apart from evidence, the owner can take them down', async () => {
  mailbox = [];
  await pool.query("delete from quotas where kind = 'claim'");
  await post('/api/claims', { personId: 'jouni-kirjola', email: 'jouni@nomentia.com' });
  const res = await follow(linkIn(mailbox.shift()));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const put = (body, c) => fetch(base + '/api/me/card', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: c || '' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.equal((await put({ systems: [] }, '')).status, 401, 'not signed in');
  const edgesBefore = (await pool.query('select count(*)::int n from co_appearances')).rows[0].n;
  const topicsBefore = (await pool.query("select count(*)::int n from person_topics where person_id = 'jouni-kirjola'")).rows[0].n;
  let r = await put({
    systems: [
      { system: 'Kyriba', role: 'implements', topics: ['In-house banking', 'Cash forecasting', 'Bananas'], from: '2019', to: '2022', referenceOk: true },
      { system: 'Nomentia', role: 'sells', topics: [] },
      { system: 'Kyriba', role: 'implements', topics: [] }],
    topics: [{ topic: 'Liquidity', role: 'worked_on' }, { topic: 'In-house banking', role: 'implemented' }, { topic: 'Gardening', role: 'worked_on' }],
    profile: { forHire: true, regions: ['Nordics', 'Mars'], languages: 'English, Finnish', note: 'Interim treasury projects' }
  }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.systems.length, 2, 'a duplicate system and role is kept once');
  assert.deepEqual(r.body.systems.find(s => s.system === 'Kyriba').topics, ['In-house banking', 'Cash forecasting']);
  assert.equal(r.body.topics.length, 2, 'unknown topics are dropped');
  assert.deepEqual(r.body.profile.regions, ['Nordics']);
  assert.deepEqual(r.body.profile.languages, ['English', 'Finnish']);
  assert.equal((await put({ systems: [{ system: 'X', role: 'hacks' }] }, cookie)).status, 400);
  const pub = await fetch(base + '/api/declared').then(r => r.json());
  const j = pub.people['jouni-kirjola'];
  assert.ok(j.systems.some(s => s.system === 'Kyriba' && s.referenceOk && s.from === '2019'));
  assert.equal(j.profile.forHire, true);
  assert.equal((await pool.query('select count(*)::int n from co_appearances')).rows[0].n, edgesBefore, 'declarations never create links');
  assert.equal((await pool.query("select count(*)::int n from person_topics where person_id = 'jouni-kirjola'")).rows[0].n, topicsBefore, 'nor evidence topics');
  /* the owner reviews and removes */
  const a = await fetch(base + '/api/admin/declarations', { headers: { 'x-admin-token': TOKEN } }).then(r => r.json());
  const row = a.declarations.find(d => d.person_id === 'jouni-kirjola' && d.system === 'Nomentia');
  assert.ok(row && a.available.some(x => x.person_id === 'jouni-kirjola'));
  assert.equal((await post('/api/admin/declarations/' + row.id, {}, { 'x-admin-token': TOKEN })).status, 200);
  await post('/api/admin/available/jouni-kirjola', {}, { 'x-admin-token': TOKEN });
  const pub2 = (await fetch(base + '/api/declared').then(r => r.json())).people['jouni-kirjola'];
  assert.ok(!pub2.systems.some(s => s.system === 'Nomentia'));
  assert.ok(!pub2.profile || !pub2.profile.forHire);
  const me = await fetch(base + '/api/me/card', { headers: { cookie } }).then(r => r.json());
  assert.equal(me.name, 'Jouni Kirjola');
  assert.ok(me.choices.topics.includes('In-house banking'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const t of ['id="ed-wrap"', "fetch('/api/me/card',{method:'PUT'", "fetch('/api/declared'", 'not checked against public pages']) assert.ok(html.includes(t), t);
});

test('an address with a stray space (a phone keyboard after the dot) is accepted as the address without it', async () => {
  const r = await fetch(base + '/api/claims/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'vincent@k-phi. com' }) });
  assert.strictEqual(r.status, 200, JSON.stringify(await r.clone().json()));
  const c = await fetch(base + '/api/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId: 'ernie-humphrey', email: ' someone@strategictreasurer. com ' }) });
  assert.notStrictEqual(c.status, 400, JSON.stringify(await c.clone().json()));
});
