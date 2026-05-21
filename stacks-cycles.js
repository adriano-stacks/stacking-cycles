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

  // Mainnet PoX constants — used only when Hiro is unreachable.
  const FALLBACK_REWARD_CYCLE_LENGTH = 2100;
  const FALLBACK_PREPARE_PHASE_LENGTH = 100;
  const FALLBACK_FIRST_BURN_HEIGHT = 666050;

  const DEFAULT_BLOCK_MS = 600_000; // 10 min/block — used only if mempool is unreachable.

  // ---------- module state ----------
  let cachedInfo = null;          // last resolved info object (returned to callers)
  let inFlightInfo = null;        // de-duplicates concurrent getInfo() calls
  let btcTipMs = null;            // raw ms timestamp of the BTC tip (internal)
  let avgBlockMs = DEFAULT_BLOCK_MS; // raw ms-per-block average (internal)
  const heightCache = new Map();  // height → ms timestamp (mempool block lookups)

  // ---------- helpers ----------
  function iso(ms) {
    return ms == null ? null : new Date(ms).toISOString();
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.json();
  }

  // ---------- low-level fetchers ----------
  async function fetchPox() {
    try {
      const d = await fetchJson(HIRO_POX);
      return {
        reward_cycle_length: d.reward_cycle_length,
        prepare_phase_block_length: d.prepare_phase_block_length,
        first_burnchain_block_height: d.first_burnchain_block_height,
        current_burnchain_block_height: d.current_burnchain_block_height,
        current_cycle_id: d.current_cycle_id,
        ok: true,
      };
    } catch (e) {
      return {
        reward_cycle_length: FALLBACK_REWARD_CYCLE_LENGTH,
        prepare_phase_block_length: FALLBACK_PREPARE_PHASE_LENGTH,
        first_burnchain_block_height: FALLBACK_FIRST_BURN_HEIGHT,
        current_burnchain_block_height: null,
        current_cycle_id: null,
        ok: false,
        error: String(e.message || e),
      };
    }
  }

  // Returns the difficulty-epoch average block interval, or null on failure.
  async function fetchDifficultyAvgMs() {
    try {
      const d = await fetchJson(`${MEMPOOL}/v1/difficulty-adjustment`);
      if (d.timeAvg > 60_000 && d.timeAvg < 1_800_000) return d.timeAvg;
    } catch (_) { /* fall through */ }
    return null;
  }

  // Returns { tipHeight, tipMs, recentAvgMs } from mempool's recent blocks list.
  // Populates heightCache as a side effect. Returns null fields on failure.
  async function fetchRecentBlocks() {
    try {
      const blocks = await fetchJson(`${MEMPOOL}/v1/blocks`);
      for (const b of blocks) heightCache.set(b.height, b.timestamp * 1000);
      if (!blocks.length) return { tipHeight: null, tipMs: null, recentAvgMs: null };
      const tipHeight = blocks[0].height;
      const tipMs = blocks[0].timestamp * 1000;
      let recentAvgMs = null;
      if (blocks.length >= 5) {
        const span = (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) * 1000;
        recentAvgMs = span / (blocks.length - 1);
      }
      return { tipHeight, tipMs, recentAvgMs };
    } catch (_) {
      return { tipHeight: null, tipMs: null, recentAvgMs: null };
    }
  }

  // Combines the two mempool calls into a single rate summary.
  async function fetchBtcRate() {
    const [diffAvgMs, tip] = await Promise.all([
      fetchDifficultyAvgMs(),
      fetchRecentBlocks(),
    ]);
    if (diffAvgMs != null) {
      return { avgMs: diffAvgMs, source: 'mempool.space difficulty-epoch average', ok: true, ...tip };
    }
    if (tip.recentAvgMs != null) {
      return { avgMs: tip.recentAvgMs, source: 'mempool.space recent blocks', ok: true, ...tip };
    }
    return { avgMs: DEFAULT_BLOCK_MS, source: 'fallback (10:00 min/block)', ok: false, ...tip };
  }

  async function fetchBlockTimestamp(height) {
    if (heightCache.has(height)) return heightCache.get(height);
    try {
      const hashRes = await fetch(`${MEMPOOL}/block-height/${height}`);
      if (!hashRes.ok) throw new Error('hash ' + hashRes.status);
      const hash = (await hashRes.text()).trim();
      const blk = await fetchJson(`${MEMPOOL}/block/${hash}`);
      const ms = blk.timestamp * 1000;
      heightCache.set(height, ms);
      return ms;
    } catch (_) {
      return null;
    }
  }

  // ---------- public: getInfo ----------
  async function getInfo({ force = false } = {}) {
    if (cachedInfo && !force) return cachedInfo;
    if (inFlightInfo && !force) return inFlightInfo;
    inFlightInfo = (async () => {
      const [pox, rate] = await Promise.all([fetchPox(), fetchBtcRate()]);
      const currentBurn = pox.current_burnchain_block_height ?? rate.tipHeight;
      let currentCycle = pox.current_cycle_id;
      if (currentCycle == null && currentBurn != null) {
        currentCycle = Math.floor((currentBurn - pox.first_burnchain_block_height) / pox.reward_cycle_length);
      }
      // Stash raw ms values in module state so the public info stays clean.
      btcTipMs = rate.tipMs;
      avgBlockMs = rate.avgMs;
      cachedInfo = {
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
      };
      inFlightInfo = null;
      return cachedInfo;
    })();
    return inFlightInfo;
  }

  // ---------- pure math ----------
  function cycleHeights(info, cycleId) {
    const start = info.first_burnchain_block_height + cycleId * info.reward_cycle_length;
    const prepareStart = start + info.reward_phase_block_length;
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
    const isPrepare = offIn >= info.reward_cycle_length - info.prepare_phase_block_length;
    return {
      valid: true,
      cycle_id: cycleId,
      block_in_cycle: offIn + 1,
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
    if (baseHeight == null) return { ms: null, timestamp: null, forecast: true };
    const baseMs = btcTipMs ?? Date.now();
    const ms = baseMs + (height - baseHeight) * avgBlockMs;
    return { ms, timestamp: iso(ms), forecast: true };
  }

  function pointFor(block, ts) {
    return { block, timestamp: ts.timestamp, forecast: ts.forecast };
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

    let status;
    if (id < info.current_cycle_id)      status = 'past';
    else if (id > info.current_cycle_id) status = 'future';
    else                                 status = 'current';

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
      start: pointFor(h.start, startTs),
      end:   pointFor(h.end,   endTs),
      prepare: { ...pointFor(h.prepareStart, prepTs), anchors_cycle: id + 1 },
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
  const StacksCycles = { getInfo, getCurrent, getCycle, getBlock };
  global.StacksCycles = StacksCycles;
  if (typeof module !== 'undefined' && module.exports) module.exports = StacksCycles;
})(typeof window !== 'undefined' ? window : globalThis);
