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
// On-screen debug log (toggle with ?debug=1)
// ---------------------------------------------------------------
const DEBUG = new URLSearchParams(location.search).has('debug');
function debug(msg) {
  if (!DEBUG) return;
  let panel = document.getElementById('debug-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow:auto;background:#000;color:#0f0;font:11px/1.4 monospace;padding:8px;z-index:9999;border-top:2px solid #0f0;white-space:pre-wrap;word-break:break-all;';
    document.body.appendChild(panel);
  }
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
  console.log(msg);
}

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

// Throttled fetch: process days in small batches to avoid rate limits.
async function fetchAggieEvents() {
  const today = new Date();
  const days = [];
  for (let i = -14; i <= 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }

  debug(`Fetching ${days.length} days from ESPN…`);
  const BATCH = 5;
  const results = [];
  let okCount = 0, failCount = 0;

  for (let i = 0; i < days.length; i += BATCH) {
    const batch = days.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map((d) =>
      fetchJSON(url(`/scoreboard?dates=${yyyymmdd(d)}`), `scoreboard ${yyyymmdd(d)}`)
        .then((r) => { okCount++; return r; })
        .catch((err) => {
          failCount++;
          console.warn('Day fetch failed', yyyymmdd(d), err.message);
          return null;
        })
    ));
    results.push(...batchResults);
    // Update card while we work
    const el = document.getElementById('card-loading');
    if (el && !el.hidden) {
      el.textContent = `Loading game data… ${okCount + failCount}/${days.length}`;
    }
  }
  debug(`Done. ok=${okCount} fail=${failCount}`);

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
  debug(`Aggie games found: ${events.length}`);
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

const side = (competitors, which) => {
  if (!Array.isArray(competitors) || !competitors.length) return null;
  return competitors.find(c => c.homeAway === which) || competitors[0];
};
const isAggiesTeam = (team) => {
  if (!team) return false;
  return STRONG_RX.test(team.displayName || '') ||
         STRONG_RX.test(team.abbreviation || '') ||
         STRONG_RX.test(team.location || '');
};

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
function teamLogoURL(team) {
  // ESPN logo can be on team.logo (string) or team.logos[] (array of {href}).
  // Fall back to ESPN's CDN by ID, which works even when logo is missing.
  if (team?.logo) return team.logo;
  if (Array.isArray(team?.logos) && team.logos[0]?.href) return team.logos[0].href;
  if (team?.id) return `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`;
  return '';
}

function setLogo(imgId, team) {
  const img = $(imgId);
  const u = teamLogoURL(team);
  if (!u) { img.style.visibility = 'hidden'; return; }
  img.style.visibility = '';
  img.src = u;
  img.onerror = () => {
    // If primary fails, try the CDN by ID
    if (team?.id && !img.src.includes('a.espncdn.com')) {
      img.src = `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`;
    } else {
      img.style.visibility = 'hidden';
    }
  };
}

