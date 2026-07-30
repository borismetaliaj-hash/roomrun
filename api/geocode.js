// Server-side geocoding for the "distance from" radius filter. Runs here — not in the browser,
// and not inside api/listings.js's scrape step — for two reasons:
//   1. Results are cached in Redis and shared across every visitor. After the very first lookup
//      for a given address, everyone gets an instant cached answer instead of re-geocoding the
//      same street over and over.
//   2. Nominatim (OpenStreetMap's free geocoding service, used here since there's no paid
//      geocoding API key on this project) caps requests at 1/second, so lookups are done one at
//      a time with a real delay between them rather than in parallel — folding that into the
//      scrape pipeline in api/listings.js would slow down every single refresh, including for
//      users who never touch the distance filter.
// To stay well under any serverless function timeout, each call to this endpoint only resolves
// a handful of new (uncached) addresses — the client calls it again for whatever's still
// missing, and every address after its first-ever lookup resolves instantly from cache.
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

const GEO_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — streets don't move
const MAX_LOOKUPS_PER_REQUEST = 5;

function normalizeAddr(addr) {
  return String(addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nominatimLookup(address) {
  const hasAreaContext = /st\.?\s*andrews|fife|guardbridge|tayport|kilconquhar|peat inn|strathkinness|leuchars/i.test(address);
  const query = hasAreaContext ? address : `${address}, St Andrews, Fife, UK`;
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      // Nominatim's usage policy requires a real identifying User-Agent for automated use —
      // this is that, pointing at the live app rather than a person, since this file is public.
      'User-Agent': 'Roomrun/1.0 (https://roomrun.vercel.app; student housing tracker for St Andrews)',
      'Accept-Language': 'en-GB'
    }
  });
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const addresses = Array.isArray(body && body.addresses)
    ? [...new Set(body.addresses.filter((a) => typeof a === 'string' && a.trim()))].slice(0, 80)
    : [];
  if (!addresses.length) { res.status(400).json({ error: 'No addresses given' }); return; }

  try {
    const results = {};
    const uncached = [];
    for (const addr of addresses) {
      const key = 'geo:' + normalizeAddr(addr);
      const cached = await redis.get(key);
      if (cached === null || cached === undefined) {
        uncached.push(addr);
      } else {
        results[addr] = cached === 'null' ? null : (typeof cached === 'string' ? JSON.parse(cached) : cached);
      }
    }

    let lookedUp = 0;
    for (const addr of uncached) {
      if (lookedUp >= MAX_LOOKUPS_PER_REQUEST) break;
      const key = 'geo:' + normalizeAddr(addr);
      let coords = null;
      try {
        coords = await nominatimLookup(addr);
      } catch (e) {
        coords = null;
      }
      results[addr] = coords;
      await redis.set(key, coords ? JSON.stringify(coords) : 'null', { ex: GEO_TTL_SECONDS });
      lookedUp++;
      if (lookedUp < uncached.length && lookedUp < MAX_LOOKUPS_PER_REQUEST) await sleep(1100);
    }

    res.status(200).json({ results, remaining: Math.max(0, uncached.length - lookedUp) });
  } catch (e) {
    console.error('geocode error', e);
    res.status(500).json({ error: 'Could not geocode right now' });
  }
};
