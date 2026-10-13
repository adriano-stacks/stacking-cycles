const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(require.resolve('./stacks-cycles.js'), 'utf8');
const tipHeight = 971203;
const tipTime = 1791873488;
const pace = 540.5;
const toIso = seconds => new Date(seconds * 1000).toISOString();
const schedulePoint = (height, time, projectedTime = null) => ({
  bitcoin_height: height,
  time, time_iso: time == null ? null : toIso(time),
  projected_time: projectedTime, projected_time_iso: projectedTime == null ? null : toIso(projectedTime),
});
const current = {
  number: 145, status: 'reward_phase',
  schedule: {
    start: schedulePoint(970550, 1791505072),
    prepare_phase_start: schedulePoint(972550, null, 1792671230),
    end: schedulePoint(972649, null, 1792730630),
  },
};
const bond = {
  index: 3, status: 'projected',
  schedule: {
    activation: { ...schedulePoint(974750, null, 1793991230), pox_cycle: 147 },
    enrollment_cutoff: { ...schedulePoint(974650, null, 1793931230), pox_cycle: 146 },
    unlock: { ...schedulePoint(999950, null, 1809111230), pox_cycle: 159 },
  },
};

function createApi(overrides = {}) {
  const routes = {
    '/v2/pox': { first_burnchain_block_height: 666050, reward_cycle_length: 2100, prepare_phase_block_length: 100 },
    '/extended/v2/burn-blocks/latest': { burn_block_height: tipHeight, burn_block_time: tipTime },
    [`/extended/v2/burn-blocks/${tipHeight - 2016}`]: { burn_block_height: tipHeight - 2016, burn_block_time: tipTime - pace * 2016 },
    '/extended/v3/staking/cycles/current': current,
    '/extended/v3/staking/bonds/3': bond,
    ...overrides,
  };
  const calls = [];
  const context = { fetch: async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.hiro.so');
    assert.equal(options.cache, 'no-store');
    const path = url.slice('https://api.hiro.so'.length);
    calls.push(path);
    assert.ok(Object.hasOwn(routes, path), `Unexpected request: ${path}`);
    const entry = typeof routes[path] === 'function' ? await routes[path]() : routes[path];
    const status = typeof entry === 'number' ? entry : 200;
    return { ok: status === 200, status, json: async () => structuredClone(entry) };
  } };
  vm.runInNewContext(source, context);
  return { api: context.StacksCycles, calls, routes };
}

test('live cycle and pace come entirely from Hiro, without a legacy current_cycle_id', async () => {
  const { api, calls } = createApi();
  const [info, sameInfo] = await Promise.all([api.getInfo(), api.getInfo()]);
  assert.equal(info, sameInfo);
  assert.equal(info.current_cycle_id, 145);
  assert.equal(info.btc_tip_height, tipHeight);
  assert.equal(info.btc_tip_timestamp, toIso(tipTime));
  assert.equal(info.avg_block_seconds, pace);
  const cycle = await api.getCurrent();
  assert.equal(cycle.status, 'current');
  assert.equal(cycle.start.timestamp, current.schedule.start.time_iso);
  assert.equal(cycle.prepare.timestamp, current.schedule.prepare_phase_start.projected_time_iso);
  assert.equal(cycle.end.timestamp, current.schedule.end.projected_time_iso);
  assert.equal(cycle.progress.blocks_elapsed, 654);
  assert.equal(cycle.progress.in_prepare_phase, false);
  assert.equal(calls.length, 4);
});

test('bond detail uses the API index unchanged and accepts projected schedules without parameters', async () => {
  const { api, calls } = createApi();
  const result = await api.getBond(3);
  assert.equal(result.number, 3);
  assert.equal(result.status, 'projected');
  assert.equal(result.cycle, 147);
  assert.equal(result.start.timestamp, bond.schedule.activation.projected_time_iso);
  assert.equal(result.enrollmentClose.block, 974650);
  assert.equal(result.unlock.block, 999950);
  assert.deepEqual(calls, ['/extended/v3/staking/bonds/3']);
});

test('schedule timestamps prefer mined times, accept numeric seconds, and preserve null dates', async () => {
  const changed = structuredClone(bond);
  changed.schedule.activation = { bitcoin_height: 974750, pox_cycle: 147, time: 1700000000, projected_time: 1800000000 };
  changed.schedule.enrollment_cutoff = { bitcoin_height: 974650, projected_time: 1800000000 };
  changed.schedule.unlock = schedulePoint(999950, null);
  const { api } = createApi({ '/extended/v3/staking/bonds/3': changed });
  const result = await api.getBond(3);
  assert.equal(result.start.timestamp, toIso(1700000000));
  assert.equal(result.start.forecast, false);
  assert.equal(result.enrollmentClose.timestamp, toIso(1800000000));
  assert.equal(result.enrollmentClose.forecast, true);
  assert.equal(result.unlock.timestamp, null);
});

test('bond list adapts schedules and preserves opaque pagination cursors', async () => {
  const path = '/extended/v3/staking/bonds?limit=50&cursor=3%3Aolder';
  const { api, calls } = createApi({ [path]: { cursor: { next: 'next' }, results: [bond] } });
  const page = await api.listBonds({ cursor: '3:older' });
  assert.equal(page.results[0].number, 3);
  assert.equal(page.results[0].start.block, 974750);
  assert.equal(page.cursor.next, 'next');
  assert.deepEqual(calls, [path]);
});

