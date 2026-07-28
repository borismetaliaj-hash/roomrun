const { bcrypt, normalizeEmail, getUser, setSessionCookie } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { email, password } = req.body || {};
    const normEmail = normalizeEmail(email);
    const user = await getUser(normEmail);
    if (!user) {
      res.status(401).json({ error: 'Incorrect email or password.' });
      return;
    }
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Incorrect email or password.' });
      return;
    }
    setSessionCookie(res, normEmail);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('auth-login error', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