function renderGame(competition, summary, state) {
  $('card-loading').hidden = true;
  $('card-content').hidden = false;

  // Always prefer the fresher summary header (situation lives there during live games)
  const liveComp = summary?.header?.competitions?.[0] || competition;
  const home = side(liveComp.competitors, 'home');
  const away = side(liveComp.competitors, 'away');

  // Logos with multi-layer fallback
  setLogo('home-logo', home.team);
  setLogo('away-logo', away.team);
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

  const stype = liveComp.status?.type || {};
  $('game-status-line').textContent = stype.detail || stype.shortDetail || stype.description || '';

  const venue = liveComp.venue?.fullName || '';
  const broadcast = liveComp.broadcasts?.[0]?.names?.[0] || '';
  const meta = [];
  if (state === 'pre') {
    const dt = new Date(liveComp.date || liveComp.startDate);
    meta.push(dt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }));
  }
  if (venue) meta.push(venue);
  if (broadcast) meta.push(broadcast);
  $('game-meta-line').textContent = meta.join(' · ');

  // Live situation can be in multiple places; check all of them
  const situation = liveComp.situation || summary?.situation || competition.situation;
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
    const isTop = detail.startsWith('top') || detail.includes('top');
    $('inning-arrow').textContent = isTop ? '▲' : '▼';
    $('inning-text').textContent = stype.detail || stype.shortDetail || '';
    $('away-row').classList.toggle('batting', isTop);
    $('home-row').classList.toggle('batting', !isTop);

    // Base runner names (if API provides them)
    const baseLabels = [];
    if (situation.onFirst) baseLabels.push(`1st: ${situation.onFirst.playerSummary || situation.onFirst.athlete?.displayName || 'runner'}`);
    if (situation.onSecond) baseLabels.push(`2nd: ${situation.onSecond.playerSummary || situation.onSecond.athlete?.displayName || 'runner'}`);
    if (situation.onThird) baseLabels.push(`3rd: ${situation.onThird.playerSummary || situation.onThird.athlete?.displayName || 'runner'}`);
    const runnersEl = $('runners-list');
    if (runnersEl) {
      if (baseLabels.length) {
        runnersEl.hidden = false;
        runnersEl.textContent = baseLabels.join('  •  ');
      } else {
        runnersEl.hidden = true;
      }
    }

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
    const runnersEl = $('runners-list');
    if (runnersEl) runnersEl.hidden = true;
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
    renderInningBreakdown(plays, home, away);
    renderPlayByPlay(plays);
  } else {
    $('pbp-section').hidden = true;
    const ib = $('innings-section');
    if (ib) ib.hidden = true;
  }

  // Boxscore (batting + pitching). Available during and after a game.
  if (state === 'in' || state === 'post') {
    try { renderBoxscore(summary, home, away); }
    catch (e) { console.warn('boxscore render failed', e); }
  } else {
    const bx = $('boxscore-section');
    if (bx) bx.hidden = true;
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
// Inning breakdown — group plays by inning + half, show runs/hits per
// ---------------------------------------------------------------
function renderInningBreakdown(plays, home, away) {
  const section = $('innings-section');
  if (!section) return;

  // Group by inning + half
  const buckets = new Map(); // key "1-top" -> { inning, half, plays:[], runs, hits }
  for (const p of plays) {
    const inning = p.period?.number;
    if (!inning) continue;
    const halfRaw = String(p.period?.type || p.period?.displayValue || '').toLowerCase();
    const half = halfRaw.includes('top') ? 'top' : 'bottom';
    const key = `${inning}-${half}`;
    if (!buckets.has(key)) buckets.set(key, { inning, half, plays: [], runs: 0, hits: 0 });
    const b = buckets.get(key);
    b.plays.push(p);
    if (p.scoringPlay) b.runs += (p.scoreValue || 1);
    // Heuristic for hit detection from text
    const t = (p.text || '').toLowerCase();
    if (/\b(singled|doubled|tripled|homered|home run)\b/.test(t)) b.hits++;
  }

  if (!buckets.size) { section.hidden = true; return; }
  section.hidden = false;

  const homeAbbr = home.team.abbreviation || 'HOME';
  const awayAbbr = away.team.abbreviation || 'AWAY';

  // Newest first
  const sorted = [...buckets.values()].sort((a, b) => {
    if (a.inning !== b.inning) return b.inning - a.inning;
    return a.half === 'top' ? 1 : -1; // bottom shows above top of same inning
  });

  const list = $('innings-list');
  list.innerHTML = sorted.map((b) => {
    const battingAbbr = b.half === 'top' ? awayAbbr : homeAbbr;
    const halfLabel = b.half === 'top' ? '▲ TOP' : '▼ BOT';
    const summary = b.plays.length ? b.plays[b.plays.length - 1].text : '';
    const scoringPlays = b.plays.filter(p => p.scoringPlay);
    const scoringText = scoringPlays.length
      ? scoringPlays.map(p => `<div class="inning-scoring">${(p.text || '').replace(/</g, '&lt;')}</div>`).join('')
      : '';
    return `
      <details class="inning-block" ${b === sorted[0] ? 'open' : ''}>
        <summary>
          <span class="inning-half">${halfLabel} ${b.inning}</span>
          <span class="inning-bat">${battingAbbr} batting</span>
          <span class="inning-stats">${b.runs} R · ${b.hits} H</span>
        </summary>
        ${scoringText}
        <div class="inning-last">${(summary || '').replace(/</g, '&lt;')}</div>
      </details>
    `;
  }).join('');
}

// ---------------------------------------------------------------
// Boxscore — batting + pitching stats per team
// ---------------------------------------------------------------
function renderBoxscore(summary, home, away) {
  const section = $('boxscore-section');
  if (!section) return;

  const boxscore = summary?.boxscore;
  const players = boxscore?.players;
  if (!Array.isArray(players) || !players.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // Build tabs (one per team) and tables (batting + pitching per team)
  const tabsHTML = players.map((teamGroup, idx) => {
    const t = teamGroup.team || {};
    const name = t.shortDisplayName || t.displayName || t.abbreviation || `Team ${idx + 1}`;
    return `<button class="bx-tab ${idx === 0 ? 'active' : ''}" data-bx-idx="${idx}">${name}</button>`;
  }).join('');

  const panelsHTML = players.map((teamGroup, idx) => {
    const stats = teamGroup.statistics || [];
    const batting = stats.find(s => /batting/i.test(s.type || s.name)) || stats[0];
    const pitching = stats.find(s => /pitching/i.test(s.type || s.name));

    return `<div class="bx-panel" data-bx-idx="${idx}" ${idx === 0 ? '' : 'hidden'}>
      ${batting ? renderStatTable('Batting', batting) : ''}
      ${pitching ? renderStatTable('Pitching', pitching) : ''}
    </div>`;
  }).join('');

  $('bx-tabs').innerHTML = tabsHTML;
  $('bx-panels').innerHTML = panelsHTML;

  // Wire up tab clicks
  $('bx-tabs').querySelectorAll('.bx-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.bxIdx;
      $('bx-tabs').querySelectorAll('.bx-tab').forEach(b => b.classList.toggle('active', b.dataset.bxIdx === idx));
      $('bx-panels').querySelectorAll('.bx-panel').forEach(p => {
        p.hidden = p.dataset.bxIdx !== idx;
      });
    });
  });
}

