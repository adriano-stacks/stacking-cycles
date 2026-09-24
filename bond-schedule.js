/* Bond numbering follows the partner schedule: Genesis = bond 1, cycle 143.
 * Later bonds begin every two reward cycles. Operational lead times are
 * planning assumptions, not on-chain publication or partner completion data.
 */
;(function (global) {
  'use strict';

  const GENESIS_CYCLE = 143;
  const CYCLES_PER_BOND = 2;
  const DAY_MS = 86_400_000;
  const OPEN_LEAD_DAYS = 7;

  function startCycle(bond) {
    if (!Number.isSafeInteger(bond) || bond < 1 || bond > 10000) {
      throw new Error('Enter a bond number from 1 to 10,000.');
    }
    return GENESIS_CYCLE + (bond - 1) * CYCLES_PER_BOND;
  }

  function upcomingBond(info) {
    if (!Number.isSafeInteger(info.current_cycle_id) || info.current_cycle_id < 0) {
      throw new Error('Live cycle data is unavailable. Please try again.');
    }
    return Math.max(1, Math.floor((info.current_cycle_id - GENESIS_CYCLE) / CYCLES_PER_BOND) + 2);
  }

  async function getBonds(first, count = 6, api = global.StacksCycles) {
    startCycle(first);
    if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Show between 1 and 12 bonds.');
    const info = await api.getInfo();
    const bonds = await Promise.all(Array.from({ length: Math.min(count, 10001 - first) }, async (_, i) => {
      const number = first + i;
      const cycle = startCycle(number);
      const height = info.first_burnchain_block_height + cycle * info.reward_cycle_length;
      const [start, enrollmentClose] = await Promise.all([
        api.getBlock(height),
        api.getBlock(height - info.prepare_phase_block_length),
      ]);
      const startMs = start.timestamp ? Date.parse(start.timestamp) : NaN;
      const offset = days => Number.isFinite(startMs) ? new Date(startMs - days * DAY_MS).toISOString() : null;
      return {
        number, cycle, start, enrollmentClose,
        opens: { timestamp: offset(OPEN_LEAD_DAYS), forecast: true },
      };
    }));
    return bonds;
  }

  const BondSchedule = { OPEN_LEAD_DAYS, startCycle, upcomingBond, getBonds };
  global.BondSchedule = BondSchedule;
  if (typeof module !== 'undefined' && module.exports) module.exports = BondSchedule;
})(typeof window !== 'undefined' ? window : globalThis);
