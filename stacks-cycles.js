/*!
 * stacks-cycles — A tiny library for Stacks reward-cycle math, live data, and
 * Bitcoin block date forecasts. Browser + Node. No build step.
 *
 *   await StacksCycles.getInfo()             → constants + live BTC tip + block rate
 *   await StacksCycles.getCurrent()          → the active reward cycle, fully resolved
 *   await StacksCycles.getCycle(135)         → any cycle by id, past or future
 *   await StacksCycles.getBlock(1_000_000)   → date, cycle, phase for any BTC block
 *
 * Past timestamps are confirmed from mempool.space. Future timestamps are
 * projected from the live BTC tip using the current difficulty epoch's average
 * block interval — same number you'd read off mempool's difficulty-adjustment.
 */
;(function (global) {
  'use strict';

  const HIRO_POX = 'https://api.hiro.so/v2/pox';
  const MEMPOOL = 'https://mempool.space/api';

  const MAINNET_FALLBACK = Object.freeze({
    reward_cycle_length: 2100,
    prepare_phase_block_length: 100,
    first_burnchain_block_height: 666050,
  });

  // ---------- module state ----------
  let _info = null;
  let _infoPromise = null;
  const _heightCache = new Map(); // height → ms timestamp

  // ---------- helpers ----------
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

  // ---------- low-level fetchers ----------
  async function fetchPox() {
    try {
      const r = await fetch(HIRO_POX, { cache: 'no-store' });
      if (!r.ok) throw new Error('hiro ' + r.status);
      const d = await r.json();
      return {
        reward_cycle_length: d.reward_cycle_length,
        prepare_phase_block_length: d.prepare_phase_block_length,
        first_burnchain_block_height: d.first_burnchain_block_height,
        current_burnchain_block_height: d.current_burnchain_block_height,
        current_cycle_id: d.current_cycle_id,
        ok: true,
      };
    } catch (e) {
      return { ...MAINNET_FALLBACK, current_burnchain_block_height: null, current_cycle_id: null, ok: false, error: String(e.message || e) };
    }
  }

  async function fetchBtcRate() {
    const out = { avgMs: 600_000, source: 'fallback (10:00 min/block)', tipHeight: null, tipMs: null, ok: false };
    try {
      const r = await fetch(`${MEMPOOL}/v1/difficulty-adjustment`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d.timeAvg && d.timeAvg > 60_000 && d.timeAvg < 1_800_000) {
          out.avgMs = d.timeAvg;
          out.source = 'mempool.space difficulty-epoch average';
          out.ok = true;
        }
      }
    } catch (_) { /* fall through */ }
    try {
      const r = await fetch(`${MEMPOOL}/v1/blocks`, { cache: 'no-store' });
      if (r.ok) {
        const blocks = await r.json();
        for (const b of blocks) _heightCache.set(b.height, b.timestamp * 1000);
        if (blocks.length) {
          out.tipHeight = blocks[0].height;
          out.tipMs = blocks[0].timestamp * 1000;
          if (!out.ok && blocks.length >= 5) {
            const span = (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) * 1000;
            out.avgMs = span / (blocks.length - 1);
            out.source = `mempool.space last ${blocks.length} blocks`;
            out.ok = true;
          }
        }
      }
    } catch (_) { /* fall through */ }
    return out;
  }

  async function fetchBlockTimestamp(height) {
    if (_heightCache.has(height)) return _heightCache.get(height);
    try {
      const hashRes = await fetch(`${MEMPOOL}/block-height/${height}`);
      if (!hashRes.ok) throw new Error('hash ' + hashRes.status);
      const hash = (await hashRes.text()).trim();
      const blkRes = await fetch(`${MEMPOOL}/block/${hash}`);
      if (!blkRes.ok) throw new Error('block ' + blkRes.status);
      const blk = await blkRes.json();
      const ms = blk.timestamp * 1000;
      _heightCache.set(height, ms);
      return ms;
    } catch (_) {
      return null;
    }
  }

  // ---------- public: getInfo ----------
  async function getInfo({ force = false } = {}) {
    if (_info && !force) return _info;
    if (_infoPromise && !force) return _infoPromise;
    _infoPromise = (async () => {
      const [pox, rate] = await Promise.all([fetchPox(), fetchBtcRate()]);
      const currentBurn = pox.current_burnchain_block_height ?? rate.tipHeight;
      const currentCycle = pox.current_cycle_id ?? (currentBurn != null
        ? Math.floor((currentBurn - pox.first_burnchain_block_height) / pox.reward_cycle_length)
        : null);
      const info = {
        network: 'mainnet',
        reward_cycle_length: pox.reward_cycle_length,
        prepare_phase_block_length: pox.prepare_phase_block_length,
        reward_phase_block_length: pox.reward_cycle_length - pox.prepare_phase_block_length,
        first_burnchain_block_height: pox.first_burnchain_block_height,
        current_burn_block_height: currentBurn,
        current_cycle_id: currentCycle,
        btc_tip_height: rate.tipHeight,
        btc_tip_timestamp: iso(rate.tipMs),
        avg_block_seconds: Math.round(rate.avgMs / 1000),
        avg_block_source: rate.source,
        sources: { pox: pox.ok ? 'hiro' : 'fallback', btc: rate.ok ? 'mempool.space' : 'fallback' },
        fetched_at: iso(Date.now()),
        // raw ms — non-enumerable for clients that want it, but kept on the object
        _avg_block_ms: rate.avgMs,
        _btc_tip_ms: rate.tipMs,
      };
      _info = info;
      _infoPromise = null;
      return info;
    })();
    return _infoPromise;
  }

  // ---------- pure math ----------
  function cycleHeights(info, cycleId) {
    const start = info.first_burnchain_block_height + cycleId * info.reward_cycle_length;
    const prepareStart = start + (info.reward_cycle_length - info.prepare_phase_block_length);
    const end = start + info.reward_cycle_length - 1;
    return { start, prepareStart, end };
  }

  function blockPhase(info, height) {
    if (height < info.first_burnchain_block_height) {
      return {
        valid: false,
        reason: 'before-pox',
        message: `Below first PoX block ${info.first_burnchain_block_height}`,
      };
    }
    const off = height - info.first_burnchain_block_height;
    const cycleId = Math.floor(off / info.reward_cycle_length);
    const offIn = off % info.reward_cycle_length;
    const isPrepare = offIn >= (info.reward_cycle_length - info.prepare_phase_block_length);
    return {
      valid: true,
      cycle_id: cycleId,
      block_in_cycle: offIn + 1,
      offset_in_cycle: offIn,
      phase: isPrepare ? 'prepare' : 'reward',
      anchors_cycle: isPrepare ? cycleId + 1 : null,
    };
  }

  async function timestampForBlock(info, height) {
    if (info.current_burn_block_height != null && height <= info.current_burn_block_height) {
      const ms = await fetchBlockTimestamp(height);
      return { ms, timestamp: iso(ms), forecast: false };
    }
    const baseHeight = info.btc_tip_height ?? info.current_burn_block_height;
    const baseMs = info._btc_tip_ms ?? Date.now();
    if (baseHeight == null) return { ms: null, timestamp: null, forecast: true };
    const ms = baseMs + (height - baseHeight) * info._avg_block_ms;
    return { ms, timestamp: iso(ms), forecast: true };
  }

  // ---------- public: getCycle / getCurrent ----------
  async function getCycle(id) {
    if (!Number.isInteger(id) || id < 0) throw new Error('cycle id must be a non-negative integer');
    const info = await getInfo();
    const h = cycleHeights(info, id);
    const [startTs, prepTs, endTs] = await Promise.all([
      timestampForBlock(info, h.start),
      timestampForBlock(info, h.prepareStart),
      timestampForBlock(info, h.end),
    ]);
    const status = id < info.current_cycle_id ? 'past'
                 : id > info.current_cycle_id ? 'future'
                 : 'current';
    let progress = null;
    if (status === 'current' && info.current_burn_block_height != null) {
      const elapsed = info.current_burn_block_height - h.start + 1;
      progress = {
        blocks_elapsed: elapsed,
        blocks_remaining: h.end - info.current_burn_block_height,
        percent_complete: +(elapsed / info.reward_cycle_length * 100).toFixed(3),
        in_prepare_phase: info.current_burn_block_height >= h.prepareStart,
      };
    }
    return {
      cycle_id: id,
      status,
      total_blocks: info.reward_cycle_length,
      reward_phase: {
        start_block: h.start,
        end_block: h.prepareStart - 1,
        block_count: info.reward_phase_block_length,
        start_timestamp: startTs.timestamp,
        forecast: startTs.forecast,
      },
      prepare_phase: {
        start_block: h.prepareStart,
        end_block: h.end,
        block_count: info.prepare_phase_block_length,
        anchors_cycle: id + 1,
        start_timestamp: prepTs.timestamp,
        forecast: prepTs.forecast,
      },
      start: { block: h.start, timestamp: startTs.timestamp, forecast: startTs.forecast },
      end:   { block: h.end,   timestamp: endTs.timestamp,   forecast: endTs.forecast },
      duration_seconds: startTs.ms != null && endTs.ms != null
        ? Math.round((endTs.ms - startTs.ms) / 1000)
        : null,
      progress,
    };
  }

  async function getCurrent() {
    const info = await getInfo();
    if (info.current_cycle_id == null) throw new Error('current cycle unknown — no live data');
    return getCycle(info.current_cycle_id);
  }

  // ---------- public: getBlock ----------
  async function getBlock(height) {
    if (!Number.isInteger(height) || height < 0) throw new Error('block height must be a non-negative integer');
    const info = await getInfo();
    const ph = blockPhase(info, height);
    if (!ph.valid) {
      return { block: height, valid: false, reason: ph.reason, message: ph.message };
    }
    const ts = await timestampForBlock(info, height);
    return {
      block: height,
      valid: true,
      timestamp: ts.timestamp,
      forecast: ts.forecast,
      cycle_id: ph.cycle_id,
      block_in_cycle: ph.block_in_cycle,
      phase: ph.phase,
      ...(ph.anchors_cycle != null && { anchors_cycle: ph.anchors_cycle }),
    };
  }

  // ---------- export ----------
  const StacksCycles = {
    getInfo, getCurrent, getCycle, getBlock,
    // exposed for advanced consumers
    cycleHeights, blockPhase, timestampForBlock,
    MAINNET_FALLBACK,
  };
  global.StacksCycles = StacksCycles;
  if (typeof module !== 'undefined' && module.exports) module.exports = StacksCycles;
})(typeof window !== 'undefined' ? window : globalThis);
