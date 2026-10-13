;(function (global) {
  'use strict';

  const DAY_MS = 86_400_000;
  const OPEN_LEAD_DAYS = 7;

  function validateBond(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 10000) {
      throw new Error('Enter a bond number from 1 to 10,000.');
    }
  }

  async function upcomingBond(info, api = global.StacksCycles) {
    if (!Number.isSafeInteger(info.current_burn_block_height) || info.current_burn_block_height < 0) {
      throw new Error('Live block data is unavailable. Please try again.');
    }
    let cursor = null;
    let lastStarted = 0;
    const published = new Map();
    do {
      const page = await api.listBonds({ cursor });
      for (const bond of page.results) {
        published.set(bond.number, bond);
        if (bond.start.block <= info.current_burn_block_height) lastStarted = Math.max(lastStarted, bond.number);
      }
      cursor = page.cursor.next;
    } while (cursor != null);
    if (!published.size) throw new Error('No bond schedules are available from the Stacks API.');
    const isFuture = async number => {
      try {
        const bond = published.get(number) ?? await api.getBond(number);
        return bond.start.block > info.current_burn_block_height;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    };
    let lower = lastStarted;
    let upper = lastStarted + 1;
    while (upper <= 10000) {
      if (await isFuture(upper)) {
        while (upper - lower > 1) {
          const middle = Math.floor((lower + upper) / 2);
          if (await isFuture(middle)) upper = middle;
          else lower = middle;
        }
        return upper;
      }
      if (upper === 10000) break;
      lower = upper;
      upper = Math.min(10000, lastStarted + (upper - lastStarted) * 2);
    }
    throw new Error('No upcoming bond schedule is available from the Stacks API.');
  }

  async function getBonds(first, count = 6, api = global.StacksCycles) {
    validateBond(first);
    if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Show between 1 and 12 bonds.');
    return Promise.all(Array.from({ length: Math.min(count, 10001 - first) }, async (_, offset) => {
      const bond = await api.getBond(first + offset);
      const startMs = bond.start.timestamp ? Date.parse(bond.start.timestamp) : NaN;
      return {
        ...bond,
        opens: {
          timestamp: Number.isFinite(startMs) ? new Date(startMs - OPEN_LEAD_DAYS * DAY_MS).toISOString() : null,
          forecast: true,
        },
      };
    }));
  }

  const BondSchedule = { OPEN_LEAD_DAYS, upcomingBond, getBonds };
  global.BondSchedule = BondSchedule;
  if (typeof module !== 'undefined' && module.exports) module.exports = BondSchedule;
})(typeof window !== 'undefined' ? window : globalThis);
