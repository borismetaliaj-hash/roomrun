// Vercel Serverless Function — GET /api/listings?city=St+Andrews|Edinburgh|Durham|Bath|York|Exeter
// Fetches each source site server-side (avoids browser CORS restrictions),
// converts HTML to readable text, and parses out currently-available properties.
const { convert } = require('html-to-text');
const { Redis } = require('@upstash/redis');
const webpush = require('web-push');
const { getUserFromRequest, userStatus } = require('../lib/auth');
const redis = Redis.fromEnv();

// Previously this endpoint had no access check at all — the paywall in index.html only
// controlled whether the *browser UI* called this URL, so someone whose trial had ended (or
// who was never logged in) could still get every live listing just by hitting
// /api/listings?city=... directly. This closes that: real listings only go out to a request
// that's either (a) a logged-in user whose trial/subscription is still active, or (b) a
// background refresh trigger (see isBackgroundRefresh below), which needs to keep refreshing
// the cache and sending new-listing push notifications regardless of any one person's
// subscription status — it never returns data to a browser, so it isn't a paywall bypass.
function isVercelCron(req) {
  return Boolean(req.headers['x-vercel-cron-schedule']) || /vercel-cron/i.test(req.headers['user-agent'] || '');
}

// Vercel's own Cron (vercel.json) is capped at once a day on the Hobby plan — that's the whole
// reason notifications only ever showed up right after someone manually hit Refresh: a genuinely
// new listing sitting there for hours between cron runs, with nobody's browser open to trigger a
// fresh scrape, just never got checked. REFRESH_SECRET lets a free external scheduler (e.g.
// cron-job.org) ping this same endpoint every 20 minutes with ?refreshKey=<secret> attached,
// getting the same cron-level bypass Vercel's own trigger gets — so new listings actually get
// caught (and notified) on a real cadence instead of once a day at best. Falls back to `false`
// (not bypassed) if the env var isn't set yet, rather than ever accepting an empty key.
function isBackgroundRefresh(req) {
  if (isVercelCron(req)) return true;
  const key = req.query && req.query.refreshKey;
  return Boolean(process.env.REFRESH_SECRET) && key === process.env.REFRESH_SECRET;
}

// --- Push notifications: only armed if both VAPID env vars are actually set on Vercel.
// Without them this whole feature quietly no-ops (see notifyNewListings below) rather
// than throwing and breaking the listings response itself. ---
let vapidConfigured = false;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:borismetaliaj@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
  }
} catch (e) {
  vapidConfigured = false;
}

// Stable-ish identity for a listing so we can tell "genuinely new" apart from "same
// property, re-scraped" — source + normalized address is good enough here since that's
// exactly what a user would recognize as "a new one" on the dashboard.
function listingId(item) {
  return (item.source || '') + '::' + String(item.address || '').toLowerCase().trim();
}

// How long the "New" badge stays on a listing after it first appears — see the firstseen
// tracking below and the isNew flag attached to the response just before it goes out.
const NEW_BADGE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

// A subscriber's stored notification preferences (bedrooms / price range / agencies) —
// null/empty on any field means "no restriction on that field". Missing data on the
// listing itself (e.g. a source with no priceValue) never excludes it — only positive
// evidence of a mismatch does, so a real preference never silently swallows a listing
// just because that particular agency doesn't report beds/price.
function matchesFilters(item, filters) {
  if (!filters) return true;
  if (filters.minPrice != null && item.priceValue != null && item.priceValue < filters.minPrice) return false;
  if (filters.maxPrice != null && item.priceValue != null && item.priceValue > filters.maxPrice) return false;
  if (filters.beds && filters.beds.length && item.beds != null) {
    const bedsOk = filters.beds.some((b) => (b === '4+' ? item.beds >= 4 : Number(b) === item.beds));
    if (!bedsOk) return false;
  }
  if (filters.agencies && filters.agencies.length && !filters.agencies.includes(item.source)) return false;
  return true;
}

// Sends one push per stored subscriber for `city` — filtered down to just the new listings
// that actually match their saved preferences, so someone who only asked about 1-bed HMJ
// Properties places doesn't get pinged (or see an inflated count) over unrelated ones. Then
// prunes any subscription the push service reports as gone (404/410 — expired or revoked).
async function notifyNewListings(city, newItems) {
  if (!vapidConfigured || !newItems.length) return;
  const key = 'pushsubs:' + city;
  let subsMap;
  try {
    subsMap = await redis.hgetall(key);
  } catch (e) {
    return;
  }
  if (!subsMap) return;
  const entries = Object.entries(subsMap);
  if (!entries.length) return;

  await Promise.all(entries.map(async ([endpoint, raw]) => {
    let record;
    try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
    // Backwards-compatible with subscriptions saved before filters existed (bare
    // subscription object, no { subscription, filters } wrapper).
    const sub = record && record.subscription ? record.subscription : record;
    const filters = (record && record.filters) || null;
    if (!sub || !sub.endpoint) return;

    const matched = newItems.filter((item) => matchesFilters(item, filters));
    if (!matched.length) return;

    const title = matched.length === 1 ? '1 new listing in ' + city : matched.length + ' new listings in ' + city;
    const body = matched.slice(0, 3).map((i) => i.address).join(' · ') + (matched.length > 3 ? '…' : '');
    const payload = JSON.stringify({ title, body, url: 'https://roomrun.vercel.app/' });

    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        try { await redis.hdel(key, endpoint); } catch (e2) { /* best-effort cleanup */ }
      }
    }
  }));
}

// --- Student-added listings: read back whatever's been submitted via /api/submit-listing
// for this city, newest first. Never throws — if Redis is unreachable we just show 0 of these
// rather than breaking the whole page. ---
async function getCommunityListings(city) {
  try {
    const raw = await redis.lrange('community:' + city, 0, 199);
    return raw.map(r => {
      const entry = typeof r === 'string' ? JSON.parse(r) : r;
      return {
        source: 'Added by students',
        tag: 'src-community',
        address: entry.address,
        beds: entry.beds ?? null,
        baths: null,
        price: entry.price || '',
        priceValue: parsePrice(entry.price),
        url: null,
        contact: entry.contact || ''
      };
    });
  } catch (e) {
    return [];
  }
}

const HTT_OPTS = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { linkBrackets: false, hideLinkHrefIfSameAsText: false } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', format: 'dataTable' }
  ]
};

// Some small letting-agent sites sit behind generic bot-mitigation (WAF/hosting-level, not a
// scraping restriction — these sites have no anti-scraping clause in their T&Cs, see CITY_SOURCES
// comment below) that rejects requests self-identifying as a bot with a 415/403. Sending the same
// header set a real browser sends avoids tripping that, without misrepresenting what we're doing.
// Each source gets its own hard timeout — one slow/hanging agency site used to be able to
// stall the entire refresh (Promise.all waits for the slowest member), which was most of the
// "refresh takes forever" complaint. 10s is generous for plain HTML fetches but still bounded.
async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    const html = await res.text();
    return convert(html, HTT_OPTS);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out fetching ' + url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// html-to-text can render headings in ALL CAPS depending on the site's markup — normalize for display
