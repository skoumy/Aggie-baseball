// =============================================================
// Texas A&M Baseball — Live tracker
// ESPN unofficial API: day-by-day scoreboard scan
// =============================================================

// Match A&M games by team name
const TEAM_RX = /texas\s*a\s*&\s*m|aggies/i;
// Skip false positives (other "Aggies": UC Davis, NM State, Utah State, etc.)
// We require "texas" OR the school's specific abbreviation "TA&M"/"TAMU".
const STRONG_RX = /texas\s*a\s*&\s*m|^ta&m$|^tamu$/i;

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';

const POLL_LIVE = 15_000;
const POLL_IDLE = 120_000;

// Optional proxy. Leave '' to call ESPN from the browser.
const API_BASE = '';

const $ = (id) => document.getElementById(id);
const url = (path) => (API_BASE ? `${API_BASE}${path}` : `${ESPN_SITE}${path}`);

let timer = null;
let eventCache = null;
let scheduleView = 'upcoming';
let lastPbpKey = '';

// ---------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------
async function fetchJSON(u, label) {
  try {
    const res = await fetch(u, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(label, err);
    throw err;
  }
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ESPN's scoreboard endpoint accepts a single date (?dates=YYYYMMDD).
// Scan a sliding window of recent + upcoming days and collect every A&M event.
// This is the same pattern diamondcollegebaseball.com uses.
async function fetchAggieEvents() {
  const today = new Date();
  const days = [];
  // 14 days back through 14 days ahead = 29 days (limits parallel requests)
  for (let i = -14; i <= 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }

  const fetches = days.map((d) =>
    fetchJSON(url(`/scoreboard?dates=${yyyymmdd(d)}`), `scoreboard ${yyyymmdd(d)}`)
      .catch((err) => {
        console.warn('Day fetch failed', yyyymmdd(d), err.message);
        return null;
      })
  );

  const results = await Promise.all(fetches);

  // Flatten + dedupe by event ID
  const seen = new Set();
  const events = [];
  for (const data of results) {
    if (!data?.events) continue;
    for (const ev of data.events) {
      if (seen.has(ev.id)) continue;
      const comps = ev.competitions?.[0]?.competitors || [];
      const isAggies = comps.some((c) => {
        const name = c.team?.displayName || '';
        const abbr = c.team?.abbreviation || '';
        const loc = c.team?.location || '';
        return STRONG_RX.test(name) || STRONG_RX.test(abbr) || STRONG_RX.test(loc);
      });
      if (isAggies) {
        seen.add(ev.id);
        events.push(ev);
      }
    }
  }
  return events;
}

async function fetchSummary(eventId) {
  return fetchJSON(url(`/summary?event=${eventId}`), 'summary');
}

// ---------------------------------------------------------------
// Game selection
// ---------------------------------------------------------------
function pickGame(events) {
  const live = events.find(e => e.competitions?.[0]?.status?.type?.state === 'in');
  if (live) return { game: live, state: 'in' };

  const now = Date.now();
  const upcoming = events
    .filter(e => new Date(e.date).getTime() > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (upcoming[0]) return { game: upcoming[0], state: 'pre' };

  const past = events
    .filter(e => e.competitions?.[0]?.status?.type?.state === 'post')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (past[0]) return { game: past[0], state: 'post' };

  return { game: null, state: 'none' };
}

const side = (competitors, which) => competitors.find(c => c.homeAway === which) || competitors[0];
const isAggiesTeam = (team) => STRONG_RX.test(team?.displayName || '') || STRONG_RX.test(team?.abbreviation || '') || STRONG_RX.test(team?.location || '');

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------
function setStatus(label, mode) {
  const pill = $('status-pill');
  pill.classList.remove('live', 'pre', 'post');
  if (mode) pill.classList.add(mode);
  $('status-text').textContent = label;
}

function setError(msg) {
  $('card-content').hidden = true;
  $('card-loading').hidden = false;
  $('card-loading').innerHTML = `
    <div style="text-align:left;max-width:480px;margin:0 auto;">
      <div style="color:#ef4444;font-weight:600;margin-bottom:8px;">⚠ Couldn't load data</div>
      <div style="color:#a08a78;font-size:12px;line-height:1.5;font-family:'Roboto Mono',monospace;word-break:break-all;">${msg}</div>
      <div style="color:#7a6557;font-size:11px;margin-top:12px;">
        Check the browser console (F12 / ⌥⌘I) for details.
      </div>
    </div>
  `;
}

function renderPips(elId, on, total, isOut = false) {
  const el = $(elId);
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const pip = document.createElement('span');
    pip.className = 'pip' + (i < on ? (isOut ? ' out' : ' on') : '');
    el.appendChild(pip);
  }
}

// ---------------------------------------------------------------
// Game card
// ---------------------------------------------------------------
function renderGame(competition, summary, state) {
  $('card-loading').hidden = true;
  $('card-content').hidden = false;

  const home = side(competition.competitors, 'home');
  const away = side(competition.competitors, 'away');

  $('home-logo').src = home.team.logo || '';
  $('away-logo').src = away.team.logo || '';
  $('home-name').textContent = home.team.shortDisplayName || home.team.displayName || '—';
  $('away-name').textContent = away.team.shortDisplayName || away.team.displayName || '—';
  $('home-record').textContent = home.records?.[0]?.summary || '';
  $('away-record').textContent = away.records?.[0]?.summary || '';

  const homeScore = home.score ?? '';
  const awayScore = away.score ?? '';
  $('home-score').textContent = state === 'pre' ? '—' : (homeScore || '0');
  $('away-score').textContent = state === 'pre' ? '—' : (awayScore || '0');
  $('home-score').classList.toggle('leading', state !== 'pre' && +homeScore > +awayScore);
  $('away-score').classList.toggle('leading', state !== 'pre' && +awayScore > +homeScore);

  const stype = competition.status?.type || {};
  $('game-status-line').textContent = stype.detail || stype.shortDetail || stype.description || '';

  const venue = competition.venue?.fullName || '';
  const broadcast = competition.broadcasts?.[0]?.names?.[0] || '';
  const meta = [];
  if (state === 'pre') {
    const dt = new Date(competition.date || competition.startDate);
    meta.push(dt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }));
  }
  if (venue) meta.push(venue);
  if (broadcast) meta.push(broadcast);
  $('game-meta-line').textContent = meta.join(' · ');

  const situation = competition.situation;
  const isLive = state === 'in';
  $('situation-panel').hidden = !isLive;

  if (isLive && situation) {
    $('base-1').classList.toggle('occupied', !!situation.onFirst);
    $('base-2').classList.toggle('occupied', !!situation.onSecond);
    $('base-3').classList.toggle('occupied', !!situation.onThird);

    renderPips('ball-dots', situation.balls ?? 0, 3);
    renderPips('strike-dots', situation.strikes ?? 0, 2);
    renderPips('out-dots', situation.outs ?? 0, 2, true);

    const detail = (stype.detail || stype.shortDetail || '').toLowerCase();
    const isTop = detail.startsWith('top');
    $('inning-arrow').textContent = isTop ? '▲' : '▼';
    $('inning-text').textContent = stype.detail || stype.shortDetail || '';
    $('away-row').classList.toggle('batting', isTop);
    $('home-row').classList.toggle('batting', !isTop);

    if (situation.batter?.athlete) {
      $('batter-name').textContent = situation.batter.athlete.displayName;
      $('batter-stats').textContent = situation.batter.summary || '';
    } else { $('batter-name').textContent = '—'; $('batter-stats').textContent = ''; }
    if (situation.pitcher?.athlete) {
      $('pitcher-name').textContent = situation.pitcher.athlete.displayName;
      $('pitcher-stats').textContent = situation.pitcher.summary || '';
    } else { $('pitcher-name').textContent = '—'; $('pitcher-stats').textContent = ''; }

    $('last-play').textContent = situation.lastPlay?.text || '';

    renderWinProb(summary, home, away);
  } else {
    $('away-row').classList.remove('batting');
    $('home-row').classList.remove('batting');
  }

  if (state !== 'pre' && (home.linescores?.length || away.linescores?.length)) {
    $('linescore-wrap').hidden = false;
    renderLinescore(home, away);
  } else {
    $('linescore-wrap').hidden = true;
  }

  const plays = summary?.plays || [];
  if (plays.length && (state === 'in' || state === 'post')) {
    $('pbp-section').hidden = false;
    renderPlayByPlay(plays);
  } else {
    $('pbp-section').hidden = true;
  }
}

