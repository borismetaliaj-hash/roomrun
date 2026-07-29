const Stripe = require('stripe');
const { getUserFromRequest, saveUser, redis } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
      res.status(500).json({ error: 'Stripe is not configured yet (missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID).' });
      return;
    }
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Log in first.' });
      return;
    }

    // Boris's Stripe account has "Managed Payments" enabled, which requires API version
    // 2025-03-31.basil or newer — the installed stripe-node library defaults to an older
    // pinned version (2025-02-24.acacia) that Stripe now rejects outright for this account
    // ("Managed Payments is not supported on API version..."). Pinning it here explicitly
    // avoids depending on whatever version happens to ship with the library.
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-03-31.basil' });

    // Some accounts (Boris's included) got a stripeCustomerId saved while the app was
    // still pointed at Stripe test mode. That ID doesn't exist under the live secret key,
    // so Stripe throws "No such customer" (resource_missing) on checkout — a real live
    // customer just never got created for these users when we switched to live mode.
    // createCustomer() covers both the normal first-time case and this stale-ID case.
    async function createCustomer() {
      const customer = await stripe.customers.create({ email: user.email });
      user.stripeCustomerId = customer.id;
      await saveUser(user);
      await redis.set(`stripeCustomer:${customer.id}`, user.email);
      return customer.id;
    }

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      customerId = await createCustomer();
    }

    const origin = `https://${req.headers.host}`;
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancelled`
      });
    } catch (e) {
      const isStaleCustomer = e && e.code === 'resource_missing' && e.param === 'customer';
      if (!isStaleCustomer) throw e;
      customerId = await createCustomer();
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancelled`
      });
    }

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error', e);
    res.status(500).json({ error: 'Could not start checkout. Try again.' });
  }
};