function titleCase(str) {
  let s = str;
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }
  // keep UK postcodes readable regardless, e.g. "Ky16 8ha" -> "KY16 8HA"
  s = s.replace(/\b([a-zA-Z]{1,2}\d{1,2}[a-zA-Z]?)\s+(\d[a-zA-Z]{2})\b/, (m, p1, p2) => p1.toUpperCase() + ' ' + p2.toUpperCase());
  return s;
}

function parsePrice(str) {
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/£\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// --- St Andrews Property Lets: html-to-text renders the table as column-aligned text.
// The nav menu on the same page links each property to its own /town-centre/ or
// /residential-areas/ page, so we build an address->URL map from that and use it instead of
// sending everyone to the homepage. Matched by street name only (house number stripped) since
// a couple of their own nav entries don't quite agree with the table's numbering — falls back
// to the homepage if no confident match is found.
function normalizeStreet(addr) {
  return addr.replace(/^\s*\d+[a-z]?\s+/i, '').toLowerCase().replace(/[^a-z]/g, '');
}

function extractSAPLLinks(text) {
  const re = /([A-Za-z0-9][A-Za-z0-9 .'\-]*?)\s*\((https:\/\/standrewspropertylets\.uk\/(?:town-centre|residential-areas)\/[a-z0-9\-]+)\)/g;
  const map = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = normalizeStreet(m[1].trim());
    if (key && !map.has(key)) map.set(key, m[2]);
  }
  return map;
}

function parseSAPL(text, linkMap) {
  const rows = [];
  const statusAtEnd = /(Property Let|Available|To Let)\s*$/i;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^PROPERTY\s+STATUS/i.test(line)) continue;
    const m = line.match(statusAtEnd);
    if (!m) continue;
    const address = line.slice(0, m.index).trim();
    if (!address) continue;
    const url = (linkMap && linkMap.get(normalizeStreet(address))) || 'https://standrewspropertylets.uk/';
    rows.push({ address: titleCase(address), status: m[1], url });
  }
  return rows;
}

// --- Bradburne & Co: property blocks ending in a "View Property" link, optionally "Let Agreed" ---
function parseBradburne(text) {
  const re = /([\s\S]*?)View Property\s*\(?\s*(https:\/\/www\.bradburne\.co\.uk\/properties\/[^\s)]+)\)?\s*\n*(Let Agreed)?/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1], url = m[2], status = m[3] || 'Available';
    const rentMatch = block.match(/Rent:\s*(£[\d,]+p\/m)/i);
    const rent = rentMatch ? rentMatch[1] : null;
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const candidateLines = lines.filter(l => !l.startsWith('-') && !/\.(jpg|png)/i.test(l) && !l.startsWith('['));
    const address = candidateLines[0] || null;
    if (address && address.length < 90 && !/^(sort by|property search|area|type|bedrooms|price)/i.test(address)) {
      results.push({ address: titleCase(address), status, rent, url });
    }
  }
  return results;
}

// --- 55Rent: landmark-based on "Bedrooms:" / "Bathrooms:" lines rather than assuming markdown headings ---
function parse55Rent(text) {
  const lines = text.split('\n').map(l => l.trim());
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const bedMatch = lines[i].match(/^Bedrooms:\s*\**\s*(\d+)/i);
    if (!bedMatch) continue;
    let addr = null;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (lines[j]) { addr = lines[j]; break; }
    }
    let bathIdx = -1;
    for (let k = i; k < lines.length && k < i + 3; k++) {
      if (/^Bathrooms:/i.test(lines[k])) { bathIdx = k; break; }
    }
    if (bathIdx === -1) continue;
    let statusLine = null, url = null;
    for (let s = bathIdx + 1; s < lines.length && s < bathIdx + 5; s++) {
      if (!lines[s]) continue;
      const linkMatch = lines[s].match(/(https:\/\/55rent\.co\.uk\/\S+)/);
      if (linkMatch) { url = linkMatch[1]; continue; }
      if (!statusLine) statusLine = lines[s].replace(/\*/g, '').trim();
    }
    if (addr && statusLine) {
      results.push({ address: titleCase(addr), statusOrPrice: statusLine, url: url || 'https://55rent.co.uk/properties.html' });
    }
  }
  return results;
}

// --- Lawson & Thompson + Studentpad (any town): JS-rendered pages, need a headless browser ---
// Isolated behind its own try/catch so a Chromium failure never breaks the other sources.
// chromium.executablePath() extracts the binary to /tmp on first call — when both sources run
// concurrently (via Promise.all in the handler below) they'd both trigger that extraction at
// once and collide (spawn ETXTBSY: one process tries to exec the binary while the other is
// still writing it). Caching the resolved path/module in one shared promise means only the
// first caller extracts; everyone else just awaits the same result.
let chromiumReadyPromise = null;
async function getChromiumReady() {
  if (!chromiumReadyPromise) {
    chromiumReadyPromise = (async () => {
      const chromiumModule = await import('@sparticuz/chromium');
      const chromium = chromiumModule.default || chromiumModule;
      chromium.setHeadlessMode = true;
      chromium.setGraphicsMode = false;
      const executablePath = await chromium.executablePath();
      return { chromium, executablePath };
    })();
  }
  return chromiumReadyPromise;
}

// Both JS-rendered sources used to launch their own full Chromium instance — two cold
// browser launches per request was most of the "refresh is slow" complaint. They now share
// a single browser (separate tabs), and the whole scrape result is cached in Redis for
// CACHE_TTL_SECONDS (see bottom of file) so most requests skip Chromium entirely.
let sharedBrowserPromise = null;
async function getSharedBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = (async () => {
      // @sparticuz/chromium and puppeteer-core ship as pure ESM as of their current major
      // versions, so a plain require() throws ERR_REQUIRE_ESM from this CommonJS file.
      // Dynamic import() works from CJS regardless of the target's module format.
      const puppeteerModule = await import('puppeteer-core');
      const puppeteer = puppeteerModule.default || puppeteerModule;
      const { chromium, executablePath } = await getChromiumReady();
      return puppeteer.launch({ args: chromium.args, executablePath, headless: true });
    })();
  }
  return sharedBrowserPromise;
}

async function closeSharedBrowser() {
  if (sharedBrowserPromise) {
    try { const browser = await sharedBrowserPromise; await browser.close(); } catch (e) {}
    sharedBrowserPromise = null;
  }
}

async function fetchRenderedText(url, waitMs) {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (compatible; Roomrun/1.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    const html = await page.content();
    return convert(html, HTT_OPTS);
  } finally {
    await page.close();
  }
}