function renderStatTable(title, statBlock) {
  const labels = statBlock.labels || [];   // ["AB","R","H","RBI",...]
  const keys = statBlock.keys || [];       // same length, maps to athlete stat order
  const athletes = statBlock.athletes || [];
  if (!athletes.length) return '';

  // Limit batting columns on phones — show the most important
  const shortBatLabels = ['AB','R','H','RBI','BB','SO','AVG'];
  const shortPitLabels = ['IP','H','R','ER','BB','SO','ERA'];
  const isPitching = /pitching/i.test(title);
  const preferred = isPitching ? shortPitLabels : shortBatLabels;

  // Pick column indices to display (intersection of preferred + actual labels, preserving preferred order)
  const cols = [];
  for (const label of preferred) {
    const idx = labels.findIndex(l => l.toUpperCase() === label);
    if (idx !== -1) cols.push({ idx, label });
  }
  // If nothing matched, show all labels
  const useCols = cols.length ? cols : labels.map((l, idx) => ({ idx, label: l }));

  const headRow = `<tr><th>Player</th>${useCols.map(c => `<th>${c.label}</th>`).join('')}</tr>`;
  const bodyRows = athletes.map(a => {
    const name = a.athlete?.shortName || a.athlete?.displayName || '—';
    const pos = a.position?.abbreviation || a.athlete?.position?.abbreviation || '';
    const stats = a.stats || [];
    const cells = useCols.map(c => `<td>${stats[c.idx] ?? '—'}</td>`).join('');
    const note = a.starter ? '' : ' <span class="bx-note">sub</span>';
    return `<tr>
      <td class="bx-name">${name}${pos ? ` <span class="bx-pos">${pos}</span>` : ''}${note}</td>
      ${cells}
    </tr>`;
  }).join('');

  return `<div class="bx-table-wrap">
    <h3 class="bx-table-title">${title}</h3>
    <table class="bx-table">
      <thead>${headRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
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
  try {
    const c = event.competitions?.[0];
    if (!c || !c.competitors) return '';
    const home = side(c.competitors, 'home');
    const away = side(c.competitors, 'away');
    if (!home || !away || !home.team || !away.team) return '';
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
      const usScore = (us.score !== undefined && us.score !== null && us.score !== '') ? parseInt(us.score) : null;
      const themScore = (them.score !== undefined && them.score !== null && them.score !== '') ? parseInt(them.score) : null;
      let win;
      if (typeof us.winner === 'boolean') win = us.winner;
      else if (usScore !== null && themScore !== null) win = usScore > themScore;
      else win = false;
      const cls = win ? 'win' : 'loss';
      const scoreText = (usScore !== null && themScore !== null) ? `${usScore}–${themScore}` : '';
      result = `<div class="schedule-result ${cls}"><span class="badge">${win ? 'W' : 'L'}</span>${scoreText}</div>`;
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
      <div class="schedule-middle">
        <div class="schedule-matchup">${matchup}</div>
        <div class="schedule-meta">${meta}</div>
      </div>
      ${result}
    </a>`;
  } catch (err) {
    console.warn('renderScheduleItem failed for event', event?.id, err);
    return '';
  }
}

