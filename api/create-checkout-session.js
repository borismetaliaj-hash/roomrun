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

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await saveUser(user);
      await redis.set(`stripeCustomer:${customerId}`, user.email);
    }

    const origin = `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error', e);
    res.status(500).json({ error: 'Could not start checkout. Try again.' });
  }
};
