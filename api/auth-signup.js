const { bcrypt, normalizeEmail, getUser, saveUser, setSessionCookie } = require('../lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { email, password } = req.body || {};
    const normEmail = normalizeEmail(email);

    if (!EMAIL_RE.test(normEmail)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (!password || String(password).length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    const existing = await getUser(normEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with that email already exists — try logging in instead.' });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = {
      email: normEmail,
      passwordHash,
      createdAt: Date.now(),
      trialStart: Date.now(),
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'trialing'
    };
    await saveUser(user);
    setSessionCookie(res, normEmail);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('auth-signup error', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