// ---------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------
async function tick() {
  try {
    debug('tick start');
    console.log('[tick] start');
    const events = eventCache || await fetchAggieEvents();
    eventCache = events;
    debug(`tick events=${events.length}`);
    console.log('[tick] got events:', events.length);

    try { renderSchedule(events); }
    catch (e) { console.error('[renderSchedule failed]', e); debug('renderSchedule failed: ' + e.message); }

    if (!events.length) {
      $('card-loading').textContent = 'No Texas A&M games found in the current window.';
      $('card-content').hidden = true;
      $('card-loading').hidden = false;
      setStatus('IDLE', '');
      reschedule(POLL_IDLE);
      return;
    }

    const { game, state } = pickGame(events);
    debug(`picked game=${game?.id} state=${state}`);
    console.log('[tick] picked game', game?.id, 'state', state);
    if (!game) {
      setStatus('IDLE', '');
      reschedule(POLL_IDLE);
      return;
    }

    let summary = null;
    if (state === 'in' || state === 'post') {
      try { summary = await fetchSummary(game.id); }
      catch (e) { debug('summary failed: ' + e.message); console.warn('summary fetch failed', e); }
    }
    const liveComp = summary?.header?.competitions?.[0] || game.competitions?.[0];
    if (!liveComp) {
      debug('no competition data');
      setError('No competition data on selected event.');
      reschedule(POLL_IDLE);
      return;
    }

    try { renderGame(liveComp, summary, state); }
    catch (e) {
      debug('renderGame failed: ' + e.message);
      console.error('[renderGame failed]', e);
      setError('Render failed: ' + (e.message || e));
      reschedule(POLL_IDLE);
      return;
    }

    if (state === 'in')       setStatus('LIVE', 'live');
    else if (state === 'pre') setStatus('NEXT UP', 'pre');
    else                       setStatus('FINAL', 'post');

    $('last-update').textContent = new Date().toLocaleTimeString();
    reschedule(state === 'in' ? POLL_LIVE : POLL_IDLE);

  } catch (err) {
    debug('FATAL: ' + (err.message || err));
    setStatus('OFFLINE', '');
    setError(err.message || String(err));
    reschedule(POLL_IDLE);
  }
}

// Catch any errors that escape (promise rejections, etc.)
window.addEventListener('error', (e) => debug('window error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => debug('unhandled rejection: ' + (e.reason?.message || e.reason)));

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
