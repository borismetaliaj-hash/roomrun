// A private, read-only page for Boris to check how many people have signed up, who they are,
// and how many are paying subscribers — there's no separate admin account system, so this just
// checks that whoever is asking is logged in as the one account that owns this app. Anyone else
// hitting this URL (logged out, or logged in as a different email) gets a plain "not authorized"
// page — nobody else's signup list is exposed.
const { getUserFromRequest, redis } = require('../lib/auth');

const OWNER_EMAIL = 'borismetaliaj@gmail.com';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusLabel(status) {
  if (status === 'active') return { text: 'Subscribed', cls: 'st-active' };
  if (status === 'trialing') return { text: 'On trial', cls: 'st-trial' };
  if (status) return { text: status.replace(/_/g, ' '), cls: 'st-lapsed' };
  return { text: 'Unknown', cls: 'st-lapsed' };
}

function page(bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roomrun — Stats</title>
<style>
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0B1730; color:#fff; padding:40px 20px 60px; }
.wrap { max-width: 640px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 24px; }
h2 { font-size: 16px; color: #A8B4D0; margin: 32px 0 12px; }
.stats-row { display: flex; flex-wrap: wrap; gap: 12px; }
.stat { background:#132449; border-radius:14px; padding:16px 18px; flex: 1 1 130px; }
.stat .label { color:#A8B4D0; font-size:13px; display:block; }
.stat .value { font-size:24px; font-weight:700; display:block; margin-top:4px; }
table { width: 100%; border-collapse: collapse; background:#132449; border-radius: 14px; overflow: hidden; }
th, td { text-align: left; padding: 12px 14px; font-size: 13.5px; border-bottom: 1px solid #1E3562; }
th { color: #A8B4D0; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
tr:last-child td { border-bottom: none; }
.badge { display:inline-block; padding: 3px 9px; border-radius: 6px; font-size: 11.5px; font-weight: 700; }
.st-active { background:#1A7A3D; color:#fff; }
.st-trial { background:#2A4A8C; color:#DCE6FF; }
.st-lapsed { background:#3A3F52; color:#C7CCDA; }
.note { color:#A8B4D0; font-size:13px; margin-top:24px; line-height:1.5; }
.empty { color:#A8B4D0; font-size:13.5px; padding: 16px; }
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
    const batchSize = 50;
    const allUsers = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const records = await Promise.all(batch.map((k) => redis.get(k)));
      records.forEach((r) => {
        if (!r) return;
        const u = typeof r === 'string' ? JSON.parse(r) : r;
        if (u && u.email) allUsers.push(u);
      });
    }

    allUsers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const total = allUsers.length;
    const active = allUsers.filter((u) => u.subscriptionStatus === 'active').length;
    const trialing = allUsers.filter((u) => u.subscriptionStatus === 'trialing').length;
    const canceled = allUsers.filter((u) => u.subscriptionStatus && u.subscriptionStatus !== 'active' && u.subscriptionStatus !== 'trialing').length;

    const rows = allUsers.map((u) => {
      const st = statusLabel(u.subscriptionStatus);
      return `<tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td><span class="badge ${st.cls}">${escapeHtml(st.text)}</span></td>
      </tr>`;
    }).join('');

    res.status(200).send(page(`
      <h1>Roomrun signups</h1>
      <div class="stats-row">
        <div class="stat"><span class="label">Total signups</span><span class="value">${total}</span></div>
        <div class="stat"><span class="label">Subscribed</span><span class="value">${active}</span></div>
        <div class="stat"><span class="label">On trial</span><span class="value">${trialing}</span></div>
        <div class="stat"><span class="label">Lapsed</span><span class="value">${canceled}</span></div>
      </div>
      <h2>Everyone who's signed up</h2>
      ${total ? `<table><thead><tr><th>Email</th><th>Joined</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nobody yet.</div>'}
      <p class="note">Only you can see this page — it checks you're logged in as ${escapeHtml(OWNER_EMAIL)}. For payments (refunds, receipts, exact revenue) use your Stripe dashboard instead.</p>
    `));
  } catch (e) {
    console.error('admin-stats error', e);
    res.status(500).send(page('<h1>Something went wrong</h1><p class="note">Check Vercel Runtime Logs for /api/admin-stats.</p>'));
  }
};