function renderWinProb(summary, home, away) {
  const wp = summary?.winprobability;
  if (!Array.isArray(wp) || !wp.length) { $('winprob-block').hidden = true; return; }
  const latest = wp[wp.length - 1];
  if (typeof latest.homeWinPercentage !== 'number') { $('winprob-block').hidden = true; return; }

  $('winprob-block').hidden = false;
  const homePct = Math.round(latest.homeWinPercentage * 100);
  $('wp-home-name').textContent = home.team.shortDisplayName || home.team.abbreviation || 'Home';
  $('wp-away-name').textContent = away.team.shortDisplayName || away.team.abbreviation || 'Away';
  $('wp-home-value').textContent = homePct + '%';
  $('wp-away-value').textContent = (100 - homePct) + '%';
  $('wp-fill').style.width = homePct + '%';
}

function renderLinescore(home, away) {
  const innings = Math.max(home.linescores?.length || 0, away.linescores?.length || 0, 9);
  const head = ['<th></th>'];
  for (let i = 1; i <= innings; i++) head.push(`<th>${i}</th>`);
  head.push('<th>R</th><th>H</th><th>E</th>');
  $('linescore-head').innerHTML = head.join('');

  const rowFor = (team) => {
    const abbr = team.team.abbreviation || team.team.shortDisplayName || '';
    const cells = [`<td>${abbr}</td>`];
    for (let i = 1; i <= innings; i++) {
      const ls = team.linescores?.find(l => l.period === i);
      cells.push(`<td>${ls ? ls.displayValue : '·'}</td>`);
    }
    const stats = team.statistics || [];
    const stat = (n) => stats.find(s => s.name === n)?.displayValue ?? '—';
    cells.push(`<td class="total">${team.score ?? '0'}</td>`);
    cells.push(`<td>${stat('hits')}</td>`);
    cells.push(`<td>${stat('errors')}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  };

  $('linescore-body').innerHTML = rowFor(away) + rowFor(home);
}

function renderPlayByPlay(plays) {
  const recent = plays.slice(-60).reverse();
  const key = recent.map(p => p.id || p.sequenceNumber || p.text).join('|');
  if (key === lastPbpKey) return;
  lastPbpKey = key;

  $('pbp-list').innerHTML = recent.map((p) => {
    const periodNum = p.period?.number ?? p.period?.displayValue ?? '';
    const halfRaw = String(p.period?.type || p.period?.displayValue || '').toLowerCase();
    const half = halfRaw.includes('top') ? 'TOP' : 'BOT';
    const text = (p.text || p.shortText || p.alternativeText || '').replace(/</g, '&lt;');
    const scoring = p.scoringPlay === true || (p.scoreValue && p.scoreValue > 0);
    return `<li class="pbp-item${scoring ? ' scoring' : ''}">
      <span class="pbp-inning">${half} ${periodNum}</span>
      <span class="pbp-text">${text}</span>
    </li>`;
  }).join('');
}

// ---------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------
function renderSchedule(events) {
  const list = $('schedule-list');
  const now = Date.now();
  let items;
  if (scheduleView === 'upcoming') {
    items = events
      .filter(e => new Date(e.date).getTime() > now - 3 * 3600 * 1000)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 15);
  } else {
    items = events
      .filter(e => e.competitions?.[0]?.status?.type?.state === 'post')
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 15);
  }
  if (!items.length) {
    list.innerHTML = '<div class="schedule-loading">No games to show.</div>';
    return;
  }
  list.innerHTML = items.map(renderScheduleItem).join('');
}

function renderScheduleItem(event) {
  const c = event.competitions[0];
  const home = side(c.competitors, 'home');
  const away = side(c.competitors, 'away');
  const d = new Date(event.date);
  const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const day = d.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const aggiesHome = isAggiesTeam(home.team);
  const opp = aggiesHome ? away.team : home.team;
  const oppName = opp.shortDisplayName || opp.displayName || 'Opponent';
  const matchup = aggiesHome ? `vs. ${oppName}` : `at ${oppName}`;
  const venue = c.venue?.fullName || '';
  const tv = c.broadcasts?.[0]?.names?.[0] || '';
  const state = c.status?.type?.state;

  let result = '';
  if (state === 'post') {
    const us = aggiesHome ? home : away;
    const them = aggiesHome ? away : home;
    const win = parseInt(us.score) > parseInt(them.score);
    const cls = win ? 'win' : 'loss';
    result = `<div class="schedule-result ${cls}"><span class="badge">${win ? 'W' : 'L'}</span>${us.score}–${them.score}</div>`;
  } else if (state === 'in') {
    result = `<div class="schedule-result live"><span class="badge">LIVE</span>${c.status.type.shortDetail || ''}</div>`;
  } else {
    result = `<div class="schedule-result">${time}</div>`;
  }

  const meta = [venue, tv].filter(Boolean).join(' · ');
  const link = event.links?.find(l => l.rel?.includes('gamecast'))?.href
    || `https://www.espn.com/college-baseball/game/_/gameId/${event.id}`;

  return `<a class="schedule-item" href="${link}" target="_blank" rel="noopener">
    <div class="schedule-date"><span class="month">${month}</span><span class="day">${day}</span></div>
    <div>
      <div class="schedule-matchup">${matchup}</div>
      <div class="schedule-meta">${meta}</div>
    </div>
    ${result}
  </a>`;
}

// ---------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------
async function tick() {
  try {
    const events = eventCache || await fetchAggieEvents();
    eventCache = events;

    renderSchedule(events);

    if (!events.length) {
      $('card-loading').textContent = 'No Texas A&M games found in the current window.';
      $('card-content').hidden = true;
      $('card-loading').hidden = false;
      setStatus('IDLE', '');
      reschedule(POLL_IDLE);
      return;
    }

    const { game, state } = pickGame(events);
    if (!game) {
      setStatus('IDLE', '');
      reschedule(POLL_IDLE);
      return;
    }

    let summary = null;
    if (state === 'in' || state === 'post') {
      try { summary = await fetchSummary(game.id); } catch (_) {}
    }
    const liveComp = summary?.header?.competitions?.[0] || game.competitions[0];
    renderGame(liveComp, summary, state);

    if (state === 'in')       setStatus('LIVE', 'live');
    else if (state === 'pre') setStatus('NEXT UP', 'pre');
    else                       setStatus('FINAL', 'post');

    $('last-update').textContent = new Date().toLocaleTimeString();
    reschedule(state === 'in' ? POLL_LIVE : POLL_IDLE);

  } catch (err) {
    setStatus('OFFLINE', '');
    setError(err.message || String(err));
    reschedule(POLL_IDLE);
  }
}

function reschedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (Math.random() < 0.25) eventCache = null;
    tick();
  }, ms);
}

// ---------------------------------------------------------------
// UI bindings
// ---------------------------------------------------------------
document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    scheduleView = btn.dataset.view;
    if (eventCache) renderSchedule(eventCache);
  });
});

$('pbp-refresh')?.addEventListener('click', () => {
  eventCache = null;
  lastPbpKey = '';
  tick();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { eventCache = null; tick(); }
});

tick();
