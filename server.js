const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3131;
const WIDTH = 1280;
const HEIGHT = 800;
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const BIG_WIDTH = 1920;
const BIG_HEIGHT = 1080;

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <title>Click</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; width: 600px; }
    h1 { margin-bottom: 1.5rem; font-weight: 300; font-size: 2rem; }
    form { display: flex; gap: 0.5rem; }
    input { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #333; background: #16213e; color: #eee; font-size: 1rem; outline: none; }
    input:focus { border-color: #0f3460; }
    button { padding: 0.75rem 1.5rem; border-radius: 8px; border: none; background: #e94560; color: #fff; font-size: 1rem; cursor: pointer; }
    button:hover { background: #c73652; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .status { margin-top: 1rem; min-height: 1.5rem; color: #aaa; }
    .preview { margin-top: 1.5rem; }
    .preview img { max-width: 100%; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    .download { display: inline-block; margin-top: 1rem; color: #e94560; text-decoration: none; font-weight: 500; }
  </style>
  <script async src="https://s.grj.se/js/pa-aExm7a8ErYTh7VPXLbZz7.js"></script>
  <script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>
</head>
<body>
  <div class="container">
    <h1><span style="font-size:4rem">📸</span><br>Click</h1>
    <form id="form">
      <input type="url" id="url" placeholder="https://example.com" required>
      <button type="submit" id="btn">Ta screenshot</button>
    </form>
    <div class="status" id="status"></div>
    <div class="preview" id="preview"></div>
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #333">
      <p style="color:#aaa;margin-bottom:0.5rem">Dra denna till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='https://click.grj.se/shot?dl&url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.5rem 1rem;background:#e94560;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Click</a>
    </div>
    <div style="margin-top:2rem"><a href="/mobile" style="color:#aaa">📱 Mobilvariant</a> · <a href="/big" style="color:#aaa">🖥️ Stor variant</a></div>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('url').value;
      btn.disabled = true;
      status.textContent = 'Tar screenshot...';
      preview.innerHTML = '';

      try {
        const res = await fetch('/shot?url=' + encodeURIComponent(url));
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const imgUrl = URL.createObjectURL(blob);
        const filename = url.replace(/^https?:\\/\\//, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/-$/, '') + '.png';
        preview.innerHTML = '<img src="' + imgUrl + '"><br><a class="download" href="' + imgUrl + '" download="' + filename + '">Ladda ner</a>';
        status.textContent = '';
      } catch (err) {
        status.textContent = 'Fel: ' + err.message;
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`);
});

app.get("/mobile", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <title>Click — Mobile</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; width: 600px; }
    h1 { margin-bottom: 1.5rem; font-weight: 300; font-size: 2rem; }
    form { display: flex; gap: 0.5rem; }
    input { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #333; background: #16213e; color: #eee; font-size: 1rem; outline: none; }
    input:focus { border-color: #0f3460; }
    button { padding: 0.75rem 1.5rem; border-radius: 8px; border: none; background: #e94560; color: #fff; font-size: 1rem; cursor: pointer; }
    button:hover { background: #c73652; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .status { margin-top: 1rem; min-height: 1.5rem; color: #aaa; }
    .preview { margin-top: 1.5rem; }
    .preview img { max-height: 70vh; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    .download { display: inline-block; margin-top: 1rem; color: #e94560; text-decoration: none; font-weight: 500; }
  </style>
  <script async src="https://s.grj.se/js/pa-aExm7a8ErYTh7VPXLbZz7.js"></script>
  <script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>
</head>
<body>
  <div class="container">
    <h1><span style="font-size:4rem">📱</span><br>Click Mobile</h1>
    <form id="form">
      <input type="url" id="url" placeholder="https://example.com" required>
      <button type="submit" id="btn">Ta screenshot</button>
    </form>
    <div class="status" id="status"></div>
    <div class="preview" id="preview"></div>
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #333">
      <p style="color:#aaa;margin-bottom:0.5rem">Dra denna till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='https://click.grj.se/shot/mobile?dl&url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.5rem 1rem;background:#e94560;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Click Mobile</a>
    </div>
    <div style="margin-top:2rem"><a href="/" style="color:#aaa">📸 Desktop</a> · <a href="/big" style="color:#aaa">🖥️ Stor variant</a></div>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('url').value;
      btn.disabled = true;
      status.textContent = 'Tar screenshot...';
      preview.innerHTML = '';

      try {
        const res = await fetch('/shot/mobile?url=' + encodeURIComponent(url));
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const imgUrl = URL.createObjectURL(blob);
        const filename = url.replace(/^https?:\\/\\//, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/-$/, '') + '-mobile.png';
        preview.innerHTML = '<img src="' + imgUrl + '"><br><a class="download" href="' + imgUrl + '" download="' + filename + '">Ladda ner</a>';
        status.textContent = '';
      } catch (err) {
        status.textContent = 'Fel: ' + err.message;
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`);
});

app.get("/big", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <title>Click — Big</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; width: 600px; }
    h1 { margin-bottom: 1.5rem; font-weight: 300; font-size: 2rem; }
    form { display: flex; gap: 0.5rem; }
    input { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #333; background: #16213e; color: #eee; font-size: 1rem; outline: none; }
    input:focus { border-color: #0f3460; }
    button { padding: 0.75rem 1.5rem; border-radius: 8px; border: none; background: #e94560; color: #fff; font-size: 1rem; cursor: pointer; }
    button:hover { background: #c73652; }
    button:disabled { opacity: 0.5; cursor: wait; }
    .status { margin-top: 1rem; min-height: 1.5rem; color: #aaa; }
    .preview { margin-top: 1.5rem; }
    .preview img { max-width: 100%; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    .download { display: inline-block; margin-top: 1rem; color: #e94560; text-decoration: none; font-weight: 500; }
  </style>
  <script async src="https://s.grj.se/js/pa-aExm7a8ErYTh7VPXLbZz7.js"></script>
  <script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>
</head>
<body>
  <div class="container">
    <h1><span style="font-size:4rem">🖥️</span><br>Click Big</h1>
    <form id="form">
      <input type="url" id="url" placeholder="https://example.com" required>
      <button type="submit" id="btn">Ta screenshot</button>
    </form>
    <div class="status" id="status"></div>
    <div class="preview" id="preview"></div>
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #333">
      <p style="color:#aaa;margin-bottom:0.5rem">Dra denna till bokmärkesfältet:</p>
      <a href="javascript:void(window.location='https://click.grj.se/shot/big?dl&url='+encodeURIComponent(location.href))" style="display:inline-block;padding:0.5rem 1rem;background:#e94560;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Click Big</a>
    </div>
    <div style="margin-top:2rem"><a href="/" style="color:#aaa">📸 Desktop</a> · <a href="/mobile" style="color:#aaa">📱 Mobilvariant</a></div>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('url').value;
      btn.disabled = true;
      status.textContent = 'Tar screenshot...';
      preview.innerHTML = '';

      try {
        const res = await fetch('/shot/big?url=' + encodeURIComponent(url));
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const imgUrl = URL.createObjectURL(blob);
        const filename = url.replace(/^https?:\\/\\//, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/-$/, '') + '-big.png';
        preview.innerHTML = '<img src="' + imgUrl + '"><br><a class="download" href="' + imgUrl + '" download="' + filename + '">Ladda ner</a>';
        status.textContent = '';
      } catch (err) {
        status.textContent = 'Fel: ' + err.message;
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`);
});

app.get("/shot/big", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url krävs");

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: BIG_WIDTH, height: BIG_HEIGHT });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    await new Promise((r) => setTimeout(r, 3000));
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));

    const hasCanvas = await page.evaluate(
      () => document.querySelector("canvas") !== null
    );
    if (!hasCanvas) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
          const style = getComputedStyle(el);
          if (
            (style.position === "fixed" || style.position === "absolute") &&
            parseInt(style.zIndex, 10) > 100 &&
            el.offsetWidth > window.innerWidth * 0.3 &&
            el.offsetHeight > window.innerHeight * 0.3
          ) {
            el.remove();
          }
        }
        for (const el of document.querySelectorAll(
          '[class*="backdrop"], [class*="Backdrop"], [class*="overlay"], [class*="Overlay"]'
        )) {
          el.remove();
        }
        document.body.style.overflow = "auto";
        document.documentElement.style.overflow = "auto";
      });
    }

    await new Promise((r) => setTimeout(r, 300));

    const screenshot = await page.screenshot();
    await browser.close();

    const filename = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/-$/, "");

    res.set("Content-Type", "image/png");
    if (req.query.dl !== undefined) {
      res.set(
        "Content-Disposition",
        `attachment; filename="${filename}-big.png"`
      );
    }
    res.send(screenshot);
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).send(err.message);
  }
});

app.get("/shot/mobile", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url krävs");

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Take mobile screenshot
    const page = await browser.newPage();
    await page.setViewport({
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));

    const hasCanvas = await page.evaluate(
      () => document.querySelector("canvas") !== null
    );
    if (!hasCanvas) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
          const style = getComputedStyle(el);
          if (
            (style.position === "fixed" || style.position === "absolute") &&
            parseInt(style.zIndex, 10) > 100 &&
            el.offsetWidth > window.innerWidth * 0.3 &&
            el.offsetHeight > window.innerHeight * 0.3
          ) {
            el.remove();
          }
        }
        for (const el of document.querySelectorAll(
          '[class*="backdrop"], [class*="Backdrop"], [class*="overlay"], [class*="Overlay"]'
        )) {
          el.remove();
        }
        document.body.style.overflow = "auto";
        document.documentElement.style.overflow = "auto";
      });
    }
    await new Promise((r) => setTimeout(r, 300));

    const screenshotData = await page.screenshot({ encoding: "base64" });

    // Render phone frame with screenshot inside
    const framePage = await browser.newPage();
    await framePage.setViewport({ width: 540, height: 1060, deviceScaleFactor: 2 });
    await framePage.setContent(`<!DOCTYPE html>
<html>
<head><style>
  * { margin: 0; padding: 0; }
  body { background: transparent; display: flex; align-items: center; justify-content: center; height: 100vh; }
  .phone {
    width: 430px;
    height: 932px;
    border-radius: 54px;
    border: 6px solid #2a2a2a;
    background: #000;
    padding: 18px 14px;
    position: relative;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), inset 0 0 0 2px #3a3a3a;
  }
  .phone::before {
    content: '';
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    width: 120px;
    height: 28px;
    background: #1a1a1a;
    border-radius: 14px;
    z-index: 10;
  }
  .screen {
    width: 100%;
    height: 100%;
    border-radius: 40px;
    overflow: hidden;
  }
  .screen img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
  }
</style></head>
<body>
  <div class="phone">
    <div class="screen">
      <img src="data:image/png;base64,${screenshotData}">
    </div>
  </div>
</body>
</html>`);

    const phoneScreenshot = await framePage.screenshot({
      omitBackground: true,
    });
    await browser.close();

    const filename = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/-$/, "");

    res.set("Content-Type", "image/png");
    if (req.query.dl !== undefined) {
      res.set(
        "Content-Disposition",
        `attachment; filename="${filename}-mobile.png"`
      );
    }
    res.send(phoneScreenshot);
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).send(err.message);
  }
});

app.get("/shot", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url krävs");

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for async content to render
    await new Promise((r) => setTimeout(r, 3000));

    // Dismiss popups
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));

    const hasCanvas = await page.evaluate(
      () => document.querySelector("canvas") !== null
    );
    if (!hasCanvas) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
          const style = getComputedStyle(el);
          if (
            (style.position === "fixed" || style.position === "absolute") &&
            parseInt(style.zIndex, 10) > 100 &&
            el.offsetWidth > window.innerWidth * 0.3 &&
            el.offsetHeight > window.innerHeight * 0.3
          ) {
            el.remove();
          }
        }
        for (const el of document.querySelectorAll(
          '[class*="backdrop"], [class*="Backdrop"], [class*="overlay"], [class*="Overlay"]'
        )) {
          el.remove();
        }
        document.body.style.overflow = "auto";
        document.documentElement.style.overflow = "auto";
      });
    }

    await new Promise((r) => setTimeout(r, 300));

    const screenshot = await page.screenshot();
    await browser.close();

    const filename = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/-$/, "");

    res.set("Content-Type", "image/png");
    if (req.query.dl !== undefined) {
      res.set("Content-Disposition", `attachment; filename="${filename}.png"`);
    }
    res.send(screenshot);
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).send(err.message);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Click running at http://localhost:${PORT}`);
});
