const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
const archiver = require("archiver");

const app = express();
const PORT = 3131;
const BROWSER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];
const BASE_URL = "https://click.grj.se";

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
    suffix: "",
    viewport: { width: 1280, height: 800 },
  },
  mobile: {
    path: "/mobile",
    shotPath: "/shot/mobile",
    title: "Click Mobile",
    emoji: "📱",
    label: "Mobil",
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
    suffix: "-big",
    viewport: { width: 1720, height: 1410 },
  },
};

const VARIANT_KEYS = Object.keys(VARIANTS);

// --- Persistent browser ---

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({ args: BROWSER_ARGS });
  browserInstance.on("disconnected", () => { browserInstance = null; });
  return browserInstance;
}

// --- Screenshot helpers ---

function urlToFilename(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/-$/, "");
}

async function dismissPopups(page) {
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 150));

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
  await new Promise((r) => setTimeout(r, 150));
}

async function takeShot(browser, url, variant) {
  const page = await browser.newPage();
  await page.setViewport(variant.viewport);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  await dismissPopups(page);

  if (!variant.frame) {
    const buf = await page.screenshot();
    await page.close();
    return buf;
  }

  const b64 = await page.screenshot({ encoding: "base64" });
  await page.close();

  const framePage = await browser.newPage();
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

  const buf = await framePage.screenshot({ omitBackground: true });
  await framePage.close();
  return buf;
}

// --- Page HTML ---

function navLinks(currentKey) {
  const all = [...VARIANT_KEYS, "all"];
  return all
    .filter((k) => k !== currentKey)
    .map((k) => {
      if (k === "all") return '<a href="/all">📦 Alla</a>';
      const v = VARIANTS[k];
      return `<a href="${v.path}">${v.emoji} ${v.label}</a>`;
    })
    .join(" · ");
}

function renderPage(key) {
  const v = VARIANTS[key];
  const imgStyle = v.tall ? "max-height:70vh;" : "max-width:100%;";
  const desc = "Ta screenshots av websidor i olika format. Desktop, mobil, iPad och stor.";
  const url = `${BASE_URL}${v.path}`;
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${v.title}</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="${v.title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${BASE_URL}/og.png">
  <meta property="og:url" content="${url}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${v.title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${BASE_URL}/og.png">
  <link rel="canonical" href="${url}">
  <style>${STYLE} .preview img{${imgStyle}}</style>${ANALYTICS}
</head>
<body>
  <main class="container">
    <h1><span style="font-size:4rem" aria-hidden="true">${v.emoji}</span><br>${v.title}</h1>
    <form id="f"><label for="u">URL</label><input type="url" id="u" placeholder="https://example.com" required><button id="b">Ta screenshot</button></form>
    <div class="status" id="s" aria-live="polite"></div>
    <div class="preview" id="p"></div>
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #333">
      <p style="color:#aaa;margin-bottom:0.5rem">Dra denna till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='https://click.grj.se${v.shotPath}?dl&url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.5rem 1rem;background:#d03050;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">${v.title}</a>
    </div>
    <nav aria-label="Varianter">${navLinks(key)}</nav>
  </main>
  <script>
    document.getElementById('f').onsubmit=async e=>{
      e.preventDefault();const url=document.getElementById('u').value,b=document.getElementById('b'),s=document.getElementById('s'),p=document.getElementById('p');
      b.disabled=true;s.textContent='Tar screenshot...';p.innerHTML='';
      try{const r=await fetch('${v.shotPath}?url='+encodeURIComponent(url));if(!r.ok)throw new Error(await r.text());
        const bl=await r.blob(),i=URL.createObjectURL(bl),fn=url.replace(/^https?:\\/\\//,'').replace(/[^a-zA-Z0-9]/g,'-').replace(/-+/g,'-').replace(/-$/,'')+'${v.suffix}.png';
        p.innerHTML='<img src="'+i+'" alt="Screenshot av '+url+'"><br><a class="download" href="'+i+'" download="'+fn+'">Ladda ner</a>';s.textContent='';
      }catch(err){s.textContent='Fel: '+err.message}b.disabled=false;
    };
  </script>
</body></html>`;
}

function renderAllPage() {
  const desc = "Ta screenshots av websidor i alla format på en gång. Ladda ner som ZIP.";
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Click All</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="Click All">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${BASE_URL}/og.png">
  <meta property="og:url" content="${BASE_URL}/all">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Click All">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${BASE_URL}/og.png">
  <link rel="canonical" href="${BASE_URL}/all">
  <style>${STYLE}</style>${ANALYTICS}
</head>
<body>
  <main class="container">
    <h1><span style="font-size:4rem" aria-hidden="true">📦</span><br>Click All</h1>
    <form id="f"><label for="u">URL</label><input type="url" id="u" placeholder="https://example.com" required><button id="b">Ta alla screenshots</button></form>
    <div class="status" id="s" aria-live="polite"></div>
    <div class="preview" id="p"></div>
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #333">
      <p style="color:#aaa;margin-bottom:0.5rem">Dra denna till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='https://click.grj.se/shot/all?url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.5rem 1rem;background:#d03050;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Click All</a>
    </div>
    <nav aria-label="Varianter">${navLinks("all")}</nav>
  </main>
  <script>
    document.getElementById('f').onsubmit=async e=>{
      e.preventDefault();const url=document.getElementById('u').value,b=document.getElementById('b'),s=document.getElementById('s'),p=document.getElementById('p');
      b.disabled=true;s.textContent='Tar screenshots (kan ta en stund)...';p.innerHTML='';
      try{const r=await fetch('/shot/all?url='+encodeURIComponent(url));if(!r.ok)throw new Error(await r.text());
        const bl=await r.blob(),z=URL.createObjectURL(bl),fn=url.replace(/^https?:\\/\\//,'').replace(/[^a-zA-Z0-9]/g,'-').replace(/-+/g,'-').replace(/-$/,'')+'.zip';
        p.innerHTML='<a class="download" href="'+z+'" download="'+fn+'">Ladda ner ZIP</a>';s.textContent='';
      }catch(err){s.textContent='Fel: '+err.message}b.disabled=false;
    };
  </script>
</body></html>`;
}

// --- Routes ---

for (const key of VARIANT_KEYS) {
  const v = VARIANTS[key];

  app.get(v.path, (req, res) => res.send(renderPage(key)));

  app.get(v.shotPath, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("url krävs");

    try {
      const browser = await getBrowser();
      const screenshot = await takeShot(browser, url, v);

      const filename = urlToFilename(url);
      res.set("Content-Type", "image/png");
      if (req.query.dl !== undefined) {
        res.set("Content-Disposition", `attachment; filename="${filename}${v.suffix}.png"`);
      }
      res.send(screenshot);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
}

app.get("/all", (req, res) => res.send(renderAllPage()));

app.get("/shot/all", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url krävs");

  try {
    const browser = await getBrowser();

    const shots = await Promise.all(
      VARIANT_KEYS.map((key) => takeShot(browser, url, VARIANTS[key]))
    );

    const filename = urlToFilename(url);
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${filename}.zip"`);

    const archive = archiver("zip");
    archive.pipe(res);
    VARIANT_KEYS.forEach((key, i) => {
      archive.append(shots[i], { name: `${filename}${VARIANTS[key].suffix}.png` });
    });
    await archive.finalize();
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Click running at http://localhost:${PORT}`);
});
