// Shared auth/session helpers. Lives outside /api on purpose — Vercel's zero-config Node
// builder turns every file directly under /api into its own route, so a shared helper module
// has to sit in /lib (or anywhere else) to be safely require()'d without becoming an endpoint.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

const TRIAL_DAYS = 7;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET env var is not set — required to sign login sessions.');
  return s;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}

function signToken(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('hex');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('hex');
  // Constant-time compare to avoid timing attacks on the signature check.
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(base64urlDecode(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, email) {
  const exp = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = signToken({ email, exp });
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie',
    `rr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${isProd ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'rr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function getUser(email) {
  const raw = await redis.get('user:' + normalizeEmail(email));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveUser(user) {
  await redis.set('user:' + user.email, JSON.stringify(user));
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const payload = verifyToken(cookies.rr_session);
  if (!payload || !payload.email) return null;
  return getUser(payload.email);
}

function trialDaysLeft(user) {
  const start = new Date(user.trialStart).getTime();
  const elapsedMs = Date.now() - start;
  const leftMs = TRIAL_DAYS * 24 * 60 * 60 * 1000 - elapsedMs;
  return Math.max(0, Math.ceil(leftMs / (24 * 60 * 60 * 1000)));
}

function userStatus(user) {
  if (!user) return { loggedIn: false, accessGranted: false };
  const daysLeft = trialDaysLeft(user);
  const subscriptionActive = user.subscriptionStatus === 'active';
  return {
    loggedIn: true,
    email: user.email,
    trialDaysLeft: daysLeft,
    subscriptionActive,
    subscriptionStatus: user.subscriptionStatus || 'trialing',
    accessGranted: subscriptionActive || daysLeft > 0
  };
}

module.exports = {
  TRIAL_DAYS,
  bcrypt,
  redis,
  normalizeEmail,
  getUser,
  saveUser,
  getUserFromRequest,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  userStatus,
  trialDaysLeft
};
