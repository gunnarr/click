// Inloggning med engångskod till mejlen. Allowlist — det finns ingen registrering
// och ingen användardatabas.
//
// Allt tillstånd ligger i signerade cookies hos webbläsaren, inget i processen.
// Skälet är driftsättningen: launchd startar om tjänsten vid varje deploy, och
// deployer sker ofta. En sessionskarta i minnet hade loggat ut Gunnar flera gånger
// om dagen, vilket är exakt den friktion funktionen finns för att ta bort. Med
// signerade cookies är en omstart mitt i inloggningen en icke-händelse.

const crypto = require("node:crypto");

const SESSION_COOKIE = "click_sess";
const CHALLENGE_COOKIE = "click_chal";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dygn, glidande
const SESSION_MAX_MS = 180 * 24 * 60 * 60 * 1000; // absolut tak
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // förnya som mest en gång per dygn
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;

// --- testsömmar ---

let _now = () => Date.now();
let _randomInt = (max) => crypto.randomInt(max);
function _setClock(fn) {
  _now = fn || (() => Date.now());
}
function _setRandomInt(fn) {
  _randomInt = fn || ((max) => crypto.randomInt(max));
}

// --- konfiguration, läses lat så tester slipper require-cache-trick ---

function signingKey() {
  const raw = String(process.env.CLICK_SESSION_KEY || "").trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64,}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length >= 32 ? buf : null;
}

