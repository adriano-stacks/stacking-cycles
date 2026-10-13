const { test } = require('node:test');
const assert = require('node:assert/strict');
const BondSchedule = require('./bond-schedule.js');

const info = { current_burn_block_height: 971203 };
const api = {
  listBonds: async () => ({
    cursor: { next: null },
    results: [{ number: 2, start: { block: 970550 } }, { number: 1, start: { block: 966350 } }],
  }),
  getBond: async number => ({
    number,
    cycle: 180 + number * 3,
    status: 'projected',
    start: { block: 990000 + number * 6300, timestamp: '2026-10-10T12:00:00Z', forecast: true },
    enrollmentClose: { block: 989850 + number * 6300, timestamp: '2026-10-09T09:00:00Z', forecast: true },
    unlock: { block: 1020000 + number * 6300, timestamp: '2027-04-10T12:00:00Z', forecast: true },
  }),
};

test('bond schedules use API indexes, cycles, and cutoffs rather than local protocol constants', async () => {
  const bonds = await BondSchedule.getBonds(1, 3, api);
  assert.deepEqual(bonds.map(bond => [bond.number, bond.cycle, bond.start.block]), [
    [1, 183, 996300], [2, 186, 1002600], [3, 189, 1008900],
  ]);
  assert.equal(bonds[0].enrollmentClose.block, 996150);
  assert.equal(bonds[0].enrollmentClose.timestamp, '2026-10-09T09:00:00Z');
  assert.equal(bonds[0].status, 'projected');
  assert.equal(bonds[0].unlock.block, 1026300);
});

test('upcoming selection follows published activation heights, including the activation boundary', async () => {
  for (const [height, expected] of [[960000, 1], [966349, 1], [966350, 2], [970549, 2], [970550, 3]]) {
    assert.equal(await BondSchedule.upcomingBond({ current_burn_block_height: height }, api), expected);
  }
  await assert.rejects(BondSchedule.upcomingBond({ current_burn_block_height: null }, api), /unavailable/);
});

test('upcoming selection searches all API pages and does not assume index ordering or cadence', async () => {
  const cursors = [];
  const paginated = {
    listBonds: async ({ cursor }) => {
      cursors.push(cursor);
      return cursor == null
        ? { results: [{ number: 12, start: { block: 990000 } }], cursor: { next: 'older' } }
        : { results: [{ number: 9, start: { block: 980000 } }, { number: 8, start: { block: 960000 } }], cursor: { next: null } };
    },
  };
  assert.equal(await BondSchedule.upcomingBond(info, paginated), 9);
  assert.deepEqual(cursors, [null, 'older']);
});

test('empty or failed bond APIs do not fall back to a hard-coded Genesis schedule', async () => {
  await assert.rejects(BondSchedule.upcomingBond(info, {
    listBonds: async () => ({ results: [], cursor: { next: null } }),
  }), /No bond schedules/);
  await assert.rejects(BondSchedule.getBonds(3, 1, {
    getBond: async () => { throw new Error('API unavailable'); },
  }), /API unavailable/);
});

test('skipped, never-created bonds are bypassed using API responses rather than local cycle math', async () => {
  const calls = [];
  const skipped = {
    ...api,
    getBond: async number => {
      calls.push(number);
      if (number < 19) throw Object.assign(new Error('Bond not found'), { status: 404 });
      return api.getBond(number);
    },
  };
  assert.equal(await BondSchedule.upcomingBond(info, skipped), 19);
  assert.ok(calls.length < 12);
});

test('a later published bond does not hide earlier projected bonds', async () => {
  const later = {
    ...api,
    listBonds: async () => ({ cursor: { next: null }, results: [
      { number: 12, start: { block: 990000 } }, { number: 2, start: { block: 970550 } },
    ] }),
  };
  assert.equal(await BondSchedule.upcomingBond(info, later), 3);
});

test('upcoming probes stop on service errors and bound unavailable schedule searches', async () => {
  let calls = 0;
  await assert.rejects(BondSchedule.upcomingBond(info, {
    ...api, getBond: async () => { throw Object.assign(new Error('API unavailable'), { status: 503 }); },
  }), /API unavailable/);
  await assert.rejects(BondSchedule.upcomingBond(info, {
    ...api, getBond: async () => { calls++; throw Object.assign(new Error('Bond not found'), { status: 404 }); },
  }), /No upcoming bond schedule/);
  assert.ok(calls < 16);
});

test('announcement remains an explicitly estimated seven-day calendar lead', async () => {
  const [bond] = await BondSchedule.getBonds(2, 1, api);
  assert.equal(bond.opens.timestamp, '2026-10-03T12:00:00.000Z');
  assert.equal(bond.opens.forecast, true);
  assert.equal(Date.parse(bond.start.timestamp) - Date.parse(bond.opens.timestamp), 7 * 86400000);
});

test('announcement lead spans DST without changing duration or API block dates', async () => {
  const [bond] = await BondSchedule.getBonds(3, 1, {
    getBond: async number => ({ ...await api.getBond(number), start: { block: 1008900, timestamp: '2026-10-28T12:00:00Z', forecast: true } }),
  });
  assert.equal(bond.opens.timestamp, '2026-10-21T12:00:00.000Z');
  assert.equal(bond.start.block, 1008900);
});

test('past activations never confirm an operational announcement', async () => {
  const [bond] = await BondSchedule.getBonds(1, 1, {
    getBond: async number => ({ ...await api.getBond(number), start: { block: 966350, timestamp: '2026-09-10T12:00:00Z', forecast: false } }),
  });
  assert.equal(bond.start.forecast, false);
  assert.equal(bond.opens.forecast, true);
});

test('missing API dates stay unavailable', async () => {
  const [bond] = await BondSchedule.getBonds(2, 1, {
    getBond: async number => ({ ...await api.getBond(number), start: { block: 1002600, timestamp: null, forecast: true } }),
  });
  assert.equal(bond.opens.timestamp, null);
});

test('invalid ranges fail before calling the API', async () => {
  for (const value of [-1, 0, 1.5, NaN, Infinity, 10001]) await assert.rejects(BondSchedule.getBonds(value, 1, api));
  for (const count of [0, 13, 1.5]) await assert.rejects(BondSchedule.getBonds(2, count, api));
  assert.equal((await BondSchedule.getBonds(9999, 6, api)).length, 2);
});
