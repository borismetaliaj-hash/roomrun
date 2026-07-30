// A private, read-only page for Boris to check how many people have signed up and how many
// are paying subscribers — there's no separate admin account system, so this just checks that
// whoever is asking is logged in as the one account that owns this app. Anyone else hitting
// this URL (logged out, or logged in as a different email) gets a plain "not authorized" page.
const { getUserFromRequest, redis } = require('../lib/auth');

const OWNER_EMAIL = 'borismetaliaj@gmail.com';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roomrun — Stats</title>
<style>
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0B1730; color:#fff; padding:40px 20px; }
.wrap { max-width: 520px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 24px; }
.stat { background:#132449; border-radius:14px; padding:20px 22px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; }
.stat .label { color:#A8B4D0; font-size:14px; }
.stat .value { font-size:26px; font-weight:700; }
.note { color:#A8B4D0; font-size:13px; margin-top:20px; line-height:1.5; }
</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.email !== OWNER_EMAIL) {
      res.status(401).send(page('<h1>Not authorized</h1><p class="note">Log in to Roomrun with your own account first, then reload this page.</p>'));
      return;
    }

    const keys = await redis.keys('user:*');
    const total = keys.length;
    let trialing = 0, active = 0, canceled = 0, other = 0;
    const batchSize = 50;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const records = await Promise.all(batch.map((k) => redis.get(k)));
      records.forEach((r) => {
        if (!r) { other++; return; }
        const u = typeof r === 'string' ? JSON.parse(r) : r;
        const status = u && u.subscriptionStatus;
        if (status === 'active') active++;
        else if (status === 'trialing') trialing++;
        else if (status) canceled++;
        else other++;
      });
    }

    res.status(200).send(page(`
      <h1>Roomrun signups</h1>
      <div class="stat"><span class="label">Total signups</span><span class="value">${total}</span></div>
      <div class="stat"><span class="label">Paying subscribers</span><span class="value">${active}</span></div>
      <div class="stat"><span class="label">On free trial</span><span class="value">${trialing}</span></div>
      <div class="stat"><span class="label">Canceled / lapsed</span><span class="value">${canceled}</span></div>
      <p class="note">Only you can see this page — it checks you're logged in as ${escapeHtml(OWNER_EMAIL)}. For payment details (refunds, receipts, exact revenue) use your Stripe dashboard instead — this is just signup counts.</p>
    `));
  } catch (e) {
    console.error('admin-stats error', e);
    res.status(500).send(page('<h1>Something went wrong</h1><p class="note">Check Vercel Runtime Logs for /api/admin-stats.</p>'));
  }
};