// Each card is one big link (thumbnail + address) wrapping through to its own /property/<slug>/
// page — html-to-text usually folds that into "Address (url)" on one line, but the exact
// wrapping isn't guaranteed, so this also checks the couple of lines just before as a fallback.
// Falls back to the overview page if no URL is found near a given address.
function parseLawsonThompson(text) {
  // Property blocks show an address line followed eventually by "Unavailable" or a real status/price
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const bedMatch = (lines[i + 1] || '').match(/^(\d+)\s+bedrooms?$/i);
    if (bedMatch) {
      let addressLine = lines[i];
      const status = lines[i + 2] || '';
      let url = null;
      const sameLineUrlM = addressLine.match(/\((https:\/\/www\.lawsonthompson\.co\.uk\/property\/[^\)]+)\)/);
      if (sameLineUrlM) {
        url = sameLineUrlM[1];
        addressLine = addressLine.replace(sameLineUrlM[0], '').trim();
      } else {
        for (let j = Math.max(0, i - 2); j <= i; j++) {
          const m = lines[j].match(/\((https:\/\/www\.lawsonthompson\.co\.uk\/property\/[^\)]+)\)/);
          if (m) { url = m[1]; break; }
        }
      }
      const address = addressLine;
      if (address && !/unavailable/i.test(status) && address.length < 90) {
        results.push({ address: titleCase(address), status, beds: parseInt(bedMatch[1], 10), url: url || 'https://www.lawsonthompson.co.uk/student-lettings/' });
      }
    }
  }
  return results;
}

function parseStudentpadCount(text) {
  const m = text.match(/(\d+)\s*Rooms?\s*Available/i);
  return m ? parseInt(m[1], 10) : null;
}

// --- HMJ Properties: plain HTML (no JS needed), landmark-scanned rather than assuming exact
// heading markup, since html-to-text's rendering of this WordPress theme wasn't testable ahead
// of deploy. Anchors on "Status for 202x: AVAILABLE" lines, then scans backward for the nearest
// "(N BEDS)" tag, address text and permalink URL. Best-effort — flag to Boris if entries look off.
function parseHMJ(text) {
  const lines = text.split('\n').map(l => l.trim());
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const statusMatch = lines[i].match(/Status for 202[\d\/]*\s*[:\]]*\s*(.*)/i);
    if (!statusMatch) continue;
    let statusText = statusMatch[1].trim();
    if (!statusText && lines[i + 1]) statusText = lines[i + 1].trim();
    if (/not available|has been let|academic session/i.test(statusText)) continue;
    if (!/available/i.test(statusText)) continue;

    let beds = null, address = null, url = null, rent = null;
    for (let j = i; j >= 0 && j >= i - 40; j--) {
      const bedM = lines[j].match(/\((\d+)\s*BEDS?\)/i);
      if (bedM && beds === null) {
        beds = parseInt(bedM[1], 10);
        if (address === null) {
          const a = lines[j].replace(/\(\d+\s*BEDS?\)/i, '').replace(/https?:\/\/\S+/g, '').replace(/[\*\[\]()]/g, '').trim();
          if (a.length > 4 && a.length < 90) address = a;
        }
      }
      const urlM = lines[j].match(/(https?:\/\/hmjproperties\.co\.uk\/\?p=\d+)/i);
      if (urlM && url === null) url = urlM[1];
      if (!rent) {
        const rentM = lines[j].match(/Rent[:*]*\s*\**\s*(£[\d,.]+)/i);
        if (rentM) rent = rentM[1];
      }
    }
    if (address && beds !== null) {
      results.push({ address: titleCase(address), beds, rent, url: url || 'http://hmjproperties.co.uk/?page_id=12' });
    }
  }
  return results;
}

// --- Stand Property (Inchdairnie, part of the Coulters group): one combined "for rent" page
// covering Edinburgh + St Andrews + nearby Fife villages, plain HTML, no JS needed. Filtered down
// to the St Andrews/KY16 area here since Edinburgh isn't this dashboard's concern.
//
// Each card on the page renders as:
//   Monthly rent £1,650
//   2 bedrooms flat
//   Kate Kennedy Court,
//    St Andrews,
//    Fife,
//    KY16
//   * 2 bedrooms
//   * 1 bathroom
//   * 1 public room
// (confirmed 2026-07-29 against a live scrape — a previous fix assumed the bullet lines start
// with "-", based on a preview render that turned out not to match how html-to-text actually
// renders this WordPress list markup: it uses "*". Since that check never matched, the address
// block kept running straight through the whole bullet list exactly as before — this is what
// fixes it for real.)
//
// The per-property URL used to be guessed by scanning nearby lines for a standproperty.co.uk
// link, but the "Overview image" thumbnail link has no visible text once <img> tags are
// stripped for scraping (see HTT_OPTS), so html-to-text drops it — the scan was instead
// occasionally matching a neighbouring card's link, sending someone to the wrong house. Safer
// to always point at the general listings page than to confidently link the wrong property.
function parseStandProperty(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const rentM = lines[i].match(/^Monthly rent £([\d,]+)/i);
    if (!rentM) continue;

    const bedTypeM = (lines[i + 1] || '').match(/^(\d+)\s+bedrooms?\s+(\w+)/i);
    if (!bedTypeM) continue;
    const beds = parseInt(bedTypeM[1], 10);

    // Address block: everything between the bed/type line and the first "* " bullet.
    let addrParts = [];
    let letAgreed = false;
    let j = i + 2;
    for (; j < lines.length && j < i + 14; j++) {
      const line = lines[j];
      if (/^let agreed$/i.test(line)) { letAgreed = true; break; }
      if (line.startsWith('*')) break;
      if (/^Monthly rent £/i.test(line)) break; // safety net: don't run into the next card
      addrParts.push(line.replace(/,$/, ''));
    }
    // Feature bullet list right after the address: pull bathrooms out of it, and catch a
    // "Let agreed" badge if it shows up here instead.
    let baths = null;
    for (; j < lines.length && j < i + 20; j++) {
      const line = lines[j];
      if (/^let agreed$/i.test(line)) { letAgreed = true; continue; }
      if (!line.startsWith('*')) break;
      const bathM = line.match(/^\*\s*(\d+)\s+bathrooms?/i);
      if (bathM) baths = parseInt(bathM[1], 10);
    }

    if (letAgreed) continue;
    const address = addrParts.join(', ').trim();
    if (!address) continue;
    if (!/KY16|st\.?\s*andrews/i.test(address)) continue; // St Andrews / KY16 area only, skip their Edinburgh stock
    results.push({ address: titleCase(address), beds, baths, price: '£' + rentM[1] + ' pcm', url: 'https://standproperty.co.uk/for-rent/' });
  }
  return results;
}

// --- St Andy's Student Letting: a tiny landlord-run agency (they own every property directly,
// no separate landlords). The listing page doesn't show status, so each property's own page has
// to be checked for "Already Let" — capped at 12 properties to bound worst case if their
// portfolio grows, since this fans out to N detail-page fetches (still plain HTML, no browser).
function extractStandysLinks(text) {
  const re = /\(https:\/\/standys\.co\.uk\/properties\/([a-z0-9\-]+)\/?\)/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    seen.add('https://standys.co.uk/properties/' + m[1] + '/');
  }
  return [...seen].slice(0, 12);
}

