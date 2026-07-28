// POST /api/auth-logout
const { clearSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