function allowlist() {
  return String(process.env.CLICK_ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const isAllowed = (email) => allowlist().includes(normalizeEmail(email));
const isConfigured = () => signingKey() !== null && allowlist().length > 0;

// --- signering ---

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

function sign(payload) {
  const key = signingKey();
  if (!key) throw new Error("CLICK_SESSION_KEY saknas");
  const body = `v1.${b64u(JSON.stringify(payload))}`;
  return `${body}.${b64u(crypto.createHmac("sha256", key).update(body).digest())}`;
}

function verify(raw) {
  const key = signingKey();
  if (!key || typeof raw !== "string" || raw.length > 4096) return null;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  let given;
  try {
    given = unb64u(parts[2]);
  } catch {
    return null;
  }
  // timingSafeEqual kastar vid olika längd — utan den här kollen blir en kapad
  // signatur ett 500 istället för ett 401.
  if (given.length !== 32) return null;

  const mac = crypto.createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  if (!crypto.timingSafeEqual(mac, given)) return null;

  let payload;
  try {
    payload = JSON.parse(unb64u(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.exp !== "number" || payload.exp <= _now()) return null;
  return payload;
}

// --- engångskod ---

// Sex siffror. Utredningen förordade 40 bitar, men dess egen analys konstaterar att
// en stulen session bara kan mejla Gunnar hans egna skärmdumpar. Mot den skadebilden
// räcker sex siffror med bibehållen per-IP-gräns, och det är vad varje annan tjänst
// använder. crypto.randomInt är avvisningsprovtagande och därmed utan modulo-bias.
function generatePin() {
  return String(_randomInt(1000000)).padStart(6, "0");
}

function normalizePin(input) {
  const digits = String(input || "").replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

// Koden hashas med sitt jti, så två utmaningar för samma siffror ger olika värden
// och cookien går inte att använda som uppslagsnyckel.
function pinHash(pin, jti) {
  return b64u(crypto.createHmac("sha256", signingKey()).update(`pin:${jti}:${pin}`).digest());
}

function makeChallenge(email, pin) {
  const jti = b64u(crypto.randomBytes(12));
  return sign({
    v: 1,
    t: "chal",
    sub: normalizeEmail(email),
    jti,
    ph: pinHash(pin, jti),
    n: 0,
    exp: _now() + CHALLENGE_TTL_MS,
  });
}

function readChallenge(raw) {
  const p = verify(raw);
  if (!p || p.t !== "chal") return null;
  if ((p.n || 0) >= MAX_PIN_ATTEMPTS) return null;
  return p;
}

const bumpChallenge = (chal) => sign({ ...chal, n: (chal.n || 0) + 1 });

function checkPin(chal, input) {
  const pin = normalizePin(input);
  if (!pin) return false;
  const expected = unb64u(chal.ph);
  const actual = unb64u(pinHash(pin, chal.jti));
  // Jämför alltid digest mot digest — aldrig kodsträngarna, som läcker längd.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// --- session ---

function makeSession(email, iat = _now()) {
  return sign({
    v: 1,
    t: "sess",
    email: normalizeEmail(email),
    tv: 1, // token-version; jämförs mot lagrat värde när persistensen finns
    iat,
    exp: _now() + SESSION_TTL_MS,
  });
}

function readSession(raw) {
  const p = verify(raw);
  if (!p || p.t !== "sess") return null;
  if (typeof p.iat !== "number" || _now() - p.iat > SESSION_MAX_MS) return null;
  // Att stryka adressen ur allowlisten återkallar sessionen direkt.
  if (!isAllowed(p.email)) return null;
  return p;
}

// --- cookies ---

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

const cookieBase = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_INSECURE !== "1",
  path: "/",
});

// Lax, inte Strict. En bookmarklet är en top-level cross-site GET-navigering.
// Strict skickar ingen cookie där — skärmdumpen kommer tillbaka som vanligt men
// oinloggad och omejlad, alltså ett tyst fel i precis det flöde funktionen finns för.
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, { ...cookieBase(), sameSite: "lax", maxAge: SESSION_TTL_MS });
}
const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, cookieBase());

// Utmaningen används bara av vår egen inloggningssida, aldrig cross-site.
// Strict gör därmed en cross-site POST till /auth/verify strukturellt omöjlig.
function setChallengeCookie(res, token) {
  res.cookie(CHALLENGE_COOKIE, token, {
    ...cookieBase(),
    sameSite: "strict",
    maxAge: CHALLENGE_TTL_MS,
  });
}
const clearChallengeCookie = (res) => res.clearCookie(CHALLENGE_COOKIE, cookieBase());

// Middleware: sätter req.session, avvisar aldrig. Registreras efter /health, så
// hälsokontrollen aldrig ens ser en cookie.
function attachSession(req, res, next) {
  req.session = isConfigured() ? readSession(readCookie(req, SESSION_COOKIE)) : null;
  next();
}

// Förnya som mest en gång per dygn, annars får en serie skärmdumpar en
// Set-Cookie var. iat följer med så det absoluta taket inte nollställs.
function maybeRenew(req, res) {
  const s = req.session;
  if (!s) return;
  if (s.exp - _now() > SESSION_TTL_MS - RENEW_AFTER_MS) return;
  setSessionCookie(res, makeSession(s.email, s.iat));
}

// --- CSRF ---

// Login-rutterna kräver JSON, vilket ett HTML-formulär inte kan producera
// utan preflight. Origin-kollen är andra lagret; Strict på utmaningen det tredje.
function sameOrigin(req) {
  const expected = process.env.CLICK_ORIGIN || "https://click.grj.se";
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") return origin === expected;
  const site = req.headers["sec-fetch-site"];
  return site === "same-origin" || site === undefined;
}

module.exports = {
  SESSION_COOKIE,
  CHALLENGE_COOKIE,
  SESSION_TTL_MS,
  CHALLENGE_TTL_MS,
  MAX_PIN_ATTEMPTS,
  isConfigured,
  isAllowed,
  normalizeEmail,
  generatePin,
  normalizePin,
  makeChallenge,
  readChallenge,
  bumpChallenge,
  checkPin,
  makeSession,
  readSession,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  setChallengeCookie,
  clearChallengeCookie,
  attachSession,
  maybeRenew,
  sameOrigin,
  _setClock,
  _setRandomInt,
};