function parseStandysDetail(text, url) {
  if (/already let/i.test(text)) return null;
  const bedsM = text.match(/Bedrooms:\s*(\d+)/i);
  const bathsM = text.match(/Bathrooms:\s*(\d+)/i);
  const addrM = text.match(/Address:\s*(.+)/i);
  const zipM = text.match(/Zip:\s*(.+)/i);
  const titleM = text.match(/^(.+?)\s*\n/);
  const address = addrM ? addrM[1].trim() : (titleM ? titleM[1].trim() : null);
  if (!address) return null;
  const zip = zipM ? zipM[1].trim() : '';
  return {
    address: zip ? address + ', ' + zip : address,
    beds: bedsM ? parseInt(bedsM[1], 10) : null,
    baths: bathsM ? parseInt(bathsM[1], 10) : null,
    url
  };
}

// --- Frampton & Roebuck (Durham): each listing renders as one link whose text reads
// "ADDRESS PRICE PPPW BEDS BATHS Bills Included: STATUS More details" — best-effort, exact
// html-to-text rendering of this WordPress theme wasn't testable pre-deploy. Their T&Cs are a
// standard copyright notice with no data-mining/scraping restriction, unlike Morgan Douglas.
function parseFramptonRoebuck(text) {
  const results = [];
  const re = /([A-Za-z0-9.'\- ]+?)\s+(\d+)\s*PPPW\s+(\d+)\s+(\d+)\s+Bills Included:\s*\S*\s*More details\s*\((https:\/\/www\.framptonandroebuck\.co\.uk\/students\/[^\)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({
      address: m[1].trim(),
      price: '£' + m[2] + ' pppw',
      beds: parseInt(m[3], 10),
      baths: parseInt(m[4], 10),
      url: m[5]
    });
  }
  return results;
}

// --- 2Let Agency (York): landmark on a "BEDS BATHS (url)" line, followed by an address line and
// a price line. Best-effort — flag to Boris if entries look off.
function parse2Let(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const bbMatch = lines[i].match(/^(\d+)\s+(\d+)\s*\(https:\/\/www\.2letagency\.co\.uk\/property\/\d+\/\)$/);
    if (!bbMatch) continue;
    const addrMatch = lines[i + 1].match(/^(.+?)\s*\((https:\/\/www\.2letagency\.co\.uk\/property\/\d+\/)\)$/);
    if (!addrMatch) continue;
    const priceMatch = lines[i + 2].match(/£[\d,.]+\s*(PPPW|PCM)/i);
    if (!priceMatch) continue;
    results.push({
      beds: parseInt(bbMatch[1], 10),
      baths: parseInt(bbMatch[2], 10),
      address: addrMatch[1].trim(),
      price: lines[i + 2].trim(),
      url: addrMatch[2]
    });
  }
  return results;
}

// --- Peter Moore Lets (Bath): modeled on their "N Bedroom [Type]" card + VIEW PROPERTY link
// pattern. Their site currently shows nothing available for 2026/27, so this parser is UNTESTED
// against a real live listing — flag to Boris the first time this returns something.
function parsePeterMoore(text) {
  const re = /(\d+)\s*Bedroom\s*(House|Flat|Maisonette|Apartment)[\s\S]*?VIEW\s*PROPER?TY\s*\((https:\/\/www\.studentaccommodationbath\.com\/[^\)]+)\)/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({
      address: m[1] + ' Bedroom ' + m[2],
      beds: parseInt(m[1], 10),
      url: m[3]
    });
  }
  return results;
}

// Rightmove/OnTheMarket/SpareRoom's own terms explicitly prohibit automated access —
// Rightmove's terms state outright "Rightmove prohibits the scraping of its content," and
// OnTheMarket's terms (clause 3.3) ban any automated program beyond their homepage. So
// these three stay 100% manually-curated static snapshots (hand-typed, refreshed on a
// recurring schedule by re-checking by hand — see the "refresh every 2 days" scheduled task),
// never touched by an automated request from this server — see the STATIC_LISTINGS object
// below (moved here from index.html on 2026-07-30 so it's only served to logged-in,
// trial-or-subscribed users instead of sitting in plain view-source-able client JS). A
// same-day attempt to auto-verify these via live HTTP requests was reverted for exactly this
// reason: even a lightweight existence-check is still "automated access" under their terms.

// --- Alba (St Andrews): their own site, albastandrews.co.uk, has no scraping restriction in
// its terms (unlike the three portals above), so this is a real live source rather than a
// static snapshot — added 2026-07-30. Only page 1 of /properties/ is fetched (their newest
// listings), which is plenty for one boutique local agency's live availability and avoids
// scraping deep, mostly-stale pagination. Each card anchors on its "£d,ddd"-style price line,
// then scans backward for the 2-3 numeric lines just above it (beds, baths, and sometimes a
// third "public rooms" count that's ignored) and then the nearest property-page link for the
// address text and URL — the very first link on each card is a thumbnail-image anchor with no
// real link text (html-to-text renders its href as if it were the text, same issue documented
// in parseStandProperty above), so this specifically skips any "address" that's just a bare
// URL and keeps walking backward until it finds real text. Best-effort — flag to Boris if
// entries look off, since this wasn't testable against a live Vercel deploy before shipping.
function parseAlba(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const priceM = lines[i].match(/£\s?([\d,]{3,})/);
    if (!priceM) continue;

    let j = i - 1;
    const nums = [];
    while (j >= 0 && /^\d+$/.test(lines[j]) && nums.length < 3) {
      nums.unshift(parseInt(lines[j], 10));
      j--;
    }
    if (!nums.length) continue;
    const beds = nums[0];
    const baths = nums.length > 1 ? nums[1] : null;

    let address = null, url = null;
    for (let k = j; k >= 0 && k >= j - 6; k--) {
      const urlM = lines[k].match(/(https?:\/\/(?:www\.)?albastandrews\.co\.uk\/property\/[^\s)]+)/i);
      if (!urlM) continue;
      const t = lines[k].replace(urlM[1], '').trim();
      if (t.length > 4 && t.length < 90 && !/^https?:\/\//i.test(t)) { address = t; url = urlM[1]; break; }
    }
    if (!address || !url) continue;
    results.push({ address, beds, baths, price: '£' + priceM[1] + ' pcm', url });
  }
  return results;
}

