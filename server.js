// =============================================================
// Optional backend proxy for Aggie Baseball Live
// =============================================================
// You do NOT need to run this if you're happy hitting ESPN directly
// from the browser. It exists for:
//   - Caching responses (cuts ESPN load, faster for users)
//   - Working around any future CORS issues
//   - Running on a VPS / Render / Fly.io / Railway alongside the site
//
// To use: deploy this, then in /app.js set:
//   const API_BASE = 'https://your-backend.example.com';
//
// Run locally:
//   cd backend && npm install && npm start
// =============================================================

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const TEAM_ID = '245';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';

// In-memory cache. Keys are URLs; values are { ts, data }.
const cache = new Map();
const CACHE_MS_LIVE = 10_000;    // live game endpoints
const CACHE_MS_OTHER = 60_000;   // schedule, etc.

async function cachedFetch(url, ttl) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  cache.set(url, { ts: Date.now(), data });
  return data;
}

// Match the same paths the frontend uses, so API_BASE swap is seamless.
app.get('/teams/:id/schedule', async (req, res) => {
  try {
    const data = await cachedFetch(`${ESPN_BASE}/teams/${req.params.id}/schedule`, CACHE_MS_OTHER);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/summary', async (req, res) => {
  try {
    const eventId = req.query.event;
    if (!eventId) return res.status(400).json({ error: 'missing event' });
    const data = await cachedFetch(`${ESPN_BASE}/summary?event=${eventId}`, CACHE_MS_LIVE);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/scoreboard', async (req, res) => {
  try {
    const qs = req.query.dates ? `?dates=${req.query.dates}` : '';
    const data = await cachedFetch(`${ESPN_BASE}/scoreboard${qs}`, CACHE_MS_LIVE);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/', (_req, res) => {
  res.json({ ok: true, team: TEAM_ID, message: 'Aggie Baseball proxy is up.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy listening on :${port}`));