test('future and finished cycles retain API boundaries instead of recomputing them', async () => {
  const future = { number: 147, status: 'upcoming', schedule: {
    start: schedulePoint(974751, null, 1800000000),
    prepare_phase_start: schedulePoint(976730, null, 1801000000),
    end: schedulePoint(976848, null, 1802000000),
  } };
  const { api } = createApi({
    '/extended/v3/staking/cycles/147': future,
    '/extended/v3/staking/cycles/144': { ...future, number: 144, status: 'finished' },
  });
  const result = await api.getCycle(147);
  assert.equal(result.status, 'future');
  assert.equal(result.start.block, 974751);
  assert.equal(result.prepare.block, 976730);
  assert.equal(result.end.block, 976848);
  assert.equal(result.prepare.anchors_cycle, 148);
  assert.equal((await api.getCycle(144)).status, 'past');
});

test('block lookups at cycle boundaries reuse API dates, including unavailable dates', async () => {
  const changed = structuredClone(current);
  changed.schedule.end = schedulePoint(972649, null);
  const { api, calls } = createApi({ '/extended/v3/staking/cycles/current': changed });
  const result = await api.getBlock(972550);
  assert.equal(result.timestamp, current.schedule.prepare_phase_start.projected_time_iso);
  assert.equal(result.phase, 'prepare');
  assert.equal(result.anchors_cycle, 146);
  assert.equal((await api.getBlock(972649)).timestamp, null);
  assert.equal(calls.length, 4);
});

test('arbitrary forecasts match upstream rounding and switch pace at the first retarget block', async () => {
  const { api } = createApi();
  for (const [height, expected] of [
    [971204, tipTime + 541],
    [971711, tipTime + 508 * pace],
    [971712, tipTime + 508 * pace + 600],
    [971713, tipTime + 508 * pace + 1200],
    [1000000, tipTime + 508 * pace + (1000000 - 971711) * 600],
  ]) {
    const result = await api.getBlock(height);
    assert.equal(result.timestamp, toIso(expected));
    assert.equal(result.forecast, true);
  }
});

test('a tip at the retarget starts a new measured-pace period', async () => {
  const { api } = createApi({
    '/extended/v2/burn-blocks/latest': { burn_block_height: 971712, burn_block_time: tipTime },
    '/extended/v2/burn-blocks/969696': { burn_block_height: 969696, burn_block_time: tipTime - 2016 * 720 },
  });
  assert.equal((await api.getBlock(971713)).timestamp, toIso(tipTime + 720));
});

test('unavailable or non-positive pace falls back to the target without replacing API schedules', async () => {
  for (const sample of [404, 503, { burn_block_height: tipHeight - 2016, burn_block_time: tipTime + 1 }]) {
    const { api } = createApi({ [`/extended/v2/burn-blocks/${tipHeight - 2016}`]: sample });
    const info = await api.getInfo();
    assert.equal(info.avg_block_seconds, 600);
    assert.match(info.avg_block_source, /fallback/);
    assert.equal((await api.getBlock(971204)).timestamp, toIso(tipTime + 600));
    assert.equal((await api.getCurrent()).prepare.timestamp, current.schedule.prepare_phase_start.projected_time_iso);
  }
});

test('known historical blocks use Hiro and missing historical blocks are not forecast', async () => {
  const { api } = createApi({
    '/extended/v2/burn-blocks/970600': { burn_block_time: 1791506000 },
    '/extended/v2/burn-blocks/970601': 404,
    '/extended/v2/burn-blocks/970602': 503,
  });
  const result = await api.getBlock(970600);
  assert.equal(result.timestamp, toIso(1791506000));
  assert.equal(result.forecast, false);
  assert.equal((await api.getBlock(970601)).timestamp, null);
  await assert.rejects(api.getBlock(970602), /503/);
});

test('out-of-range projections return no date and invalid inputs make no requests', async () => {
  const { api, calls } = createApi();
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(api.getBlock(invalid));
    await assert.rejects(api.getCycle(invalid));
    await assert.rejects(api.getBond(invalid));
  }
  assert.equal(calls.length, 0);
  assert.equal((await api.getBlock(1000000000)).timestamp, null);
  assert.equal((await api.getBlock(666049)).reason, 'before-pox');
});

test('API failures are retriable and never synthesize a local bond or cycle', async () => {
  const { api, routes } = createApi({ '/extended/v3/staking/bonds/3': 503, '/extended/v3/staking/cycles/147': 404 });
  await assert.rejects(api.getBond(3), /503/);
  routes['/extended/v3/staking/bonds/3'] = bond;
  assert.equal((await api.getBond(3)).number, 3);
  await assert.rejects(api.getCycle(147), /404/);
});

test('failed info requests reset the in-flight promise for recovery', async () => {
  const { api, routes } = createApi({ '/extended/v2/burn-blocks/latest': 503 });
  await assert.rejects(api.getInfo(), /503/);
  routes['/extended/v2/burn-blocks/latest'] = { burn_block_height: tipHeight, burn_block_time: tipTime };
  assert.equal((await api.getInfo()).btc_tip_height, tipHeight);
});

test('refresh invalidates cached schedules, deduplicates concurrent loads, and preserves fractional pace', async () => {
  const { api, routes, calls } = createApi();
  await api.getInfo();
  await Promise.all([api.getBond(3), api.getBond(3)]);
  assert.equal(calls.filter(path => path.endsWith('/bonds/3')).length, 1);
  const changed = structuredClone(bond);
  changed.schedule.activation.projected_time_iso = '2026-11-07T18:53:50.000Z';
  routes['/extended/v3/staking/bonds/3'] = changed;
  const [info, second] = await Promise.all([api.getInfo({ force: true }), api.getInfo({ force: true })]);
  assert.equal(info, second);
  assert.equal(info.avg_block_seconds, pace);
  assert.equal((await api.getBond(3)).start.timestamp, changed.schedule.activation.projected_time_iso);
  assert.equal(calls.filter(path => path === '/v2/pox').length, 2);
});
