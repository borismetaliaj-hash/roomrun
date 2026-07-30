const Stripe = require('stripe');
const { redis, getUser, saveUser } = require('../lib/auth');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end('Method not allowed');
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    res.status(500).end('Stripe not configured');
    return;
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    res.status(400).end(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = await redis.get(`stripeCustomer:${session.customer}`);
      if (email) {
        const user = await getUser(email);
        if (user) {
          user.subscriptionStatus = 'active';
          user.stripeSubscriptionId = session.subscription;
          user.stripeCustomerId = session.customer;
          await saveUser(user);
        }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const email = await redis.get(`stripeCustomer:${sub.customer}`);
      if (email) {
        const user = await getUser(email);
        if (user) {
          // When someone cancels from the billing portal, Stripe (by default) marks the
          // subscription cancel_at_period_end: true but leaves sub.status === 'active' for
          // the rest of the days they already paid for — it only actually becomes
          // 'canceled' (firing customer.subscription.deleted, or .updated with the new
          // status) once that paid period genuinely ends. Mirroring sub.status here as-is
          // means access correctly continues through the days they paid for, then drops —
          // this endpoint never grants extra access, and never resets user.trialStart, so
          // there's no way cancelling (or resubscribing later) hands out a second free trial.
          // NOTE: this "keeps access until period end" behaviour depends on the Stripe
          // Customer Portal being configured to cancel at period end rather than immediately
          // (Stripe dashboard -> Settings -> Billing -> Customer portal -> Cancellations) —
          // worth double-checking that setting if this ever looks wrong in practice.
          user.subscriptionStatus = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : sub.status;
          await saveUser(user);
        }
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe-webhook handling error', e);
    res.status(500).end('Webhook handler error');
  }
};
