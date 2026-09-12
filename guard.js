const dns = require("dns").promises;
const net = require("net");

// SSRF-skydd: privata/reserverade nät får aldrig nås via screenshots.
function isPrivateIPv4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  return (
    o[0] === 0 ||
    o[0] === 10 ||
    o[0] === 127 ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT, inkl. Tailscale
    (o[0] === 169 && o[1] === 254) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 0 && o[2] === 0) ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 198 && (o[1] === 18 || o[1] === 19)) ||
    o[0] >= 224
  );
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "broadcasthost"]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".ts.net", ".localhost"];

const dnsCache = new Map(); // hostname -> { ok, expires }
const DNS_CACHE_TTL_MS = 60 * 1000;

async function hostnameIsPublic(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) return false;
  if (!host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return !isPrivateAddress(bare);

  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.ok;

  let ok = false;
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    ok = false;
  }
  dnsCache.set(host, { ok, expires: Date.now() + DNS_CACHE_TTL_MS });
  return ok;
}

async function validateTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "ogiltig URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "bara http/https tillåts" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URL med inloggningsuppgifter tillåts inte" };
  }
  if (!(await hostnameIsPublic(parsed.hostname))) {
    return { ok: false, reason: "adressen är inte publikt nåbar" };
  }
  return { ok: true };
}

// Sätts på page-objektet när en respons faktiskt kom från en intern IP.
const REBOUND = Symbol("clickReboundTo");

// Blockerar sidans alla underanrop (inkl. redirects) mot interna adresser.
//
// Namnkontrollen nedan hindrar uppslag mot interna *namn*, men Chrome gör sin egen
// DNS-uppslagning — en angripare med kort TTL kan svara publikt när vi validerar och
// privat när Chrome hämtar (DNS-rebinding). Därför kontrolleras dessutom vilken IP
// varje respons faktiskt kom från; träffar vi en intern adress kasseras hela bilden.
async function guardPage(page) {
  page[REBOUND] = null;

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const u = new URL(req.url());
      if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") {
        return await req.continue();
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return await req.abort();
      if (await hostnameIsPublic(u.hostname)) return await req.continue();
      return await req.abort("blockedbyclient");
    } catch {
      try { await req.abort(); } catch { /* redan hanterad */ }
    }
  });

  page.on("response", (res) => {
    try {
      const ip = res.remoteAddress()?.ip;
      if (ip && isPrivateAddress(ip)) page[REBOUND] = ip;
    } catch { /* remoteAddress saknas för data:/cachade svar */ }
  });
}

// Kastar om sidan hann nå en intern adress. Den interna IP:n hamnar bara i serverloggen
// — att skicka tillbaka den skulle bekräfta vilka adresser som finns bakom brandväggen.
function assertNoPrivateAccess(page) {
  const ip = page[REBOUND];
  if (!ip) return;
  console.error(`[guard] blockerade svar från intern adress ${ip}`);
  throw new Error("målet pekade om till en intern adress");
}

// Per-IP rate limit, glidande fönster.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 20;
const rateHits = new Map();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// cf-connecting-ip är bara trovärdig när anropet kom in via cloudflared på loopback.
// Når någon porten direkt (Tailscale/LAN) kan headern sättas fritt, och då skulle den
// annars ge en gratis nollställning av rate limit-räknaren.
function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || req.ip || "unknown";
  if (!LOOPBACK.has(socketIp)) return socketIp;
  const header = req.headers["cf-connecting-ip"];
  if (typeof header !== "string") return socketIp;
  const first = header.split(",")[0].trim();
  return first || socketIp;
}

// Mekanismen är densamma överallt; budgetarna är det inte. En Chrome-flik och ett
// mejl i en människas inkorg kostar olika mycket. Fabriken gör att varje ny gräns
// ärver clientIp-logiken istället för att återuppfinna den.
function slidingWindow({ windowMs, max, keyFn = clientIp, message, json = false, hits = new Map() }) {
  const mw = (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return json ? res.status(429).json({ error: message }) : res.status(429).send(message);
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    next();
  };
  mw._hits = hits;
  return mw;
}

const rateLimit = slidingWindow({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX_PER_WINDOW,
  message: "för många förfrågningar — försök igen om en stund",
  hits: rateHits,
});

// Ett mejl till en riktig inkorg är dyrare än en skärmdump. Egen budget, så att en
// inloggningsflod inte kan låsa ute Gunnar från själva tjänsten.
const loginLimit = slidingWindow({
  windowMs: 15 * 60 * 1000, max: 3, json: true,
  message: "för många inloggningsförsök — vänta en stund",
});

// Inkorgen är en delad resurs, så per-IP räcker inte mot en spridd flod.
const loginGlobalLimit = slidingWindow({
  windowMs: 15 * 60 * 1000, max: 8, json: true, keyFn: () => "global",
  message: "för många inloggningsförsök — vänta en stund",
});

const verifyLimit = slidingWindow({
  windowMs: 15 * 60 * 1000, max: 10, json: true,
  message: "för många försök — vänta en stund",
});

// Global samtidighetsgräns — avvisar hellre än köar. Varje Chrome-flik kostar minne
// och GPU, och maskinen har mer nytta av att svara 429 än av att svälla.
const MAX_CONCURRENT = 3;
let activeSlots = 0;

async function withSlot(fn) {
  if (activeSlots >= MAX_CONCURRENT) {
    const err = new Error("upptagen — försök igen strax");
    err.busy = true;
    throw err;
  }
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
  }
}

// Puppeteers felmeddelanden innehåller absoluta sökvägar och därmed serverns
// användarnamn. Endpointen är publik — sökvägarna stannar i loggen.
function publicMessage(err) {
  const raw = (err && err.message) || "okänt fel";
  return raw
    .replace(/\/(?:Users|home|root)\/[^\s'"`)]*/g, "<sökväg>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

module.exports = {
  isPrivateAddress,
  hostnameIsPublic,
  validateTargetUrl,
  guardPage,
  assertNoPrivateAccess,
  clientIp,
  publicMessage,
  rateLimit,
  slidingWindow,
  loginLimit,
  loginGlobalLimit,
  verifyLimit,
  withSlot,
  _internals: { dnsCache, rateHits, RATE_MAX_PER_WINDOW, MAX_CONCURRENT, REBOUND },
};
