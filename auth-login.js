// POST /api/auth-login — { email, password }
const { bcrypt, normalizeEmail, getUser, setSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = await getUser(email);
    if (!user) {
      res.status(401).json({ error: 'No account with that email. Sign up instead?' });
      return;
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Incorrect password.' });
      return;
    }
    setSessionCookie(res, email);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