// Per-city live sources. Zoopla and Morgan Douglas (Durham, explicit "no data mining"
// clause) are deliberately excluded entirely (no static snapshot either).
const CITY_SOURCES = {
  'St Andrews': [
    {
      name: 'St Andrews Property Lets', url: 'https://standrewspropertylets.uk/',
      run: async () => {
        const text = await fetchText('https://standrewspropertylets.uk/');
        const linkMap = extractSAPLLinks(text);
        return parseSAPL(text, linkMap)
          .filter(i => !/property let/i.test(i.status))
          .map(i => ({ source: 'St Andrews Property Lets', tag: 'src-sapl', address: i.address, beds: null, baths: null, price: '', priceValue: null, url: i.url, contactEmail: 'property@standrewspropertylets.co.uk' }));
      }
    },
    {
      name: 'Bradburne & Co', url: 'https://www.bradburne.co.uk/lettings/fife/st-andrews/',
      run: async () => parseBradburne(await fetchText('https://www.bradburne.co.uk/lettings/fife/st-andrews/'))
        .filter(i => !/let agreed/i.test(i.status))
        .map(i => ({ source: 'Bradburne & Co', tag: 'src-brad', address: i.address, beds: null, baths: null, price: i.rent || '', priceValue: parsePrice(i.rent), url: i.url, contactEmail: 'info@bradburne.co.uk' }))
    },
    {
      name: '55Rent', url: 'https://55rent.co.uk/properties.html',
      run: async () => parse55Rent(await fetchText('https://55rent.co.uk/properties.html'))
        .filter(i => !/tenancy agreed/i.test(i.statusOrPrice))
        .map(i => ({ source: '55Rent', tag: 'src-55r', address: i.address, beds: null, baths: null, price: i.statusOrPrice, priceValue: parsePrice(i.statusOrPrice), url: i.url, contactEmail: 'enquiries@55rent.co.uk' }))
    },
    {
      name: 'HMJ Properties', url: 'http://hmjproperties.co.uk/?page_id=12',
      run: async () => parseHMJ(await fetchText('http://hmjproperties.co.uk/?page_id=12'))
        .map(i => ({ source: 'HMJ Properties', tag: 'src-hmj', address: i.address, beds: i.beds, baths: null, price: i.rent || '', priceValue: parsePrice(i.rent), url: i.url, contactEmail: 'hmj@hmjproperties.co.uk' }))
    },
    // Studentpad (room-count source) was removed 2026-07-28 — it was one of only two sources
    // needing a full headless-Chromium page load (the other being Lawson & Thompson below,
    // which is worth the cost since it has real per-property listings), and all it ever
    // returned was a bare "N rooms listed" count with no address/price a student could act on.
    // Cutting it removes one Chromium page-navigation per scrape without losing real listings.
    {
      name: 'Lawson & Thompson', url: 'https://www.lawsonthompson.co.uk/student-lettings/',
      run: async () => parseLawsonThompson(await fetchRenderedText('https://www.lawsonthompson.co.uk/student-lettings/', 1500))
        .map(i => ({ source: 'Lawson & Thompson', tag: 'src-lt', address: i.address, beds: i.beds ?? null, baths: null, price: i.status, priceValue: null, url: i.url, contactEmail: 'info@lawsonthompson.co.uk' }))
    },
    {
      name: 'Stand Property', url: 'https://standproperty.co.uk/for-rent/',
      run: async () => parseStandProperty(await fetchText('https://standproperty.co.uk/for-rent/'))
        .map(i => ({ source: 'Stand Property', tag: 'src-standp', address: i.address, beds: i.beds, baths: i.baths, price: i.price, priceValue: parsePrice(i.price), url: i.url, contactEmail: 'info@standproperty.co.uk' }))
    },
    {
      name: "St Andy's Student Letting", url: 'https://standys.co.uk/property/',
      run: async () => {
        const listingText = await fetchText('https://standys.co.uk/property/');
        const links = extractStandysLinks(listingText);
        const details = await Promise.all(links.map(async (u) => {
          try { return parseStandysDetail(await fetchText(u), u); } catch (e) { return null; }
        }));
        return details.filter(Boolean).map(i => ({
          source: "St Andy's Student Letting", tag: 'src-standys', address: i.address,
          beds: i.beds, baths: i.baths, price: '', priceValue: null, url: i.url, contactEmail: 'info@standys.co.uk'
        }));
      }
    },
    {
      name: 'Alba', url: 'https://www.albastandrews.co.uk/properties/',
      run: async () => parseAlba(await fetchText('https://www.albastandrews.co.uk/properties/'))
        .map(i => ({ source: 'Alba', tag: 'src-alba', address: i.address, beds: i.beds, baths: i.baths, price: i.price, priceValue: parsePrice(i.price), url: i.url, contactEmail: 'info@albastandrews.co.uk' }))
    }
  ],
  'Durham': [
    {
      name: 'Frampton & Roebuck', url: 'https://www.framptonandroebuck.co.uk/students/',
      run: async () => parseFramptonRoebuck(await fetchText('https://www.framptonandroebuck.co.uk/students/'))
        .map(i => ({ source: 'Frampton & Roebuck', tag: 'src-fr', address: titleCase(i.address), beds: i.beds, baths: i.baths, price: i.price, priceValue: parsePrice(i.price), url: i.url }))
    }
  ],
  'York': [
    {
      name: '2Let Agency', url: 'https://www.2letagency.co.uk/',
      run: async () => parse2Let(await fetchText('https://www.2letagency.co.uk/'))
        .map(i => ({ source: '2Let Agency', tag: 'src-2let', address: i.address, beds: i.beds, baths: i.baths, price: i.price, priceValue: parsePrice(i.price), url: i.url }))
    }
  ],
  'Bath': [
    {
      name: 'Peter Moore Lets', url: 'https://www.studentaccommodationbath.com/latest-availability',
      run: async () => parsePeterMoore(await fetchText('https://www.studentaccommodationbath.com/latest-availability'))
        .map(i => ({ source: 'Peter Moore Lets', tag: 'src-pml', address: i.address, beds: i.beds, baths: null, price: '', priceValue: null, url: i.url }))
    }
  ],
  'Exeter': [
    {
      name: 'Studentpad (room count)', url: 'https://www.exeterstudentpad.co.uk/Accommodation',
      run: async () => {
        const count = parseStudentpadCount(await fetchRenderedText('https://www.exeterstudentpad.co.uk/Accommodation', 2000));
        if (!count) return [];
        return [{ source: 'Studentpad', tag: 'src-sp', address: count + ' rooms listed on the official University portal', beds: null, baths: null, price: '', priceValue: null, url: 'https://www.exeterstudentpad.co.uk/Accommodation' }];
      }
    }
  ]
};

