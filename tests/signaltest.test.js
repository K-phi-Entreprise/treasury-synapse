'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makePool } = require('../scripts/db');
const st = require('../scripts/signaltest');

let pool, mock, base, calls = [];
test.before(async () => {
  await require('./setup').ready({ reset: true });
  pool = makePool();
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}'); calls.push({ key: req.headers['x-api-key'], body });
      res.setHeader('content-type', 'application/json'); res.setHeader('x-credits-remaining', '990');
      if (req.headers['x-api-key'] !== 'good') { res.statusCode = 401; return res.end('{}'); }
      if (body.domain === 'kyriba.com') return res.end(JSON.stringify({ coverage: { total_before_filters: 3, date_range: { earliest: '2024-01-08', latest: '2026-11-01' } }, signals: [
        { data: { post_url: 'https://www.linkedin.com/posts/a', posted_date: '2026-10-02', post_text: 'Big news. Acme Corp selects Kyriba to replace its spreadsheets. Read the customer story.', technologies_mentioned: [{ name: 'Kyriba' }] } },
        { data: { post_url: 'https://www.linkedin.com/posts/b', posted_date: '2026-09-01', post_text: 'Join us at our annual conference in Paris.' } },
        { data: { post_url: 'https://www.linkedin.com/posts/c', post_text: 'We are hiring.' } }] }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, r));
  base = 'http://127.0.0.1:' + mock.address().port;
});
test.after(async () => { mock.close(); await pool.end(); });

test('a refused key stores nothing, so the test can run again', async () => {
  const out = await st.run(pool, { key: 'bad', base });
  assert.strictEqual(out.posts, 0); assert.ok(out.errors.length);
  assert.strictEqual((await pool.query('select count(*)::int n from signal_tests')).rows[0].n, 0);
});
test('the test reads company posts once, counts dated posts and flags the ones that read like a decision', async () => {
  calls = [];
  const out = await st.run(pool, { key: 'good', base });
  assert.strictEqual(calls.length, st.DOMAINS.flat().length, 'a fallback domain is tried when the first is not found');
  assert.ok(!st.DOMAINS.flat().some(d => /zanders|actualize/.test(d)), 'vendors only');
  assert.deepStrictEqual(calls[0].body.signal_types, ['linkedin-post-company']);
  assert.deepStrictEqual([out.posts, out.dated, out.decisions, out.decisionsWithCustomerWord, out.creditsRemaining], [3, 2, 1, 1, 990]);
  assert.strictEqual(out.flagged[0].phrase, 'Acme Corp selects Kyriba to replace its spreadsheets.');
  assert.strictEqual(out.flagged[0].date, '2026-10-02');
  assert.strictEqual(await st.run(pool, { key: 'good', base }), null, 'never runs twice');
  assert.strictEqual(await st.run(pool, { key: '', base }), null, 'no key, nothing done');
});
