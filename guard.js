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

function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_PER_WINDOW) {
    res.set("Retry-After", "300");
    return res.status(429).send("för många förfrågningar — försök igen om en stund");
  }
  recent.push(now);
  rateHits.set(ip, recent);
  if (rateHits.size > 5000) {
    for (const [k, v] of rateHits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateHits.delete(k);
    }
  }
  next();
}

// Global samtidighetsgräns — avvisar hellre än köar (Mac Pro 2013, 2 GB VRAM).
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
  withSlot,
  _internals: { dnsCache, rateHits, RATE_MAX_PER_WINDOW, MAX_CONCURRENT, REBOUND },
};
