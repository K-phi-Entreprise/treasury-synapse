'use strict';
/* Topics read from stage titles: the series name and brackets are ignored, awards are not a stage, French titles count. */
const test = require('node:test');
const assert = require('node:assert');
const { topicsOf, subject, TOPICS, RULES_TEXT } = require('../scripts/topics');

test('the series name before the colon is not the subject', () => {
  assert.deepStrictEqual(topicsOf('FORECAST podcast #13: La technologie blockchain au service du trésorier'), ['Crypto & stablecoins']);
  assert.ok(!topicsOf('FORECAST podcast: Le métier de trésorier').includes('Cash forecasting'));
  assert.ok(!topicsOf('The FP&A Guy network: Careers with Jane Doe').includes('FP&A & planning'));
});
test('quoted titles, French and English', () => {
  assert.deepStrictEqual(topicsOf("FORECAST #7, 'La fraude au virement'"), ['Payments', 'Fraud']);
  assert.deepStrictEqual(topicsOf("FORECAST #31, 'L'ETI face au risque de change' (3 Apr 2026)").sort(), ['FX & hedging', 'Risk & compliance']);
  assert.deepStrictEqual(topicsOf('AFP 2026 conference: Unlocking Working Capital through Treasury-Procurement Collaboration'), ['Working capital', 'AR/AP']);
  assert.deepStrictEqual(topicsOf('Nomentia webinar: AI in Treasury Management (Oct 2025)'), ['AI in finance']);
});
test('an apostrophe inside a word is not a quote', () => {
  assert.strictEqual(subject("FORECAST podcast #22: Gérer sa trésorerie à l'ère de l'e-euro"), "Gérer sa trésorerie à l'ère de l'e-euro");
});
test('awards and press releases are not stages', () => {
  assert.deepStrictEqual(topicsOf('Treasury Today Adam Smith Awards 2025: Best Payments Solution'), []);
  assert.deepStrictEqual(topicsOf('Press release: Anaplan appoints a new CEO for planning'), []);
});
test('the published rules cover the same 19 topics as the cards', () => {
  const { TOPICS: CARD } = require('../declarations');
  assert.deepStrictEqual([...TOPICS].sort(), [...CARD].sort());
  assert.strictEqual(RULES_TEXT.length, 19);
});
