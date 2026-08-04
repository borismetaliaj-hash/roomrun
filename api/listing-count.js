// Vercel Serverless Function — GET /api/listing-count?city=St+Andrews
// Public, unauthenticated, read-only listing count for the landing page trust signal
// ("52 rooms & rentals tracked right now") shown BEFORE the signup wall — see index.html
// #landing. Deliberately thin: just calls getListingCount() from listings.js, which only
// ever reads whatever's already cached (never triggers a live scrape), so this can be hit
// by anonymous pre-signup traffic without any abuse/cost risk. Added 2026-08-04 as part of
// a signup-conversion pass — the auth overlay used to appear with zero preview of the app's
// value, which is a hard sell for a first-time visitor with no context.
const { getListingCount } = require('./listings');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }

  const city = (req.query && req.query.city) || 'St Andrews';
  try {
    const count = await getListingCount(city);
    res.status(200).json({ count });
  } catch (e) {
    // Never let this block the landing page — worst case the client just hides the badge.
    res.status(200).json({ count: null });
  }
};
