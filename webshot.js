#!/usr/bin/env node

const puppeteer = require("puppeteer");
const path = require("path");

const WIDTH = 1280;
const HEIGHT = 800;

async function takeScreenshot(url) {
  if (!url) {
    console.error("Usage: node webshot.js <url>");
    process.exit(1);
  }

  // Build filename from URL
  const name = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");

  const outDir = path.join(__dirname, "screenshots");
  const fs = require("fs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const outFile = path.join(outDir, `${name}.png`);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Press Escape to close modals
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));

  // Remove any fixed/absolute overlays and common popups
  await page.evaluate(() => {
    // Remove elements that cover the page (fixed/absolute with high z-index)
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
    // Also remove common backdrop/overlay elements
    for (const el of document.querySelectorAll(
      '[class*="backdrop"], [class*="Backdrop"], [class*="overlay"], [class*="Overlay"]'
    )) {
      el.remove();
    }
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
  });

  await new Promise((r) => setTimeout(r, 300));

  await page.screenshot({ path: outFile });
  await browser.close();

  console.log(`Screenshot saved: ${outFile}`);
}

takeScreenshot(process.argv[2]);
