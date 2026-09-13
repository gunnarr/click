// Minns de senaste URL:erna per inloggad användare, så att en dump tagen på
// laptopen kan tas om från telefonen med ett tryck.
//
// Det här måste ligga på servern. Sessionen är en cookie per webbläsare, så
// laptopen och telefonen delar inte tillstånd — men de delar identitet, och det
// är den listan hängs upp på. Den måste också överleva omstart, eftersom varje
// deploy startar om tjänsten.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ENTRIES = 5;

// En enda post får inte kunna svälla filen.
const MAX_URL_LENGTH = 2000;

const stateFile = () =>
  process.env.CLICK_STATE_FILE || path.join(__dirname, "data", "recent.json");

// Nyckeln är en hash, inte adressen. Adressen är redan validerad mot allowlisten,
// så det handlar inte om säkerhet — men en fil på disk behöver inte bära en
// personlig mejladress bredvid en logg över vad någon surfat på.
const keyFor = (email) =>
  crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 16);

// --- persistens ---

let cache = null; // { [key]: entry[] }
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    // Fel form är samma sak som ingen fil. Aldrig kasta för en bekvämlighetsfunktion.
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

// Skrivningar serialiseras: tre samtidiga skärmdumpar får inte fläta ihop sina
// temp-filer. Skriv direkt istället för att debounca — payloaden är några hundra
// byte, och en debounce riskerar att tappa sista posten till deployens SIGTERM.
function persist() {
  const snapshot = JSON.stringify(cache);
  writeQueue = writeQueue.then(async () => {
    const file = stateFile();
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      console.error("[recent] kunde inte spara:", err.message);
    }
  });
  return writeQueue;
}

// --- api ---

function list(email) {
  if (!email) return [];
  const entries = load()[keyFor(email)];
  return Array.isArray(entries) ? entries : [];
}

function record(email, { url, variant }) {
  if (!email || !url || url.length > MAX_URL_LENGTH) return list(email);
  const key = keyFor(email);
  const store = load();
  const kept = (Array.isArray(store[key]) ? store[key] : []).filter((e) => e.url !== url);
  store[key] = [{ url, variant, at: Date.now() }, ...kept].slice(0, MAX_ENTRIES);
  persist();
  return store[key];
}

// Töm cachen så nästa läsning går till disk igen (används av tester).
function _reset() {
  cache = null;
  writeQueue = Promise.resolve();
}
const _flush = () => writeQueue;

module.exports = { list, record, keyFor, MAX_ENTRIES, _reset, _flush };
