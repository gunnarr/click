const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
const archiver = require("archiver");
const { recordError, getErrorRate, ERROR_THRESHOLD } = require("./error-tracker");
const {
  validateTargetUrl,
  guardPage,
  assertNoPrivateAccess,
  publicMessage,
  rateLimit,
  loginLimit,
  loginGlobalLimit,
  verifyLimit,
  clientIp,
  withSlot,
} = require("./guard");
const mailer = require("./mailer");
const auth = require("./auth");
const { mailerStatus } = mailer;

const app = express();
const PORT = 3131;

// Tjänsten exponeras via en tunnel som kör på samma maskin, så loopback räcker.
// Att lyssna brett gör rate limit-headern spoofbar för alla som når porten direkt.
// Sätt HOST=0.0.0.0 om servern medvetet ska nås direkt över nätverket.
const HOST = process.env.HOST || "127.0.0.1";

// Chrome renderar godtyckliga sidor från internet — sandboxen ska vara på. (Flaggorna
// --no-sandbox/--disable-setuid-sandbox är ett Linux-som-root-recept och behövs inte här.)
const BROWSER_ARGS = [];

const GOTO_TIMEOUT_MS = 30000;
// /shot/all tar fem bilder i följd bakom en tunnel som bryter vid 100 s. Kortare
// per-bild-timeout håller hela ZIP:en innanför den gränsen.
const ALL_GOTO_TIMEOUT_MS = 12000;

const BASE_URL = "https://click.grj.se";
const startedAt = Date.now();

app.use(express.static(path.join(__dirname, "public")));

