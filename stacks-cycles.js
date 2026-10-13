;(function (global) {
  'use strict';

  const HIRO = 'https://api.hiro.so';
  const DIFFICULTY_PERIOD = 2016;
  const PACE_WINDOW = 2016;
  const TARGET_BLOCK_SECONDS = 600;
  const MAX_PROJECTION_SECONDS = 253_402_300_799;
  let cachedInfo = null;
  let inFlightInfo = null;
  let requests = new Map();

  function iso(seconds) {
    return Number.isFinite(seconds) && seconds <= MAX_PROJECTION_SECONDS
      ? new Date(seconds * 1000).toISOString() : null;
  }

  function fetchJson(path) {
    const cache = requests;
    if (cache.has(path)) return cache.get(path);
    const request = (async () => {
      const response = await fetch(`${HIRO}${path}`, { cache: 'no-store' });
      if (!response.ok) {
        const error = new Error(`Stacks API ${path} → ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    })();
    cache.set(path, request);
    request.catch(() => cache.delete(path));
    return request;
  }

  function schedulePoint(point) {
    const confirmed = point.time_iso ?? iso(point.time);
    return {
      block: point.bitcoin_height,
      timestamp: confirmed ?? point.projected_time_iso ?? iso(point.projected_time),
      forecast: confirmed == null,
    };
  }

  async function burnBlock(height) {
    try {
      return await fetchJson(`/extended/v2/burn-blocks/${height}`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async function blockPace(tip) {
    try {
      const start = await burnBlock(tip.burn_block_height - PACE_WINDOW);
      if (start) {
        const pace = (tip.burn_block_time - start.burn_block_time) /
          (tip.burn_block_height - start.burn_block_height);
        if (Number.isFinite(pace) && pace > 0) {
          return { seconds: pace, source: 'Stacks API trailing 2,016 Bitcoin blocks' };
        }
      }
    } catch (_) {}
    return { seconds: TARGET_BLOCK_SECONDS, source: 'target fallback (10 min/block; pace unavailable)' };
  }

  async function getInfo({ force = false } = {}) {
    if (inFlightInfo) return inFlightInfo;
    if (cachedInfo && !force) return cachedInfo;
    if (force) {
      cachedInfo = null;
      requests = new Map();
    }
    inFlightInfo = (async () => {
      const [pox, tip, current] = await Promise.all([
        fetchJson('/v2/pox'),
        fetchJson('/extended/v2/burn-blocks/latest'),
        fetchJson('/extended/v3/staking/cycles/current'),
      ]);
      if (!Number.isSafeInteger(tip.burn_block_height) || !Number.isFinite(tip.burn_block_time) ||
          !Number.isSafeInteger(current.number) || !Number.isSafeInteger(pox.first_burnchain_block_height) ||
          !Number.isSafeInteger(pox.reward_cycle_length) || pox.reward_cycle_length <= 0 ||
          !Number.isSafeInteger(pox.prepare_phase_block_length) || pox.prepare_phase_block_length < 0 ||
          pox.prepare_phase_block_length >= pox.reward_cycle_length) {
        throw new Error('Stacks API chain data is unavailable. Please try again.');
      }
      const pace = await blockPace(tip);
      requests.set(`/extended/v3/staking/cycles/${current.number}`, Promise.resolve(current));
      cachedInfo = {
        network: 'mainnet',
        reward_cycle_length: pox.reward_cycle_length,
        prepare_phase_block_length: pox.prepare_phase_block_length,
        reward_phase_block_length: pox.reward_cycle_length - pox.prepare_phase_block_length,
        first_burnchain_block_height: pox.first_burnchain_block_height,
        current_burn_block_height: tip.burn_block_height,
        current_cycle_id: current.number,
        btc_tip_height: tip.burn_block_height,
        btc_tip_timestamp: iso(tip.burn_block_time),
        avg_block_seconds: pace.seconds,
        avg_block_source: pace.source,
        sources: { pox: 'hiro', btc: 'hiro', schedules: 'hiro' },
        fetched_at: new Date().toISOString(),
      };
      return cachedInfo;
    })();
    try {
      return await inFlightInfo;
    } catch (error) {
      requests = new Map();
      throw error;
    } finally {
      inFlightInfo = null;
    }
  }

  async function getCycle(id) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('cycle id must be a non-negative safe integer');
    const info = await getInfo();
    const cycle = await fetchJson(`/extended/v3/staking/cycles/${id}`);
    const start = schedulePoint(cycle.schedule.start);
    const end = schedulePoint(cycle.schedule.end);
    const prepare = { ...schedulePoint(cycle.schedule.prepare_phase_start), anchors_cycle: cycle.number + 1 };
    const status = cycle.status === 'finished' ? 'past' : cycle.status === 'upcoming' ? 'future' : 'current';
    let progress = null;
    if (status === 'current') {
      const length = end.block - start.block + 1;
      const elapsed = Math.max(0, Math.min(length, info.current_burn_block_height - start.block + 1));
      progress = {
        blocks_elapsed: elapsed,
        blocks_remaining: Math.max(0, end.block - info.current_burn_block_height),
        percent_complete: +(elapsed / length * 100).toFixed(3),
        in_prepare_phase: info.current_burn_block_height >= prepare.block,
      };
    }
    return { cycle_id: cycle.number, status, start, end, prepare, progress };
  }

  async function getCurrent() {
    return getCycle((await getInfo()).current_cycle_id);
  }

  function normalizeBond(bond) {
    return {
      number: bond.index,
      status: bond.status,
      cycle: bond.schedule.activation.pox_cycle,
      start: schedulePoint(bond.schedule.activation),
      enrollmentClose: schedulePoint(bond.schedule.enrollment_cutoff),
      unlock: schedulePoint(bond.schedule.unlock),
    };
  }

  async function getBond(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('bond index must be a non-negative safe integer');
    return normalizeBond(await fetchJson(`/extended/v3/staking/bonds/${index}`));
  }

  async function listBonds({ cursor } = {}) {
    const query = cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const page = await fetchJson(`/extended/v3/staking/bonds?limit=50${query}`);
    return { ...page, results: page.results.map(normalizeBond) };
  }

  function projectBlock(info, height) {
    const nextRetarget = (Math.floor(info.btc_tip_height / DIFFICULTY_PERIOD) + 1) * DIFFICULTY_PERIOD;
    const blocksAtPace = Math.min(height, nextRetarget - 1) - info.btc_tip_height;
    const blocksAtTarget = Math.max(0, height - (nextRetarget - 1));
    const seconds = Math.round(Date.parse(info.btc_tip_timestamp) / 1000 +
      blocksAtPace * info.avg_block_seconds + blocksAtTarget * TARGET_BLOCK_SECONDS);
    return iso(seconds);
  }

  async function getBlock(height) {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error('block height must be a non-negative safe integer');
    const info = await getInfo();
    if (height < info.first_burnchain_block_height) {
      return {
        block: height, valid: false, reason: 'before-pox',
        message: `Below first PoX block ${info.first_burnchain_block_height}`,
      };
    }
    const offset = height - info.first_burnchain_block_height;
    const cycleId = Math.floor(offset / info.reward_cycle_length);
    const blockInCycle = offset % info.reward_cycle_length;
    const isPrepare = blockInCycle >= info.reward_phase_block_length;
    let point;
    if (blockInCycle === 0 || blockInCycle === info.reward_phase_block_length ||
        blockInCycle === info.reward_cycle_length - 1) {
      const cycle = await getCycle(cycleId);
      point = [cycle.start, cycle.prepare, cycle.end].find(candidate => candidate.block === height);
    }
    if (!point) {
      if (height <= info.btc_tip_height) {
        const block = await burnBlock(height);
        point = { timestamp: block?.burn_block_time_iso ?? iso(block?.burn_block_time), forecast: false };
      } else {
        point = { timestamp: projectBlock(info, height), forecast: true };
      }
    }
    return {
      block: height, valid: true, timestamp: point.timestamp, forecast: point.forecast,
      cycle_id: cycleId, block_in_cycle: blockInCycle + 1, phase: isPrepare ? 'prepare' : 'reward',
      ...(isPrepare && { anchors_cycle: cycleId + 1 }),
    };
  }

  const StacksCycles = { getInfo, getCurrent, getCycle, getBlock, getBond, listBonds };
  global.StacksCycles = StacksCycles;
  if (typeof module !== 'undefined' && module.exports) module.exports = StacksCycles;
})(typeof window !== 'undefined' ? window : globalThis);
