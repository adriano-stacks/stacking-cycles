(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en-US');
  const state = { bonds: [], generation: 0 };

  function writeHash() {
    history.replaceState(null, '', `#tz=${$('timezone').value}`);
  }

  function dateContent(point) {
    const content = document.createElement('div');
    const ms = point.timestamp ? Date.parse(point.timestamp) : NaN;
    if (!Number.isFinite(ms)) {
      content.textContent = 'Date unavailable';
      return content;
    }
    const date = new Date(ms);
    const zone = $('timezone').value === 'utc' ? { timeZone: 'UTC' } : {};
    const time = document.createElement('time');
    time.dateTime = point.timestamp;
    time.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...zone });
    content.append(time);
    const detail = document.createElement('span');
    detail.className = 'bond-date-detail';
    detail.textContent = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', ...zone });
    content.append(detail);
    if (ms <= Date.now()) content.classList.add('date-passed');
    return content;
  }

  function dateStatus(point, operational = false) {
    const status = document.createElement('span');
    status.className = 'bond-date-status';
    status.textContent = operational ? 'Expected' : (point.forecast ? 'Projected' : 'Confirmed block');
    return status;
  }

  function dateCell(point, label, operational = false) {
    const td = document.createElement('td');
    td.dataset.label = label;
    const status = dateStatus(point, operational);
    status.classList.add('mobile-date-status');
    td.append(status, dateContent(point));
    return td;
  }

  function countdown(timestamp) {
    if (!timestamp) return 'Timing unavailable';
    const delta = Date.parse(timestamp) - Date.now();
    if (delta <= 0) return 'Estimated date has passed';
    const hours = Math.floor(delta / 3600000);
    return hours >= 24 ? `In ${Math.floor(hours / 24)}d ${hours % 24}h` : hours > 0 ? `In ${hours}h` : 'In less than an hour';
  }

  function renderNext(bond) {
    $('next-bond-title').textContent = `Bond ${bond.number}`;
    const milestones = [
      {
        label: 'Bond is announced', point: bond.opens, operational: true,
        note: 'Stacks Endowment announces the bond parameters.',
        detail: `${BondSchedule.OPEN_LEAD_DAYS} days before the bond opens`
      },
      {
        label: 'Enrollment closes', point: bond.enrollmentClose,
        note: 'Deadline to complete enrollment.',
        detail: `Before BTC block ${fmt.format(bond.enrollmentClose.block)}`
      },
      {
        label: 'Bond opens', point: bond.start,
        note: 'The bond’s begins accruing rewards: ', cycle: bond.cycle,
        detail: `BTC block ${fmt.format(bond.start.block)}`
      },
    ];
    const cards = document.createDocumentFragment();
    for (const milestone of milestones) {
      const card = document.createElement('div');
      card.className = 'phase-cell bond-milestone';
      const title = document.createElement('h3');
      title.className = 'kicker';
      title.textContent = milestone.label;
      const relative = document.createElement('div');
      relative.className = 'bond-countdown';
      relative.textContent = countdown(milestone.point.timestamp);
      const note = document.createElement('p');
      note.className = 'bond-milestone-note';
      note.textContent = milestone.note;
      if (milestone.cycle != null) {
        const link = document.createElement('a');
        link.href = `index.html#cycle=${milestone.cycle}`;
        link.textContent = `cycle ${milestone.cycle}`;
        note.append(link, '.');
      }
      const detail = document.createElement('div');
      detail.className = 'bond-milestone-detail';
      detail.textContent = milestone.detail;
      const metadata = document.createElement('div');
      metadata.className = 'bond-milestone-meta';
      metadata.append(dateStatus(milestone.point, milestone.operational), detail);
      card.append(title, metadata, dateContent(milestone.point), relative, note);
      cards.append(card);
    }
    $('bond-milestones').replaceChildren(cards);
    $('next-bond').hidden = false;
  }

  function render() {
    const [next, ...later] = state.bonds;
    renderNext(next);
    const rows = document.createDocumentFragment();
    for (const bond of later) {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      const name = document.createElement('strong');
      name.textContent = `Bond ${bond.number}`;
      heading.append(name);
      row.append(heading,
        dateCell(bond.opens, 'Bond is announced', true),
        dateCell(bond.enrollmentClose, 'Enrollment closes'),
        dateCell(bond.start, 'Bond opens'));
      rows.append(row);
    }
    $('bond-rows').replaceChildren(rows);
    $('schedule-status').hidden = true;
  }

  async function load(force = false) {
    const generation = ++state.generation;
    $('schedule').setAttribute('aria-busy', 'true');
    $('schedule-status').hidden = false;
    $('schedule-status').textContent = 'Loading bond dates…';
    $('schedule-error').hidden = true;
    try {
      const info = await StacksCycles.getInfo({ force });
      const first = BondSchedule.upcomingBond(info);
      const bonds = await BondSchedule.getBonds(first, 6);
      if (generation !== state.generation) return;
      if (!bonds[0].start.timestamp) throw new Error('Bond dates are unavailable. Please refresh to try again.');
      state.bonds = bonds;
      render();
      writeHash();
      const fallback = info.sources.pox === 'fallback' || info.sources.btc === 'fallback' || info.btc_tip_height == null;
      $('status-dot').className = `status-dot ${fallback ? '' : 'live'}`;
      $('status-text').textContent = fallback ? 'Mainnet · using fallback data' : `Mainnet · BTC tip ${fmt.format(info.btc_tip_height)}`;
    } catch (error) {
      if (generation !== state.generation) return;
      $('schedule-error').textContent = error.message || 'Unable to load bond dates. Please try again.';
      $('schedule-error').hidden = false;
      $('schedule-status').textContent = state.bonds.length ? 'Showing the previous dates; the update failed.' : 'No dates loaded.';
      if (!state.bonds.length) {
        $('status-dot').className = 'status-dot err';
        $('status-text').textContent = 'Data unavailable';
      }
    } finally {
      if (generation === state.generation) $('schedule').setAttribute('aria-busy', 'false');
    }
  }

  $('refresh').addEventListener('click', () => load(true));
  $('timezone').addEventListener('change', () => { if (state.bonds.length) { render(); writeHash(); } });
  function loadHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    $('timezone').value = params.get('tz') === 'local' ? 'local' : 'utc';
    load();
  }
  window.addEventListener('hashchange', loadHash);
  // Keep an open planning tab on the next bond as reward cycles advance.
  setInterval(() => { if (!document.hidden) load(true); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
  loadHash();
})();