const ANALYTICS = `
  <script async src="https://s.grj.se/js/pa-aExm7a8ErYTh7VPXLbZz7.js"></script>
  <script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>`;

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .container { text-align: center; width: 600px; }
  h1 { margin-bottom: 1.5rem; font-weight: 300; font-size: 2rem; }
  form { display: flex; gap: 0.5rem; }
  label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
  input { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #333; background: #16213e; color: #eee; font-size: 1rem; }
  input::placeholder { color: #888; }
  input:focus { border-color: #5b8ad0; outline: 2px solid #5b8ad0; outline-offset: 1px; }
  button { padding: 0.75rem 1.5rem; border-radius: 8px; border: none; background: #d03050; color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: #b02a44; }
  button:focus-visible { outline: 2px solid #5b8ad0; outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: wait; }
  .status { margin-top: 1rem; min-height: 1.5rem; color: #aaa; }
  .preview { margin-top: 1.5rem; }
  .preview img { border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
  .download { display: inline-block; margin-top: 1rem; color: #f06680; text-decoration: underline; font-weight: 500; }
  .download:focus-visible { outline: 2px solid #5b8ad0; outline-offset: 2px; }
  nav { margin-top: 2rem; }
  nav a { color: #aaa; text-decoration: none; }
  nav a:focus-visible { outline: 2px solid #5b8ad0; outline-offset: 2px; }`;

// --- Variant config ---

const VARIANTS = {
  desktop: {
    path: "/",
    shotPath: "/shot",
    title: "Click",
    emoji: "📸",
    label: "Desktop",
    hint: "Desktop 1280×800",
    suffix: "",
    viewport: { width: 1280, height: 800 },
  },
  mobile: {
    path: "/mobile",
    shotPath: "/shot/mobile",
    title: "Click Mobile",
    emoji: "📱",
    label: "Mobil",
    hint: "iPhone 390×844 med ram",
    suffix: "-mobile",
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    frame: {
      viewportWidth: 540, viewportHeight: 1060,
      html: `<div class="device"><div class="screen"><img src="DATA"></div></div>`,
      css: `
        .device { width:430px;height:932px;border-radius:54px;border:6px solid #2a2a2a;background:#000;padding:18px 14px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.5),inset 0 0 0 2px #3a3a3a; }
        .device::before { content:'';position:absolute;top:14px;left:50%;transform:translateX(-50%);width:120px;height:28px;background:#1a1a1a;border-radius:14px;z-index:10; }
        .screen { width:100%;height:100%;border-radius:40px;overflow:hidden; }
        .screen img { width:100%;height:100%;object-fit:cover;object-position:top; }`,
    },
    tall: true,
  },
  tablet: {
    path: "/tablet",
    shotPath: "/shot/tablet",
    title: "Click iPad",
    emoji: "📋",
    label: "iPad",
    hint: "iPad 820×1180 med ram",
    suffix: "-tablet",
    viewport: { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    frame: {
      viewportWidth: 620, viewportHeight: 880,
      html: `<div class="device"><div class="screen"><img src="DATA"></div></div>`,
      css: `
        .device { width:560px;height:780px;border-radius:24px;border:8px solid #2a2a2a;background:#000;padding:20px 16px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.5),inset 0 0 0 2px #3a3a3a; }
        .device::before { content:'';position:absolute;top:10px;left:50%;transform:translateX(-50%);width:6px;height:6px;background:#1a1a1a;border-radius:50%;z-index:10; }
        .screen { width:100%;height:100%;border-radius:12px;overflow:hidden; }
        .screen img { width:100%;height:100%;object-fit:cover;object-position:top; }`,
    },
    tall: true,
  },
  big: {
    path: "/big",
    shotPath: "/shot/big",
    title: "Click Big",
    emoji: "🖥️",
    label: "Stor",
    hint: "Stor desktop 1720×1410",
    suffix: "-big",
    viewport: { width: 1720, height: 1410 },
  },
  full: {
    path: "/full",
    shotPath: "/shot/full",
    title: "Click Full",
    emoji: "📜",
    label: "Full",
    hint: "Hela sidan 1280px bred",
    suffix: "-full",
    viewport: { width: 1280, height: 800 },
    fullPage: true,
    tall: true,
  },
};

const VARIANT_KEYS = Object.keys(VARIANTS);

// --- Persistent browser ---

let browserInstance = null;
let browserLaunch = null;
let launcher = () => puppeteer.launch({ args: BROWSER_ARGS });

// Samtidiga anrop måste dela på en och samma launch. Utan den delade promisen startar
// varje väntande anrop en egen Chrome, och alla utom den sista blir föräldralösa.
async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  if (!browserLaunch) {
    browserLaunch = Promise.resolve()
      .then(launcher)
      .then((browser) => {
        browserInstance = browser;
        browser.on("disconnected", () => {
          browserInstance = null;
          browserLaunch = null;
        });
        return browser;
      })
      .finally(() => {
        browserLaunch = null;
      });
  }
  return browserLaunch;
}

// Inject a browser instance (for testing without launching Puppeteer).
function _setBrowserInstance(mock) {
  browserInstance = mock;
  browserLaunch = null;
}

// Replace the launch function (for testing the launch path without a real Chrome).
function _setLauncher(fn) {
  launcher = fn || (() => puppeteer.launch({ args: BROWSER_ARGS }));
}

// --- Screenshot helpers ---

// Sidor behöver en stund på sig att sätta sig efter navigering och popup-städning.
// Skalan finns för att testerna inte ska betala den väntan på riktigt.
let settleScale = 1;
const settle = (ms) => new Promise((r) => setTimeout(r, ms * settleScale));

// Set to 0 in tests to skip the fixed post-navigation waits.
function _setSettleScale(scale) {
  settleScale = scale;
}

function urlToFilename(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/-$/, "");
}

// Lokal tid, sorterbar: 20260912-104530. Utan den skriver två dumpar av samma sida
// över varandra i hämtningsmappen.
function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

// Sajtnamnet först — det är den delen man känner igen filen på när den ligger som
// bilaga. Tidsstämpeln sist ger unikhet utan att alla filer ser likadana ut i början.
function shotFilename(url, suffix, stamp) {
  return `${urlToFilename(url)}${suffix}-${stamp}.png`;
}

async function dismissPopups(page) {
  await page.keyboard.press("Escape");
  await settle(150);

  const hasCanvas = await page.evaluate(() => document.querySelector("canvas") !== null);
  if (!hasCanvas) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("*")) {
        const s = getComputedStyle(el);
        if (
          (s.position === "fixed" || s.position === "absolute") &&
          parseInt(s.zIndex, 10) > 100 &&
          el.offsetWidth > window.innerWidth * 0.3 &&
          el.offsetHeight > window.innerHeight * 0.3
        ) el.remove();
      }
      for (const el of document.querySelectorAll(
        '[class*="backdrop"],[class*="Backdrop"],[class*="overlay"],[class*="Overlay"]'
      )) el.remove();
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    });
  }
  await settle(150);
}

// Varje flik måste stängas även när goto/screenshot kastar — browsern är persistent,
// så en läckt flik ligger kvar och äter minne resten av processens livstid.
async function closeQuietly(page) {
  try {
    await page.close();
  } catch {
    /* redan stängd, eller browsern nere */
  }
}

async function takeShot(browser, url, variant, { timeout = GOTO_TIMEOUT_MS } = {}) {
  let b64;

  const page = await browser.newPage();
  try {
    await guardPage(page);
    await page.setViewport(variant.viewport);
    await page.goto(url, { waitUntil: "networkidle2", timeout });
    await settle(500);
    await dismissPopups(page);
    assertNoPrivateAccess(page);

    if (!variant.frame) {
      return await page.screenshot({ fullPage: !!variant.fullPage });
    }
    b64 = await page.screenshot({ encoding: "base64" });
  } finally {
    await closeQuietly(page);
  }

  const framePage = await browser.newPage();
  try {
    await framePage.setViewport({
      width: variant.frame.viewportWidth,
      height: variant.frame.viewportHeight,
      deviceScaleFactor: 2,
    });
    await framePage.setContent(`<!DOCTYPE html>
<html><head><style>
  *{margin:0;padding:0}
  body{background:transparent;display:flex;align-items:center;justify-content:center;height:100vh}
  ${variant.frame.css}
</style></head>
<body>${variant.frame.html.replace("DATA", `data:image/png;base64,${b64}`)}</body>
</html>`);

    return await framePage.screenshot({ omitBackground: true });
  } finally {
    await closeQuietly(framePage);
  }
}

// --- Page HTML ---

function navLinks(currentKey) {
  const all = [...VARIANT_KEYS, "all"];
  return all
    .filter((k) => k !== currentKey)
    .map((k) => {
      if (k === "all") return '<a href="/all" title="Alla format som ZIP">📦 Alla</a>';
      const v = VARIANTS[k];
      return `<a href="${v.path}" title="${v.hint}">${v.emoji} ${v.label}</a>`;
    })
    .join(" · ");
}

// Sidorna skiljer sig bara i titel, bookmarklet och vad knappen gör. En mall,
// en konfigurationspost per sida — tidigare var det två nästan identiska kopior.
const DESC_SINGLE =
  "Ta screenshots av websidor i olika format. Desktop, mobil, iPad, stor och helsida.";
const DESC_ALL = "Ta screenshots av websidor i alla format på en gång. Ladda ner som ZIP.";

function pageSpec(key) {
  if (key === "all") {
    return {
      title: "Click All",
      emoji: "📦",
      desc: DESC_ALL,
      path: "/all",
      shotPath: "/shot/all",
      imgStyle: null,      // ingen bild på sidan
      dl: false,           // /shot/all svarar alltid attachment, ?dl vore brus
      bookmarkletHint: "ta alla screenshots av aktuell sida",
      buttonLabel: "Ta alla screenshots",
      buttonHint: "Ta screenshots i alla format och ladda ner som ZIP",
      busy: "Tar screenshots (kan ta en stund)...",
      mode: "zip",
      fallbackName: "screenshots.zip",
    };
  }
  const v = VARIANTS[key];
  const hint = v.hint.toLowerCase();
  return {
    title: v.title,
    emoji: v.emoji,
    desc: DESC_SINGLE,
    path: v.path,
    shotPath: v.shotPath,
    imgStyle: v.tall ? "max-height:70vh;" : "max-width:100%;",
    dl: true,
    bookmarkletHint: `ta ${hint}-screenshot av aktuell sida`,
    buttonLabel: "Ta screenshot",
    buttonHint: `Ta en ${hint}-screenshot`,
    busy: "Tar screenshot...",
    mode: "image",
    fallbackName: `screenshot${v.suffix}.png`,
  };
}

function renderPage(key) {
  const p = pageSpec(key);
  const url = `${BASE_URL}${p.path}`;
  // Escapa < så att ett värde aldrig kan stänga script-taggen tidigt.
  const clientConfig = JSON.stringify({
    shotPath: p.shotPath,
    mode: p.mode,
    busy: p.busy,
    fallbackName: p.fallbackName,
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.title}</title>
  <meta name="description" content="${p.desc}">
  <meta property="og:title" content="${p.title}">
  <meta property="og:description" content="${p.desc}">
  <meta property="og:image" content="${BASE_URL}/og.png">
  <meta property="og:url" content="${url}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${p.title}">
  <meta name="twitter:description" content="${p.desc}">
  <meta name="twitter:image" content="${BASE_URL}/og.png">
  <link rel="canonical" href="${url}">
  <style>${STYLE}${p.imgStyle ? ` .preview img{${p.imgStyle}}` : ""}</style>${ANALYTICS}
</head>
<body>
  <main class="container">
    <h1><span style="font-size:4rem" aria-hidden="true">${p.emoji}</span><br>${p.title}</h1>
    <nav aria-label="Varianter">${navLinks(key)}</nav>
    <div style="margin-top:1.5rem;margin-bottom:1.5rem">
      <p style="color:#aaa;margin-bottom:0.5rem;font-size:0.85rem">Dra till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='${BASE_URL}${p.shotPath}?${p.dl ? "dl&" : ""}url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.4rem 0.8rem;background:#d03050;color:#fff;border-radius:6px;text-decoration:none;font-weight:500;font-size:0.85rem" title="Bookmarklet: ${p.bookmarkletHint}">${p.title}</a>
    </div>
    <form id="f"><label for="u">URL</label><input type="url" id="u" placeholder="https://example.com" required><button id="b" title="${p.buttonHint}">${p.buttonLabel}</button></form>
    <div class="status" id="s" aria-live="polite"></div>
    <div class="preview" id="p"></div>
  </main>
  <footer style="margin-top:2rem;text-align:center;font-size:0.8rem"><a href="https://status.grj.se/click" style="color:#555;text-decoration:none">Statusvakt</a></footer>
  <script id="cfg" type="application/json">${clientConfig}</script>
  <script src="/app.js"></script>
</body></html>`;
}

// --- Health endpoint ---

app.get("/health", async (req, res) => {
  const checks = {};
  let healthy = true;

  // Browser check
  try {
    const browser = await getBrowser();
    if (browser && browser.connected) {
      checks.browser = "ok";
    } else {
      checks.browser = { status: "error", message: "Browser ej ansluten" };
      healthy = false;
    }
  } catch (err) {
    console.error("[health] browser:", err);
    checks.browser = { status: "error", message: publicMessage(err) };
    healthy = false;
  }

  // Error rate check
  const errorCount = getErrorRate();
  if (errorCount <= ERROR_THRESHOLD) {
    checks.error_rate = { status: "ok", errors_last_5min: errorCount, threshold: ERROR_THRESHOLD };
  } else {
    checks.error_rate = {
      status: "elevated",
      errors_last_5min: errorCount,
      threshold: ERROR_THRESHOLD,
      message: `${errorCount} fel senaste 5 minuterna`,
    };
    healthy = false;
  }

  // Mejlstatus rapporteras men flippar INTE den övergripande statusen. Ett
  // Resend-avbrott skulle annars måla tjänsten röd trots att skärmdumpar fungerar
  // för alla, och blockera varje deploy. Kuma får en egen monitor på det här fältet.
  checks.mailer = mailerStatus();

  const status = healthy ? "ok" : "error";
  res.status(healthy ? 200 : 503).json({
    status,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: "1.0.0",
    checks,
  });
});

// --- Inloggning ---
//
// Registreras efter /health med flit: hälsokontrollen ska aldrig kunna påverkas
// av en cookie, en trasig nyckel eller en trasig mailer.

app.use(express.json({ limit: "4kb" }));
app.use(auth.attachSession);

// Bästa-försök att göra en kod engångs. Överlever inte omstart — det bärande
// skyddet är att utmaningscookien rensas, inte den här mängden.
const consumedJti = new Set();

function renderLogin() {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Logga in · Click</title><meta name="robots" content="noindex">
  <style>${STYLE} input[readonly]{opacity:0.6} form{flex-direction:column}</style>
</head>
<body>
  <main class="container">
    <h1><span style="font-size:4rem" aria-hidden="true">🔑</span><br>Logga in</h1>
    <p style="color:#aaa;font-size:0.9rem;margin-bottom:1.5rem">Inloggad får du skärmdumparna mejlade till dig.</p>
    <form id="f">
      <label for="u">E-post</label>
      <input type="email" id="u" placeholder="du@example.com" required autocomplete="email">
      <div id="step2" hidden style="margin-top:0.5rem">
        <label for="pin">Kod</label>
        <input type="text" id="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" autocomplete="one-time-code" style="width:100%">
      </div>
      <button id="b" style="margin-top:0.5rem">Skicka kod</button>
    </form>
    <div class="status" id="s" aria-live="polite"></div>
    <nav aria-label="Tillbaka" style="margin-top:2rem"><a href="/">← Till Click</a></nav>
  </main>
  <script src="/login.js"></script>
</body></html>`;
}

app.get("/login", (req, res) => res.send(renderLogin()));

app.post("/auth/login", loginGlobalLimit, loginLimit, (req, res) => {
  if (!auth.isConfigured()) return res.status(503).json({ error: "inloggning är inte påslagen" });
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: "fel ursprung" });

  const email = auth.normalizeEmail(req.body?.email);
  if (!email || email.length > 254 || !email.includes("@")) {
    return res.status(400).json({ error: "ogiltig adress" });
  }

  // Skicka inte en kod till om en giltig utmaning redan är på gång.
  const existing = auth.readChallenge(auth.readCookie(req, auth.CHALLENGE_COOKIE));
  if (existing && existing.sub === email) return res.status(202).json({ ok: true });

  // En riktig utmaning utfärdas för VARJE adress. Utan det blir närvaron av en
  // Set-Cookie ett orakel som avslöjar vem som står på allowlisten.
  const pin = auth.generatePin();
  auth.setChallengeCookie(res, auth.makeChallenge(email, pin));

  if (auth.isAllowed(email)) {
    // Inte inväntat: att vänta hade lagt nätverkslatensen på svaret bara för
    // tillåtna adresser, vilket är samma orakel fast i tidsdomänen.
    mailer
      .send({
        to: email,
        subject: "Din kod till Click",
        text:
          `Kod: ${pin}\n\nGiltig i 10 minuter.\n` +
          `Begärd från ${clientIp(req)}.\n\n` +
          `Var det inte du? Strunta i det — koden är värdelös utan webbläsaren som bad om den.`,
      })
      .catch((err) => console.error("[auth] kunde inte skicka kod:", err.message));
  }

  res.status(202).json({ ok: true });
});

app.post("/auth/verify", verifyLimit, (req, res) => {
  if (!auth.isConfigured()) return res.status(503).json({ error: "inloggning är inte påslagen" });
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: "fel ursprung" });

  const chal = auth.readChallenge(auth.readCookie(req, auth.CHALLENGE_COOKIE));
  if (!chal) {
    auth.clearChallengeCookie(res);
    return res.status(401).json({ error: "koden gick ut — begär en ny" });
  }
  // Samma svar för fel kod, förbrukad kod och adress utanför allowlisten.
  if (!auth.checkPin(chal, req.body?.pin) || !auth.isAllowed(chal.sub) || consumedJti.has(chal.jti)) {
    auth.setChallengeCookie(res, auth.bumpChallenge(chal));
    return res.status(401).json({ error: "fel kod" });
  }

  consumedJti.add(chal.jti);
  auth.clearChallengeCookie(res);
  auth.setSessionCookie(res, auth.makeSession(chal.sub));
  res.status(200).json({ ok: true, email: chal.sub });
});

app.post("/auth/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.status(204).end();
});

app.get("/auth/me", (req, res) => {
  if (!req.session) return res.status(401).json({ error: "ej inloggad" });
  res.json({ email: req.session.email });
});

// --- Routes ---

for (const key of VARIANT_KEYS) {
  const v = VARIANTS[key];

  app.get(v.path, (req, res) => res.send(renderPage(key)));

  app.get(v.shotPath, rateLimit, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("url krävs");
    const verdict = await validateTargetUrl(url);
    if (!verdict.ok) return res.status(400).send(verdict.reason);

    try {
      const screenshot = await withSlot(async () => {
        const browser = await getBrowser();
        return takeShot(browser, url, v);
      });

      // Namnet sätts alltid här, även utan ?dl — klienten läser tillbaka det ur headern
      // istället för att bygga ett eget. Ett ställe, inga kopior som glider isär.
      const filename = shotFilename(url, v.suffix, timestamp());
      const disposition = req.query.dl !== undefined ? "attachment" : "inline";
      res.set("Content-Type", "image/png");
      res.set("Content-Disposition", `${disposition}; filename="${filename}"`);
      res.send(screenshot);
    } catch (err) {
      if (err.busy) return res.status(429).send(err.message);
      console.error(`[shot${v.suffix}]`, err);
      recordError();
      res.status(500).send(publicMessage(err));
    }
  });
}

app.get("/all", (req, res) => res.send(renderPage("all")));

app.get("/shot/all", rateLimit, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url krävs");
  const verdict = await validateTargetUrl(url);
  if (!verdict.ok) return res.status(400).send(verdict.reason);

  try {
    const shots = await withSlot(async () => {
      const browser = await getBrowser();
      const results = [];
      for (const key of VARIANT_KEYS) {
        results.push(await takeShot(browser, url, VARIANTS[key], { timeout: ALL_GOTO_TIMEOUT_MS }));
      }
      return results;
    });

    // Alla bilder är klara här — först nu skickas headers, så fel ovanför kan
    // fortfarande bli ett vanligt 500-svar.
    // Alla fem bilderna delar en tidsstämpel — de hör till samma tillfälle.
    const stamp = timestamp();
    const base = urlToFilename(url);
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${base}-${stamp}.zip"`);

    const archive = archiver("zip");
    archive.on("error", (err) => {
      console.error("[shot/all] arkivfel:", err);
      recordError();
      res.destroy(err);
    });
    archive.pipe(res);
    VARIANT_KEYS.forEach((key, i) => {
      // page.screenshot() ger en Uint8Array; archiver tar bara Buffer eller Stream.
      archive.append(Buffer.from(shots[i]), {
        name: shotFilename(url, VARIANTS[key].suffix, stamp),
      });
    });
    await archive.finalize();
  } catch (err) {
    if (err.busy) return res.status(429).send(err.message);
    console.error("[shot/all]", err);
    recordError();
    // Strömmen kan redan ha börjat — då finns ingen statuskod kvar att sätta.
    if (res.headersSent) return res.destroy(err);
    res.status(500).send(publicMessage(err));
  }
});

// Start server only when run directly (not when required for testing).
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Click running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  app,
  getBrowser,
  takeShot,
  urlToFilename,
  timestamp,
  shotFilename,
  _setSettleScale,
  _setBrowserInstance,
  _setLauncher,
};