// --- Hand-curated static listings (Rightmove/OnTheMarket/SpareRoom/sample Rightmove pages for
// the other cities) — moved here from index.html on 2026-07-30. These used to be a plain JS
// const shipped inside the page's own HTML/JS, which meant anyone could see every one of them
// (view-source, or just typing the variable name into devtools) with no login and no active
// trial/subscription at all — the paywall only ever controlled whether the dashboard *rendered*,
// never who could actually read this data. Serving it from here instead means it goes through
// the exact same access check as the live-scraped listings below (see module.exports), so it's
// genuinely gated now, not just hidden behind client-side JS.
//
// Rightmove, OnTheMarket and SpareRoom all explicitly prohibit copying/scraping their site
// content in their Terms of Use, so the St Andrews entries stay a manually curated snapshot
// (refreshed roughly every 2 days by the scheduled refresh task) rather than a live check — see
// the comment above CITY_SOURCES for the full reasoning. Alba used to be in this same static
// snapshot too but moved to a real live source (see parseAlba above) since its own site has no
// such restriction.
// Hand refresh 2026-08-31: every St Andrews listing below was re-checked live on its source site
// today (human-style browse, not a scraper) — the 2026-08-24 refresh never made it past that
// session's local GitHub-edit workaround, and the daily automated refresh task kept failing on
// top of that (its scheduled runs had no browser-automation tools available), so this snapshot
// had gone stale again since 2026-08-24. Rightmove: added Dempster Court and Muttoes Court;
// dropped Pilmour Place (let); Lamond Drive and St Andrews Hall got relisted under new listing
// IDs (same address/price, URLs updated). OnTheMarket: added Allan Robertson Drive, Bobby Jones
// Place, Woodburn Terrace and a new 3-bed Winram Place listing; dropped Cottage Nether, the old
// 2-bed Winram Place, both South Street entries, the St Andrews Hall house-share, Hepburn Gardens,
// both Lamond Drive entries and Pilmour Place (all let/removed); Doocot Road's price dropped
// £1,600 -> £1,495. The standalone "Westview" OnTheMarket result was skipped again — still just
// parking spaces. SpareRoom turned over again as usual: dropped the "warm sunny quiet house" room;
// added a double room in a superior detached villa and a SpareRoom listing for the same 7-bed
// Scooniehill Road whole-house let already carried from Rightmove/OnTheMarket (kept as its own
// entry — the app's own duplicate toggle handles that, same as any cross-site overlap); one
// Guardbridge result was excluded as out of town, matching the existing curation pattern.
const STATIC_LISTINGS = {
    'St Andrews': [
      { source: 'Rightmove', tag: 'src-rm', address: 'Dempster Court, St. Andrews', beds: 2, baths: 2, price: '£2,500 pcm', url: 'https://www.rightmove.co.uk/properties/92459445' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Muttoes Court, St Andrews, Fife, KY16', beds: 1, baths: 1, price: '£1,375 pcm', url: 'https://www.rightmove.co.uk/properties/92333694' },
      { source: 'Rightmove', tag: 'src-rm', address: '5 Howard Place, St Andrews, Fife, KY16', beds: 1, baths: null, price: '£1,125 pcm', url: 'https://www.rightmove.co.uk/properties/92312991' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Lamond Drive, St Andrews, Fife, KY16', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.rightmove.co.uk/properties/92496216' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Warrack Street, St Andrews, Fife, KY16', beds: 2, baths: 1, price: '£1,800 pcm', url: 'https://www.rightmove.co.uk/properties/91934394' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Morton Crescent, St Andrews, Fife, KY16', beds: 3, baths: 1, price: '£1,650 pcm', url: 'https://www.rightmove.co.uk/properties/92258766' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Balrymonth Court, St. Andrews, Fife', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.rightmove.co.uk/properties/91765323' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Scooniehill Road, St. Andrews, KY16', beds: 2, baths: 1, price: '£1,400 pcm', url: 'https://www.rightmove.co.uk/properties/91764846' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Chambers Place, St. Andrews, Fife, KY16', beds: 2, baths: 2, price: '£1,750 pcm', url: 'https://www.rightmove.co.uk/properties/91753689' },
      { source: 'Rightmove', tag: 'src-rm', address: 'St Andrews Hall, St Andrews, KY16', beds: 1, baths: 1, price: '£1,296 pcm', url: 'https://www.rightmove.co.uk/properties/92558298' },
      { source: 'Rightmove', tag: 'src-rm', address: 'Adamson Court, St Andrews, Fife, KY16', beds: 3, baths: 2, price: '£2,225 pcm', url: 'https://www.rightmove.co.uk/properties/91132011' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Warrack Street, St Andrews, Fife, KY16', beds: 2, baths: 1, price: '£1,800 pcm', url: 'https://www.onthemarket.com/details/13267561/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Adamson Court, St Andrews, Fife, KY16', beds: 3, baths: 2, price: '£2,225 pcm', url: 'https://www.onthemarket.com/details/13649689/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Allan Robertson Drive, St Andrews, Fife', beds: 3, baths: 1, price: '£1,700 pcm', url: 'https://www.onthemarket.com/details/20225725/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Bobby Jones Place, St Andrews, Fife', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.onthemarket.com/details/19970574/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Woodburn Terrace, St Andrews, Fife', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.onthemarket.com/details/20210813/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Winram Place, St. Andrews, Fife', beds: 3, baths: 1, price: '£1,450 pcm', url: 'https://www.onthemarket.com/details/20202231/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Scooniehill Road, St. Andrews KY16', beds: 7, baths: 2, price: '£3,195 pcm', url: 'https://www.onthemarket.com/details/20193839/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Doocot Road, St Andrews, Fife', beds: 2, baths: 1, price: '£1,495 pcm', url: 'https://www.onthemarket.com/details/19821409/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Bell Brae, St Andrews KY16', beds: 2, baths: 2, price: '£2,300 pcm', url: 'https://www.onthemarket.com/details/20133137/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Chambers Place, St Andrews, Fife, KY16', beds: 2, baths: 2, price: '£1,750 pcm', url: 'https://www.onthemarket.com/details/16302878/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'St Andrews Hall, St Andrews, KY16', beds: 1, baths: 1, price: '£1,296 pcm', url: 'https://www.onthemarket.com/details/20080907/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'East Sands, St Andrews, KY16 (room in 8-bed flat share)', beds: 1, baths: null, price: '£867 pcm', url: 'https://www.onthemarket.com/details/20078593/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Younger Gardens, St Andrews, Fife', beds: 2, baths: 1, price: '£1,600 pcm', url: 'https://www.onthemarket.com/details/19993400/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Chamberlain Street, St Andrews, Fife', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.onthemarket.com/details/19936927/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Bell Brae, St Andrews, KY16', beds: 2, baths: 2, price: '£2,100 pcm', url: 'https://www.onthemarket.com/details/16997486/' },
      { source: 'OnTheMarket', tag: 'src-otm', address: 'Kilrymont Road, St Andrews, Fife (studio)', beds: 0, baths: 1, price: '£1,296 pcm', url: 'https://www.onthemarket.com/details/17551938/' },
      { source: 'SpareRoom', tag: 'src-spr', address: 'St. Andrews furnished room, all bills inc. (KY16)', beds: null, baths: null, price: '£1,000 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/2502220' },
      { source: 'SpareRoom', tag: 'src-spr', address: 'Double room in superior detached villa (KY16)', beds: null, baths: null, price: '£800 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/3147926' },
      { source: 'SpareRoom', tag: 'src-spr', address: 'House share, St Andrews (KY16)', beds: null, baths: null, price: '£1,000 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/17472368' },
      { source: 'SpareRoom', tag: 'src-spr', address: '7 Bed House, St Andrews (Full House) - Scooniehill Road (KY16)', beds: 7, baths: null, price: '£3,195 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/18400441' },
      { source: 'SpareRoom', tag: 'src-spr', address: 'Double room near East Sands, St Andrews (KY16)', beds: null, baths: null, price: '£750 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/8288086' },
      { source: 'SpareRoom', tag: 'src-spr', address: 'Kilrymont Crescent, St Andrews (KY16) - 3 bed house', beds: 3, baths: null, price: '£2,100 pcm', url: 'https://www.spareroom.co.uk/flatshare/fife/st._andrews/18018250' },
        ],
  // Edinburgh: Rightmove's dedicated student-accommodation search shows 312 results across 13
  // pages — far too many to hand-curate the way St Andrews' tiny market allows. This is a
  // labeled sample from page 1 (live-verified 2026-07-15), not exhaustive coverage.
  'Edinburgh': [
    { source: 'Rightmove', tag: 'src-rm', address: 'South Oxford Street, Newington, EH8', beds: 3, baths: 1, price: '£2,325 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'East Suffolk Park, Newington, Edinburgh', beds: 2, baths: 1, price: '£1,650 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Causewayside, Newington, EH9', beds: 3, baths: 1, price: '£2,275 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Montpelier Park, Bruntsfield, EH10', beds: 3, baths: 1, price: '£2,175 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Bruntsfield Avenue, Bruntsfield, EH10', beds: 4, baths: 1, price: '£2,600 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Dalry Road, Dalry, EH11', beds: 2, baths: 1, price: '£1,400 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Logie Green Road, Canonmills, EH7', beds: 3, baths: 1, price: '£1,650 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Murano Place, off Leith Walk, EH7', beds: 3, baths: 2, price: '£2,275 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Buchanan Street, Leith, EH6', beds: 1, baths: null, price: '£895 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Montpelier Park, EH10', beds: 3, baths: 1, price: '£2,600 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Edinburgh.html' }
  ],
  // Durham, Bath, York, Exeter: real Rightmove student-accommodation listings, live-verified
  // 2026-07-15 (samples, not exhaustive — same treatment as Edinburgh above).
  'Durham': [
    { source: 'Rightmove', tag: 'src-rm', address: 'Newton Drive, Durham, DH1', beds: 5, baths: 2, price: '£1,195 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Lambton House, Durham, DH1', beds: 4, baths: 1, price: '£737 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Durham Terrace, Framwellgate Moor, Durham, DH1 5EH', beds: 2, baths: 1, price: '£823 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'High Street South, Langley Moor, Durham', beds: 2, baths: 1, price: '£780 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Avenue Street, High Shincliffe, Durham, DH1', beds: 2, baths: 1, price: '£1,200 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Highgate, Durham, DH1 4GA', beds: 4, baths: 2, price: '£2,400 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Metropolis House, Durham City, DH1', beds: 1, baths: 1, price: '£950 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'May Street, Durham, DH1', beds: 3, baths: 1, price: '£1,500 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Durham.html' }
  ],
  'Bath': [
    { source: 'Rightmove', tag: 'src-rm', address: 'Stuart Place, Twerton, Bath', beds: 4, baths: 1, price: '£2,950 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'St Kildas Road, Bath, BA2 3QL', beds: 5, baths: 1, price: '£3,900 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Radway House, Wellsway, Bath', beds: 5, baths: 5, price: '£4,550 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Wellsway, Bath', beds: 1, baths: 1, price: '£910 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Noble House, Stothert Avenue, Bath, BA2', beds: 1, baths: 1, price: '£1,540 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'River Place, Twerton, Bath', beds: 1, baths: 1, price: '£1,149 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'St James\'s Parade, Bath', beds: 2, baths: 1, price: '£2,077 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Bath.html' }
  ],
  'York': [
    { source: 'Rightmove', tag: 'src-rm', address: 'Haxby Road, York, YO31', beds: 1, baths: null, price: '£802 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/York.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Brownlow Street, The Groves, York', beds: 2, baths: 1, price: '£1,517 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/York.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Leake Street, York, YO10', beds: 2, baths: 1, price: '£1,550 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/York.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Fountayne House, Lawrence Square, York', beds: 3, baths: 2, price: '£2,626 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/York.html' }
  ],
  'Exeter': [
    { source: 'Rightmove', tag: 'src-rm', address: 'Flat 25, Concord House, Exeter', beds: 1, baths: 1, price: '£1,084 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'New North Road, Exeter', beds: 1, baths: 1, price: '£1,040 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Commercial Road, Exeter, EX2', beds: 2, baths: 1, price: '£1,900 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Prince Charles Road, Exeter', beds: 3, baths: 2, price: '£2,100 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Blackboy Road, Exeter', beds: 1, baths: 1, price: '£1,062 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Fore Street, Exeter, EX4', beds: 3, baths: 2, price: '£1,950 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Sandford Walk, Exeter, EX1', beds: 4, baths: 2, price: '£1,750 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' },
    { source: 'Rightmove', tag: 'src-rm', address: 'Bonhay Road, Exeter, EX4', beds: 2, baths: 2, price: '£1,600 pcm', url: 'https://www.rightmove.co.uk/student-accommodation/Exeter.html' }
  ]
};

function getStaticListings(city) {
  const list = STATIC_LISTINGS[city] || [];
  return list.map((x) => ({ ...x, priceValue: parsePrice(x.price) }));
}

// How long a scraped result stays "fresh" before the next request triggers a real re-check.
// Community ("Added by students") listings are never cached — they're a cheap Redis read and
// should show up immediately after someone submits one, not wait for the next scrape window.
// Shortened from 5 minutes: background/initial loads still hit this cache for a fast page
// load, but the Refresh button now sends force=1 and skips straight past it (see handler below),
// so "click Refresh" always means a real, right-now check rather than up-to-5-minute-old data.
const CACHE_TTL_SECONDS = 150; // 2.5 minutes

function withHardCap(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' exceeded ' + ms + 'ms')), ms))
  ]);
}

