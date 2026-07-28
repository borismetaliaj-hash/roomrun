// POST /api/create-checkout-session — logged-in user only. Creates a Stripe Checkout session for
// the £1.99/month plan and returns its hosted-page URL. No trial_period_days here — the free
// week already happened app-side before someone hits the paywall, so this is a straight
// "subscribe now" checkout, not a second trial stacked on top.
//
// Requires these Vercel env vars once Boris has a Stripe account set up:
//   STRIPE_SECRET_KEY   — from the Stripe dashboard (Developers > API keys)
//   STRIPE_PRICE_ID     — the Price ID for the £1.99/month recurring product
const Stripe = require('stripe');
const { getUserFromRequest, saveUser, redis } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
      res.status(500).json({ error: 'Payments are not configured yet — STRIPE_SECRET_KEY / STRIPE_PRICE_ID missing.' });
      return;
    }
    const user = await getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Log in first.' }); return; }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await saveUser(user);
      await redis.set('stripeCustomer:' + customerId, user.email);
    }

    const origin = (req.headers.origin) || ('https://' + req.headers.host);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: origin + '/?checkout=success',
      cancel_url: origin + '/?checkout=cancelled'
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
