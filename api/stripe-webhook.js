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
