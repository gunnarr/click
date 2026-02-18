#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const WIDTH = 1280;
const HEIGHT = 800;
const WAIT_MS = 5000;

async function takeScreenshot(url) {
  if (!url) {
    console.error("Usage: node webshot.js <url>");
    process.exit(1);
  }

  const name = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");

  const outDir = path.join(__dirname, "screenshots");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outFile = path.join(outDir, `${name}.png`);

  // Launch Chrome in app mode (no tabs, no bookmarks bar)
  const chrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(chrome, [
    `--app=${url}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
  ]);

  console.log(`Waiting for page to load...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // Bring Chrome to front and capture via screen region
  execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
  await new Promise((r) => setTimeout(r, 500));

  const bounds = execSync(`osascript -e '
    tell application "System Events"
      tell process "Google Chrome"
        set {x, y} to position of first window
        set {w, h} to size of first window
        return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
      end tell
    end tell
  '`)
    .toString()
    .trim();

  execSync(`screencapture -x -R${bounds} "${outFile}"`);

  child.kill();
  console.log(`Screenshot saved: ${outFile}`);
}

const url = process.argv.slice(2).find((a) => !a.startsWith("--"));
takeScreenshot(url);
