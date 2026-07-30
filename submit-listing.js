// Vercel Serverless Function — POST /api/submit-listing
// Lets students self-add a house/room straight into the app. No moderation queue —
// entries are tagged "Added by students" client-side and clearly distinguished from
// agency-checked sources. Stored per city in Upstash Redis, capped at 200 most recent.
//
// This file was missing from the /api folder entirely (only a stale duplicate sat at the repo
// root, which Vercel never serves — see vercel.json, only api/* is routed). That meant the
// "Spotted something?" add-a-house form in index.html was posting to /api/submit-listing and
// getting a 404 in production — found during a general glitch audit on 2026-07-30, not
// reported by a user. Restored here so it actually matches what api/listings.js's
// getCommunityListings() reads back (the 'community:' + city Redis key).
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = req.body || {};
    const city = String(body.city || '').trim();
    const address = String(body.address || '').trim();
    const price = String(body.price || '').trim();
    const beds = String(body.beds || '').trim();
    const contact = String(body.contact || '').trim();

    if (!city || !address) {
      res.status(400).json({ error: 'city and address are required' });
      return;
    }
    if (address.length > 200 || price.length > 60 || beds.length > 20 || contact.length > 200) {
      res.status(400).json({ error: 'one or more fields too long' });
      return;
    }

    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      address,
      price,
      beds: beds ? parseInt(beds, 10) || null : null,
      contact,
      addedAt: new Date().toISOString()
    };

    const key = 'community:' + city;
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 199);

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
