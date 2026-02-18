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
  await page.screenshot({ path: outFile });
  await browser.close();

  console.log(`Screenshot saved: ${outFile}`);
}

takeScreenshot(process.argv[2]);
