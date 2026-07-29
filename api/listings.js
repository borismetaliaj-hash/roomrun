// Vercel Serverless Function — GET /api/listings?city=St+Andrews|Edinburgh|Durham|Bath|York|Exeter
// Fetches each source site server-side (avoids browser CORS restrictions),
// converts HTML to readable text, and parses out currently-available properties.
const { convert } = require('html-to-text');
const { Redis } = require('@upstash/redis');
const webpush = require('web-push');
const redis = Redis.fromEnv();

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

// Sends one push per stored subscriber for `city`, then prunes any subscription the push
// service reports as gone (404/410 — expired or the user uninstalled/revoked it).
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

  const title = newItems.length === 1 ? '1 new listing in ' + city : newItems.length + ' new listings in ' + city;
  const body = newItems.slice(0, 3).map(i => i.address).join(' · ') + (newItems.length > 3 ? '…' : '');
  const payload = JSON.stringify({ title, body, url: 'https://roomrun.vercel.app/' });

  await Promise.all(entries.map(async ([endpoint, raw]) => {
    let sub;
    try { sub = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
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

// Per-city live sources. Rightmove/OnTheMarket/Zoopla/SpareRoom/Lettingweb (Alba St Andrews)
// and Morgan Douglas (Durham, explicit "no data mining" clause) are deliberately excluded —
// those stay manually-curated static snapshots in index.html, never live-scraped.
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
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
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

  // --- New-listing detection + push notifications ---
  // Only runs on a real scrape (i.e. right here, never on a cache hit), so this fires at
  // most once every CACHE_TTL_SECONDS regardless of how many people load the page.
  try {
    const seenKey = 'lastseen:' + city;
    const prevIds = await redis.smembers(seenKey).catch(() => []);
    const currentIds = fresh.listings.map(listingId);
    // Only notify if we have a real baseline from a previous scrape AND this isn't a
    // wholesale change (e.g. a parser rewrite shifting every id) — that guards against
    // ever blasting "52 new listings" to everyone from a false positive.
    if (prevIds && prevIds.length) {
      const prevSet = new Set(prevIds);
      const newItems = fresh.listings.filter((l) => !prevSet.has(listingId(l)));
      if (newItems.length && newItems.length < fresh.listings.length) {
        await notifyNewListings(city, newItems);
      }
    }
    if (currentIds.length) {
      await redis.del(seenKey).catch(() => {});
      await redis.sadd(seenKey, ...currentIds).catch(() => {});
    }
  } catch (e) {
    // Notification bookkeeping must never break the actual listings response.
  }

  return fresh;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Belt-and-braces: make sure no browser/CDN layer ever caches this response on top of our
  // intentional Redis cache above — that cache is the one source of truth for freshness.
  res.setHeader('Cache-Control', 'no-store');
  const city = (req.query && req.query.city) || 'St Andrews';
  const sources = CITY_SOURCES[city] || [];
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');

  const [sourceData, communityListings] = await Promise.all([
    getSourceData(city, sources, force),
    getCommunityListings(city)
  ]);

  res.status(200).json({
    listings: [...sourceData.listings, ...communityListings],
    errors: sourceData.errors,
    checkedAt: sourceData.checkedAt
  });
};
