// Run with: node --test bond-schedule.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BondSchedule = require('./bond-schedule.js');

const info = {
  first_burnchain_block_height: 666050,
  reward_cycle_length: 2100,
  prepare_phase_block_length: 100,
  current_cycle_id: 144,
};
// A deliberately non-default block rate checks that lead days stay calendar
// durations while enrollment closes at a protocol block boundary.
const startMs = Date.parse('2026-10-10T12:00:00Z');
const api = {
  getInfo: async () => info,
  getBlock: async block => ({ block, timestamp: new Date(startMs + (block - 970550) * 540000).toISOString(), forecast: true }),
};

test('partner bond numbering anchors Genesis and advances by two cycles', async () => {
  const bonds = await BondSchedule.getBonds(1, 3, api);
  assert.deepEqual(bonds.map(b => [b.number, b.cycle, b.start.block]), [
    [1, 143, 966350], [2, 145, 970550], [3, 147, 974750],
  ]);
});

test('upcoming selection advances at the start, not the end, of a bond cycle', () => {
  for (const [current, expected] of [[140, 1], [142, 1], [143, 2], [144, 2], [145, 3], [146, 3], [147, 4]]) {
    assert.equal(BondSchedule.upcomingBond({ current_cycle_id: current }), expected);
  }
  assert.throws(() => BondSchedule.upcomingBond({ current_cycle_id: null }), /unavailable/);
});

test('opening is seven days before the start, separate from the enrollment block', async () => {
  const [bond] = await BondSchedule.getBonds(2, 1, api);
  assert.equal(bond.opens.timestamp, '2026-10-03T12:00:00.000Z');
  assert.equal(bond.enrollmentClose.block, 970450);
  assert.equal(bond.enrollmentClose.timestamp, '2026-10-09T21:00:00.000Z');
});

test('opening lead spans DST without changing duration or block dates', async () => {
  const [bond] = await BondSchedule.getBonds(3, 1, api);
  assert.equal(Date.parse(bond.start.timestamp) - Date.parse(bond.opens.timestamp), 7 * 86400000);
  assert.equal(bond.start.block, 974750);
});

test('past operational targets never claim confirmed opening', async () => {
  const historical = { ...api, getBlock: async block => ({ block, timestamp: '2026-09-10T12:00:00Z', forecast: false }) };
  const [bond] = await BondSchedule.getBonds(1, 1, historical);
  assert.equal(bond.start.forecast, false);
  assert.equal(bond.opens.forecast, true);
});

test('missing block timestamps stay unavailable', async () => {
  const unavailable = { ...api, getBlock: async block => ({ block, timestamp: null, forecast: true }) };
  const [bond] = await BondSchedule.getBonds(2, 1, unavailable);
  assert.equal(bond.opens.timestamp, null);
});

test('invalid ranges fail without producing misleading dates', async () => {
  for (const value of [-1, 0, 1.5, NaN, Infinity, 10001]) assert.throws(() => BondSchedule.startCycle(value));
  for (const count of [0, 13, 1.5]) await assert.rejects(BondSchedule.getBonds(2, count, api));
  assert.equal((await BondSchedule.getBonds(9999, 6, api)).length, 2);
});
