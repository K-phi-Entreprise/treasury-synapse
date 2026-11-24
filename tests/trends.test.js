'use strict';
/* Trends are shares, big conferences are set apart, old and future stages are left out, and no arrow without data. */
const test = require('node:test');
const assert = require('node:assert');
const { buildTrends, monthOf } = require('../scripts/trends');

test('a month comes from the date, or from the label', () => {
  assert.strictEqual(monthOf('2026-03-04', ''), '2026-03');
  assert.strictEqual(monthOf('', 'Nomentia webinar: AI in Treasury (Oct 2025)'), '2025-10');
  assert.strictEqual(monthOf('', 'Main Street Banking podcast, 2026-01-21'), '2026-01');
  assert.strictEqual(monthOf('', 'A talk with no date'), null);
});

const today = new Date('2026-11-24T12:00:00Z');
const stage = (date, label) => ({ date, label, kind: 'podcast' });
function sample() {
  const out = [];
  /* steady background: 20 stages a quarter, 2 on payments; AI goes from 2 to 8 */
  ['2026-01', '2026-04', '2026-07', '2026-10'].forEach((m, k) => {
    for (let i = 0; i < 20; i++) {
      const ai = i < (k < 2 ? 2 : 8), pay = i >= 18;
      out.push(stage(m + '-0' + (1 + i % 9), 'Show ' + i + ': ' + (ai ? 'AI agents for treasurers' : pay ? 'Instant payments today' : 'Careers and leadership') + ' ' + i));
    }
  });
  /* a conference burst on payments: must not drive the arrow */
  for (let i = 0; i < 40; i++) out.push(stage('2026-09-1' + (i % 9), 'Sibos 2026, Miami: Cross-border payments session ' + i));
  out.push(stage('2024-05-01', 'Old podcast: AI in 2024'));
  out.push(stage('2026-12-01', 'Future podcast: AI next month'));
  out.push({ date: '2026-03-01', label: 'Board page: AI in finance', kind: 'executive' });
  return out;
}

test('shares per quarter, events apart, old, future and non-stages left out', () => {
  const T = buildTrends(sample(), today);
  assert.deepStrictEqual(T.quarters.slice(-2), ['2026Q3', '2026Q4']);
  assert.strictEqual(T.events.length, 1);
  assert.strictEqual(T.events[0].name, 'Sibos 2026');
  const qi = T.quarters.indexOf('2026Q3');
  assert.strictEqual(T.total[qi], 60);
  assert.strictEqual(T.totalCore[qi], 20);
  assert.strictEqual(T.leftOut, 3);
  assert.strictEqual(T.topics['AI in finance'].trend, 'up');
  assert.strictEqual(T.topics.Payments.trend, 'flat', 'the conference burst does not make payments rise');
  assert.strictEqual(T.topics.Commodities.trend, null, 'no arrow without data');
});

test('count and share must agree: more stages in a busier period is not a rise; tiny moves stay steady', () => {
  const out = [];
  /* prior six months: 20 stages, 4 on liquidity (20%). Recent: 60 stages, 6 on liquidity (10%): more stages, smaller share */
  for (let i = 0; i < 20; i++) out.push(stage('2026-02-0' + (1 + i % 9), 'Show p' + i + ': ' + (i < 4 ? 'Liquidity outlook' : 'Careers') + (i < 1 ? ' and fraud' : '')));
  for (let i = 0; i < 60; i++) out.push(stage('2026-08-0' + (1 + i % 9), 'Show r' + i + ': ' + (i < 6 ? 'Liquidity outlook' : 'Careers') + (i < 3 ? ' and fraud' : '')));
  const T = buildTrends(out, today);
  assert.strictEqual(T.topics.Liquidity.recent, 6);
  assert.strictEqual(T.topics.Liquidity.prior, 4);
  assert.strictEqual(T.topics.Liquidity.trend, 'flat', '+2 stages while the share halves');
  assert.strictEqual(T.topics.Fraud.trend, null, '1 then 3 stages: too few to read');
});
