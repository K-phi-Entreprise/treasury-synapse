'use strict';
/* Request help: private requests, suggested people, introductions by email to both sides, the eight-week follow-up. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mailbox = [], mailSrv, server, base, pool, srv;
const TOKEN = 'requests-test-token';
const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const adm = { 'x-admin-token': TOKEN };
const linkIn = m => m.text.match(/https:\/\/synapse\.example(\/\S+)/)[1];

test.before(async () => {
  await require('./setup').ready({ reset: true });
  mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { mailbox.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end('{"id":"m"}'); }); });
  await new Promise(r => mailSrv.listen(0, r));
  Object.assign(process.env, { RESEND_BASE_URL: 'http://127.0.0.1:' + mailSrv.address().port, RESEND_API_KEY: 're_test', MAIL_FROM: 'Synapse <synapse@k-phi.com>', ADMIN_TOKEN: TOKEN, PUBLIC_URL: 'https://synapse.example' });
  delete require.cache[require.resolve('../server')];
  srv = require('../server');
  pool = srv.pool;
  await pool.query('delete from quotas');
  await new Promise(r => { server = srv.app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
  /* a consultant who claimed his card and declared Kyriba implementations, open to reference calls, available in the United States */
  await post('/api/claims', { personId: 'craig-jeffery', email: 'craig@strategictreasurer.com' });
  const res = await fetch(base + linkIn(mailbox.pop()), { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/me/card', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({
    systems: [{ system: 'Kyriba', role: 'implements', topics: ['In-house banking'], referenceOk: true }], profile: { forHire: true, regions: ['United States'] } }) });
  mailbox = [];
});
test.after(async () => { server.close(); mailSrv.close(); await pool.end(); });

test('a request needs an email and something to go on; it is private and confirmed by link', async () => {
  assert.equal((await post('/api/requests', { kind: 'selection', systems: ['Kyriba'] })).status, 400);
  assert.equal((await post('/api/requests', { kind: 'selection', email: 'cfo@example.org' })).status, 400);
  assert.equal((await post('/api/requests', { kind: 'nonsense', email: 'cfo@example.org', details: 'x' })).status, 400);
  const r = await post('/api/requests', { kind: 'selection', email: 'Treasurer@Example.org', name: 'Anna', role: 'Group treasurer', company: 'Example Oy', region: 'United States', size: '1000-5000', erp: 'SAP',
    systems: 'Kyriba, Nomentia', topics: ['In-house banking', 'Bananas'], timing: '3m', details: 'Twelve entities, 30 banks.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mail, 'sent');
  const m = mailbox.shift();
  assert.deepEqual(m.to, ['treasurer@example.org']);
  assert.match(m.text, /never shown on the map/);
  const page = await fetch(base + linkIn(m)).then(r => r.text());
  assert.match(page, /Request confirmed/);
  const g = await fetch(base + '/api/graph').then(r => r.json());
  assert.ok(!JSON.stringify(g).includes('treasurer@example.org'), 'nothing of it on the map');
});

test('the review page suggests consultants and references from evidence and declarations; vendors only when asked', async () => {
  const q = await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json());
  const rq = q.requests[0];
  assert.ok(rq.confirmed_at);
  assert.deepEqual(rq.systems, ['Kyriba', 'Nomentia']);
  assert.deepEqual(rq.topics, ['In-house banking'], 'unknown topics dropped');
  assert.equal(rq.confirm_token, undefined, 'tokens never leave the server');
  const c = rq.suggestions.consultants.find(p => p.id === 'craig-jeffery');
  assert.ok(c && c.claimed && c.regionMatch, JSON.stringify(c));
  assert.ok(c.declared.some(d => /implements Kyriba/.test(d)));
  assert.ok(rq.suggestions.references.some(p => p.id === 'craig-jeffery'));
  assert.deepEqual(rq.suggestions.vendors, [], 'the requester did not ask for vendors');
  /* with vendors allowed, people whose pages say they sell the system come up, and never as consultants */
  mailbox = [];
  await post('/api/requests', { kind: 'selection', email: 'b@example.org', systems: ['Kyriba'], details: 'x', routing: { consultants: true, references: true, vendors: true } });
  const q2 = await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json());
  const v = q2.requests.find(x => x.email === 'b@example.org').suggestions;
  assert.ok(v.vendors.length > 0 && v.vendors.every(p => p.sells.length));
  assert.ok(v.consultants.every(p => !p.sells.length));
});

test('an introduction sends one email to each side with the other address; only claimed cards can be introduced', async () => {
  const q = await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json());
  const rq = q.requests.find(x => x.email === 'treasurer@example.org');
  mailbox = [];
  assert.equal((await post('/api/admin/requests/' + rq.id + '/introduce', { personId: 'jouni-kirjola' }, adm)).status, 400);
  const r = await post('/api/admin/requests/' + rq.id + '/introduce', { personId: 'craig-jeffery', note: 'Craig ran two in-house bank projects.' }, adm);
  assert.equal(r.status, 200);
  assert.equal(r.body.mailed, true);
  const toReq = mailbox.find(m => m.to[0] === 'treasurer@example.org'), toCons = mailbox.find(m => m.to[0] === 'craig@strategictreasurer.com');
  assert.match(toReq.text, /craig@strategictreasurer\.com/);
  assert.match(toCons.text, /treasurer@example\.org/);
  assert.match(toCons.text, /Twelve entities, 30 banks/);
  assert.match(toCons.text, /Craig ran two in-house bank projects/);
  const after = (await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json())).requests.find(x => x.id === rq.id);
  assert.equal(after.status, 'introduced');
  assert.ok(after.introductions.some(i => i.person_id === 'craig-jeffery'));
});

