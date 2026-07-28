// POST /api/auth-signup — { email, password }
// Creates the account and immediately starts the 7-day free trial. No card is collected here —
// trial access is tracked purely in Redis, Stripe only gets involved once someone actually
// subscribes (see create-checkout-session.js). This matches "free for a week, then pay to
// continue" rather than "enter a card now and get auto-charged" — friendlier for a student
// audience that's understandably wary of surprise charges.
const { bcrypt, normalizeEmail, getUser, saveUser, setSessionCookie } = require('../lib/auth');

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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }
    const existing = await getUser(email);
    if (existing) {
      res.status(409).json({ error: 'An account with that email already exists — try logging in.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
      trialStart: new Date().toISOString(),
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'trialing'
    };
    await saveUser(user);
    setSessionCookie(res, email);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
