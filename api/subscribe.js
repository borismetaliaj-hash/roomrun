// Saves a browser's push subscription so api/listings.js can notify it later when new
// listings show up. Subscriptions are stored in a Redis hash keyed by endpoint (so
// resubscribing from the same browser just overwrites the old entry) — one hash per city,
// e.g. "pushsubs:St Andrews", so each city's scraper only notifies people watching it.
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }

  // index.html now posts { subscription, city, filters } — but also accept a bare
  // PushSubscription with no wrapper (the original shape) for backwards compatibility.
  const sub = body && body.subscription ? body.subscription : body;
  const city = (body && body.city) || 'St Andrews';
  const key = 'pushsubs:' + city;

  // Optional notification preferences (bedrooms / price range / agencies) — filters what
  // api/listings.js actually sends this subscriber, rather than every single new listing.
  // Left null/empty on any field means "no restriction on that field".
  const rawFilters = (body && body.filters) || null;
  const filters = rawFilters ? {
    beds: Array.isArray(rawFilters.beds) ? rawFilters.beds.filter((b) => typeof b === 'string').slice(0, 10) : [],
    agencies: Array.isArray(rawFilters.agencies) ? rawFilters.agencies.filter((a) => typeof a === 'string').slice(0, 20) : [],
    minPrice: (typeof rawFilters.minPrice === 'number' && isFinite(rawFilters.minPrice)) ? rawFilters.minPrice : null,
    maxPrice: (typeof rawFilters.maxPrice === 'number' && isFinite(rawFilters.maxPrice)) ? rawFilters.maxPrice : null
  } : null;

  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    res.status(400).json({ error: 'Invalid push subscription' });
    return;
  }

  try {
    if (req.method === 'DELETE') {
      await redis.hdel(key, sub.endpoint);
      res.status(200).json({ ok: true, removed: true });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    await redis.hset(key, { [sub.endpoint]: JSON.stringify({ subscription: sub, filters }) });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not save subscription' });
  }
};