test('eight weeks later the requester is asked what they chose and why; the answer is kept once', async () => {
  await pool.query("update requests set added_at = now() - interval '60 days' where email = 'treasurer@example.org'");
  mailbox = [];
  assert.equal(await srv.requests.sendFollowUps(), 1, 'only the confirmed request that is due');
  assert.equal(await srv.requests.sendFollowUps(), 0, 'never twice');
  const link = linkIn(mailbox[0]);
  assert.match(link, /^\/outcome\//);
  const form = await fetch(base + link).then(r => r.text());
  assert.match(form, /What did you choose/);
  const send = () => fetch(base + link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'result=chose&chosen=Nomentia&considered=Kyriba%2C+Nomentia&why=Bank+connectivity+in+the+Nordics&helped=yes' }).then(r => r.text());
  assert.match(await send(), /Thank you/);
  assert.match(await send(), /Already answered/);
  const q = await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json());
  const o = q.outcomes[0].outcome;
  assert.deepEqual([o.result, o.chosen, o.helped], ['chose', 'Nomentia', 'yes']);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const t of ['id="hp-wrap"', "fetch('/api/requests'", "hb.id='help-btn'", 'synapse:hub']) assert.ok(html.includes(t), t);
  const review = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.ok(review.includes("['request','Requests']") && review.includes('/introduce'));
});

test('find a consultant: public evidence first, declared next, vendors of the system left out, filters by topic and region', async () => {
  const j = await fetch(base + '/api/consultants?system=Kyriba').then(r => r.json());
  const craig = j.consultants.find(c => c.id === 'craig-jeffery');
  assert.ok(craig && craig.available && craig.claimed);
  assert.ok(craig.declared.some(d => d.system === 'Kyriba' && d.role === 'implements' && d.referenceOk));
  const sellers = (await pool.query("select person_id from person_systems where lower(system) = 'kyriba' and role = 'sells'")).rows.map(r => r.person_id);
  assert.ok(sellers.length && !j.consultants.some(c => sellers.includes(c.id)), 'people who sell Kyriba are not consultants for Kyriba');
  for (let i = 1; i < j.consultants.length; i++) assert.ok(j.consultants[i - 1].evidence.length + j.consultants[i - 1].declared.length > 0);
  const t = await fetch(base + '/api/consultants?system=Kyriba&topic=In-house%20banking').then(r => r.json());
  assert.ok(t.consultants.some(c => c.id === 'craig-jeffery'));
  const none = await fetch(base + '/api/consultants?system=Kyriba&topic=Commodities').then(r => r.json());
  assert.ok(!none.consultants.some(c => c.id === 'craig-jeffery'));
  const reg = await fetch(base + '/api/consultants?region=United%20States').then(r => r.json());
  assert.ok(reg.consultants.find(c => c.id === 'craig-jeffery').regionMatch);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes("fetch('/api/consultants?'") && html.includes('window.synapseConsultants=open'));
});

test('your network: who links you to a consultant, and the request carries the person and the intermediaries', async () => {
  /* vincent knows jouni; jouni knows craig: vincent reaches craig through jouni */
  await pool.query("insert into connections (from_id, to_id, status) values ('vincent-donnat','jouni-kirjola','confirmed'),('craig-jeffery','jouni-kirjola','pending') on conflict do nothing");
  const p = await fetch(base + '/api/paths?from=vincent-donnat&to=craig-jeffery,jouni-kirjola,adam-larson').then(r => r.json());
  assert.deepEqual(p.paths['jouni-kirjola'], { direct: true, via: [] });
  assert.deepEqual(p.paths['craig-jeffery'], { direct: false, via: [{ id: 'jouni-kirjola', name: 'Jouni Kirjola' }] });
  assert.equal(p.paths['adam-larson'], undefined);
  mailbox = [];
  await pool.query("delete from quotas where kind = 'request'");
  const r = await post('/api/requests', { kind: 'implementation', email: 'v@example.org', systems: ['Kyriba'], details: 'Intro please', targetId: 'craig-jeffery', viaIds: ['jouni-kirjola', 'not-a-person'] });
  assert.equal(r.status, 200);
  const q = await fetch(base + '/api/admin/requests', { headers: adm }).then(r => r.json());
  const rq = q.requests.find(x => x.email === 'v@example.org');
  assert.equal(rq.target.name, 'Craig Jeffery');
  assert.deepEqual(rq.via.map(v => v.id), ['jouni-kirjola'], 'unknown people dropped');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes("fetch('/api/paths?from='") && html.includes('id="imp-consent"') && html.includes('.sbm select option{background-color:var(--sheet)'));
});