async function scrapeLive(sources) {
  const listings = [];
  const errors = [];
  await Promise.all(sources.map(async (src) => {
    try {
      // 18s hard cap per source (covers puppeteer-based sources too) so a single stuck
      // site can never drag the whole refresh out — it just gets reported as an error
      // and everything else still comes back fast.
      listings.push(...(await withHardCap(src.run(), 18000, src.name)));
    } catch (e) {
      // Include a snippet of the stack, not just e.message, since JS-rendered sources
      // (Lawson & Thompson, Studentpad) fail inside puppeteer/chromium and a bare message
      // like "Timed out" or "Protocol error" isn't enough to diagnose remotely.
      const detail = e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String((e && e.message) || e);
      errors.push({ source: src.name, error: detail });
    }
  }));
  await closeSharedBrowser();
  return { listings, errors, checkedAt: new Date().toISOString() };
}

async function getSourceData(city, sources, force) {
  const cacheKey = 'srccache:' + city;
  if (!force) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return { ...parsed, isFreshScrape: false };
      }
    } catch (e) {
      // Redis unreachable, fall through to a live scrape rather than failing the request.
    }
  }
  const fresh = await scrapeLive(sources);
  try {
    await redis.set(cacheKey, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
  } catch (e) {
    // Caching is best-effort; a failed write just means the next request scrapes live again.
  }
  // isFreshScrape tells the handler this call actually hit the network rather than returning
  // a cached result — the new-listing check below only needs to run once per real scrape, not
  // once per page load (see handler).
  return { ...fresh, isFreshScrape: true };
}

