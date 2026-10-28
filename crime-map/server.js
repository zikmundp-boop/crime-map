'use strict';
/**
 * Crime News Map – server
 * Bez závislostí, stačí Node.js 18+ (používá vestavěný fetch).
 *
 * Každých REFRESH_MINUTES minut stáhne krimi zprávy pro všech 50 států + DC,
 * uloží je do paměti i do data/cache.json a vystaví je na /api/news.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES) || 15;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || '';
const PROVIDER = GNEWS_API_KEY ? 'gnews' : 'rss';
const MAX_ITEMS = 15; // zpráv na stát
const CONCURRENCY = 4; // souběžných dotazů
const PAUSE_MS = 400; // pauza mezi dotazy jednoho workeru
const CACHE_FILE = path.join(__dirname, 'data', 'cache.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Názvy, které by ve vyhledávání zaměnily stát za něco jiného.
const SEARCH_TERM = {
  WA: '"Washington state"',
  DC: '"Washington DC"',
  VA: '"Virginia" -"West Virginia"',
  GA: '"Georgia" -Russia -Tbilisi -Georgian',
};
const CRIME_WORDS = '(crime OR murder OR shooting OR arrested OR robbery OR police)';

function searchQuery(code) {
  const term = SEARCH_TERM[code] || `"${STATES[code]}"`;
  return `${CRIME_WORDS} ${term}`;
}

/* ---------- Zdroje zpráv ---------- */

const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const source = tag(block, 'source');
    let title = tag(block, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = tag(block, 'link');
    const date = new Date(tag(block, 'pubDate'));
    if (!title || !/^https?:\/\//.test(link) || Number.isNaN(date.getTime())) continue;
    items.push({ title, url: link, source, publishedAt: date.toISOString() });
  }
  return items;
}

async function fetchGoogleNewsRss(code) {
  const q = `${searchQuery(code)} when:2d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrimeNewsMap/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return parseRss(await res.text());
}

async function fetchGNews(code) {
  const from = new Date(Date.now() - 48 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const url =
    'https://gnews.io/api/v4/search?' +
    new URLSearchParams({
      q: searchQuery(code).replace(/\(|\)/g, ''),
      lang: 'en',
      country: 'us',
      max: '10',
      from,
      sortby: 'publishedAt',
      apikey: GNEWS_API_KEY,
    });
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GNews HTTP ${res.status}`);
  const json = await res.json();
  return (json.articles || []).map((a) => ({
    title: a.title,
    url: a.url,
    source: a.source?.name || '',
    publishedAt: new Date(a.publishedAt).toISOString(),
  }));
}

const fetchers = { rss: fetchGoogleNewsRss, gnews: fetchGNews };

/* ---------- Úložiště a obnova ---------- */

let store = { updatedAt: null, states: {} };
let refreshing = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadCache() {
  try {
    store = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    /* bez cache začínáme prázdní */
  }
}

async function saveCache() {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(store));
  } catch (err) {
    console.error('Nelze uložit cache:', err.message);
  }
}

async function refreshState(code) {
  try {
    const raw = await fetchers[PROVIDER](code);
    const seen = new Set();
    const items = raw
      .filter((i) => {
        const key = i.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, MAX_ITEMS);
    store.states[code] = { items, fetchedAt: new Date().toISOString(), error: null };
  } catch (err) {
    // staré zprávy necháme, jen si zapamatujeme chybu
    const prev = store.states[code] || { items: [], fetchedAt: null };
    store.states[code] = { ...prev, error: err.message };
    console.error(`[${code}] ${err.message}`);
  }
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  const started = Date.now();
  try {
    const codes = Object.keys(STATES);
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < codes.length) {
          await refreshState(codes[next++]);
          await sleep(PAUSE_MS);
        }
      })
    );
    store.updatedAt = new Date().toISOString();
    await saveCache();
    console.log(`Obnoveno za ${Math.round((Date.now() - started) / 1000)} s (zdroj: ${PROVIDER})`);
  } finally {
    refreshing = false;
  }
}

function buildResponse() {
  const states = {};
  for (const [code, name] of Object.entries(STATES)) {
    const s = store.states[code] || { items: [] };
    states[code] = { name, count: s.items.length, items: s.items, error: s.error || null };
  }
  return { updatedAt: store.updatedAt, refreshing, provider: PROVIDER, states };
}

/* ---------- HTTP server ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  if (pathname === '/api/news') {
    return send(res, 200, JSON.stringify(buildResponse()), {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'public, max-age=30',
    });
  }

  const rel = pathname === '/' ? 'index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const body = await fs.readFile(file);
    send(res, 200, body, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not Found');
  }
}

async function main() {
  await loadCache();
  http.createServer(handler).listen(PORT, () => {
    console.log(`Mapa běží na http://localhost:${PORT} (obnova každých ${REFRESH_MINUTES} min)`);
  });
  refreshAll();
  setInterval(refreshAll, REFRESH_MINUTES * 60e3);
}

if (require.main === module) main();

module.exports = { parseRss, searchQuery, STATES };
