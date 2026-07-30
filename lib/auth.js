const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const TRIAL_DAYS = 7;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const COOKIE_NAME = 'rr_session';

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is not set');
  return secret;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return `${body}.${hmac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, hmac] = token.split('.');
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// The session cookie only ever proves "this browser is currently logged in as this email" —
// its own `iat` (issued-at) timestamp resets on every login, which is fine, because nothing
// about the trial or subscription is ever computed from it. trialDaysLeft() below reads
// user.trialStart instead, which is a completely separate, permanent field on the user's own
// Redis record (see auth-signup.js). Logging out and back in re-issues this cookie, but never
// touches that record — so the trial clock genuinely can't restart just by logging out.
function setSessionCookie(res, email) {
  const token = sign({ email, iat: Date.now() });
  const maxAge = SESSION_TTL_SECONDS;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

async function getUser(email) {
  const key = `user:${normalizeEmail(email)}`;
  const data = await redis.get(key);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

async function saveUser(user) {
  const key = `user:${normalizeEmail(user.email)}`;
  await redis.set(key, JSON.stringify(user));
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const payload = verify(cookies[COOKIE_NAME]);
  if (!payload || !payload.email) return null;
  return getUser(payload.email);
}

// user.trialStart is set exactly once, in auth-signup.js, at account creation — nothing else
// in this codebase ever writes to it (auth-login.js only reads the existing record; logging
// out doesn't touch Redis at all; subscribing and cancelling only ever touch
// subscriptionStatus, never trialStart). That's what makes this genuinely a one-time-per-email
// trial: there's no code path, including logout/login or subscribe/cancel/resubscribe, that
// can reset this value once it exists. Signup itself also refuses to create a second account
// for an email that already has one (see auth-signup.js's existing-user check), so there's no
// way to get a fresh trialStart by "signing up again" either.
function trialDaysLeft(user) {
  if (!user || !user.trialStart) return 0;
  const elapsedMs = Date.now() - user.trialStart;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const left = Math.ceil(TRIAL_DAYS - elapsedDays);
  return Math.max(0, left);
}

function userStatus(user) {
  if (!user) {
    return { loggedIn: false, email: null, trialDaysLeft: 0, subscriptionActive: false, subscriptionStatus: null, accessGranted: false };
  }
  const subscriptionActive = user.subscriptionStatus === 'active';
  const daysLeft = trialDaysLeft(user);
  const accessGranted = subscriptionActive || daysLeft > 0;
  return {
    loggedIn: true,
    email: user.email,
    trialDaysLeft: daysLeft,
    subscriptionActive,
    subscriptionStatus: user.subscriptionStatus || 'trialing',
    accessGranted
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