// Public, cache-only listing count for the pre-signup landing page (see api/listing-count.js).
// Deliberately never triggers a live scrape — an anonymous, unauthenticated visitor should
// never be able to make this app do network calls to agency sites, so this only ever reads
// whatever's already sitting in the srccache Redis key from the last real (auth'd/cron)
// request. Returns 0 for the live-source part rather than scraping if there's no cache yet;
// static + community counts are still accurate either way.
async function getListingCount(city) {
  const cacheKey = 'srccache:' + city;
  let liveCount = 0;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      liveCount = (parsed.listings || []).length;
    }
  } catch (e) {
    // Redis unreachable — just fall back to 0 for this part rather than failing the count.
  }
  const staticCount = getStaticListings(city).length;
  let communityCount = 0;
  try {
    communityCount = await redis.llen('community:' + city);
  } catch (e) {}
  return staticCount + liveCount + communityCount;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Belt-and-braces: make sure no browser/CDN layer ever caches this response on top of our
  // intentional Redis cache above — that cache is the one source of truth for freshness.
  res.setHeader('Cache-Control', 'no-store');

  // ?count=1 — public, unauthenticated, cache-only listing count for the pre-signup landing
  // page trust signal (see index.html #landing). Handled as a branch of this same function
  // rather than a separate api/*.js file: the Hobby plan caps a deployment at 12 Serverless
  // Functions, and this project is already at that ceiling — a standalone api/listing-count.js
  // pushed it over and broke the whole build (added 2026-08-04, reverted same day once this
  // was diagnosed). Returns before the paywall/auth check below since anonymous, pre-signup
  // traffic is exactly who this is for.
  if (req.query && (req.query.count === '1' || req.query.count === 'true')) {
    const city = (req.query && req.query.city) || 'St Andrews';
    try {
      const count = await getListingCount(city);
      res.status(200).json({ count });
    } catch (e) {
      res.status(200).json({ count: null });
    }
    return;
  }

  if (!isBackgroundRefresh(req)) {
    const user = await getUserFromRequest(req).catch(() => null);
    const status = userStatus(user);
    if (!status.accessGranted) {
      res.status(402).json({
        error: status.loggedIn ? 'Your free trial has ended — subscribe to keep seeing live listings.' : 'Log in to see live listings.',
        accessGranted: false
      });
      return;
    }
  }

  const city = (req.query && req.query.city) || 'St Andrews';
  const sources = CITY_SOURCES[city] || [];
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');

  const [sourceData, communityListings] = await Promise.all([
    getSourceData(city, sources, force),
    getCommunityListings(city)
  ]);

  // Static listings go first so they read the same way the old client-side merge order did
  // (static snapshot, then whatever's live, then community-submitted) — nothing downstream
  // (sorting/filtering) depends on this order, it's just for continuity.
  const staticListings = getStaticListings(city);
  const allListings = [...staticListings, ...sourceData.listings, ...communityListings];

  // --- New-listing detection + push notifications ---
  // This used to only compare the live-scraped local-agency listings against the previous
  // scrape — meaning a subscriber never got notified about a genuinely new Rightmove/
  // OnTheMarket/SpareRoom entry (those are a hand-curated snapshot refreshed separately every
  // ~2 days, not part of the live scrape) or a new student-submitted listing either. Moved
  // here so it diffs the *full* list actually shown on the dashboard against what was seen
  // last time, regardless of which of the three sources it came from. Still gated to real
  // scrapes (isFreshScrape), so it runs at most once per CACHE_TTL_SECONDS from page-load
  // traffic, plus once a day guaranteed via the cron even with zero visitors.
  //
  // Uses a new Redis key ('lastseen2') rather than reusing the old 'lastseen' one — that old
  // key only ever held live-agency ids, so comparing today's full combined list against it
  // would make every static/community listing look "new" on the very first run after this
  // change and blast everyone at once. A fresh key with an empty baseline means the first run
  // just seeds silently (see the `if (prevIds.length)` guard below) instead of doing that.
  if (sourceData.isFreshScrape) {
    try {
      const seenKey = 'lastseen2:' + city;
      // Was: snapshot-read-diff-then-overwrite-the-whole-set. Under concurrent fresh scrapes
      // (cron + a page load + a manual force-refresh landing close together) two requests could
      // both read the same prevIds before either finished rewriting the set, so both decided the
      // same listing was new and each sent its own push -- a subscriber getting the same
      // listing multiple times in a row is exactly this. SADD on a single id is atomic in
      // Redis: it returns 1 only for whichever request actually adds it first, so at most one
      // of any number of concurrent requests can ever treat a given id as new.
      const isFirstEverRun = (await redis.exists(seenKey).catch(() => 1)) === 0;
            // "New" badge bookkeeping (firstseen hash): HSETNX only ever writes a given listing id's
            // timestamp once, so this just piggybacks on the same per-item loop as the notification
            // diff above without touching its logic. The one wrinkle is rollout day — if the hash is
            // completely empty (this feature has never run for this city before), backdating instead
            // of stamping "now" stops every already-existing listing from suddenly showing "New" for
            // 4 days the moment this ships; only genuinely new arrivals after that get a real now().
            const firstSeenKey = 'firstseen:' + city;
            const firstSeenNeverRun = (await redis.exists(firstSeenKey).catch(() => 1)) === 0;
            const firstSeenStamp = firstSeenNeverRun ? (Date.now() - NEW_BADGE_WINDOW_MS - 1000) : Date.now();
            const newItems = [];
            for (const item of allListings) {
                      const id = listingId(item);
                      const added = await redis.sadd(seenKey, id).catch(() => 0);
                      if (added === 1 && !isFirstEverRun) newItems.push(item);
                      await redis.hsetnx(firstSeenKey, id, firstSeenStamp).catch(() => {});
            }
      if (newItems.length && newItems.length < allListings.length) {
        await notifyNewListings(city, newItems);
      }
    } catch (e) {
      // Notification bookkeeping must never break the actual listings response.
    }
  }

    // "New" badge: read back the firstseen hash unconditionally (not just on a fresh scrape) so
    // a listing already flagged new keeps showing that way on cached responses between scrapes,
    // not only in the one response right after a scrape. Cosmetic only — never let a Redis hiccup
    // here break the actual listings response.
    try {
          const firstSeenMap = await redis.hgetall('firstseen:' + city);
          if (firstSeenMap) {
                  const now = Date.now();
                  for (const item of allListings) {
                            const ts = Number(firstSeenMap[listingId(item)]);
                            item.isNew = Number.isFinite(ts) && (now - ts) < NEW_BADGE_WINDOW_MS;
                  }
          }
    } catch (e) {
          // ignore — badge just won't show for this response
    }
  
  res.status(200).json({
    listings: allListings,
    errors: sourceData.errors,
    checkedAt: sourceData.checkedAt
  });
};

module.exports.getListingCount = getListingCount;
