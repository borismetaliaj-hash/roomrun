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

    // This existing-account check is also what stops the trial from ever being restarted —
    // trialStart below only ever gets written here, on a genuinely brand-new record. Someone
    // trying to "start over" by signing up again with the same email just gets sent to log in
    // instead, so their original trialStart (and however many days of it are left, including
    // zero) stays exactly what it was.
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
