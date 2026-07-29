// Lets a logged-in, subscribed user manage or cancel their own subscription without emailing
// Boris to do it manually in the Stripe dashboard. Stripe hosts the whole update-card/
// cancel-subscription UI itself (the "Customer Portal") — this endpoint just opens a session
// for the current user's Stripe customer and hands back the URL to redirect to.
//
// One-time setup required in the Stripe dashboard before this works: Settings -> Billing ->
// Customer portal -> Activate/configure it (Stripe refuses to create a portal session for an
// account that's never had the portal configured, even in live mode).
const Stripe = require('stripe');
const { getUserFromRequest } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      res.status(500).json({ error: 'Stripe is not configured yet (missing STRIPE_SECRET_KEY).' });
      return;
    }
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Log in first.' });
      return;
    }
    if (!user.stripeCustomerId) {
      res.status(400).json({ error: "You don't have a subscription on file yet." });
      return;
    }

    // Same API version pin as create-checkout-session.js — this Stripe account has Managed
    // Payments enabled, which the default/older pinned API version in stripe-node rejects.
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-03-31.basil' });
    const origin = `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${origin}/`
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-portal-session error', e);
    res.status(500).json({ error: 'Could not open the billing portal. Try again.' });
  }
};
