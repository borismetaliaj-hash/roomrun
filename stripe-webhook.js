// POST /api/stripe-webhook — Stripe calls this when subscription state changes. Needs the raw
// request body (not the auto-parsed JSON) to verify the signature, hence bodyParsing: false.
//
// Requires: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (from Stripe dashboard > Webhooks, once
// this endpoint's URL — https://<your-domain>/api/stripe-webhook — is registered there).
const Stripe = require('stripe');
const { redis, getUser, saveUser } = require('../lib/auth');

module.exports.config = { api: { bodyParsing: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end('POST only'); return; }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    res.status(400).send('Webhook signature verification failed: ' + e.message);
    return;
  }

  try {
    async function userByCustomerId(customerId) {
      const email = await redis.get('stripeCustomer:' + customerId);
      if (!email) return null;
      return getUser(email);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || null;
      let user = email ? await getUser(email) : null;
      if (!user && session.customer) user = await userByCustomerId(session.customer);
      if (user) {
        user.stripeCustomerId = session.customer;
        user.stripeSubscriptionId = session.subscription;
        user.subscriptionStatus = 'active';
        await saveUser(user);
        await redis.set('stripeCustomer:' + session.customer, user.email);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = await userByCustomerId(sub.customer);
      if (user) {
        user.subscriptionStatus = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : sub.status;
        await saveUser(user);
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
