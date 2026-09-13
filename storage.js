// Sparar skärmdumpar i en katalog på servern när någon är inloggad. Katalogen är
// en iCloud-mapp, så filerna dyker upp på Gunnars övriga enheter av sig själva.
//
// Sökvägen kommer från CLICK_SAVE_DIR. Den ligger inte i koden — repot är publikt
// och en serversökväg hör inte hemma där.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const saveDir = () => String(process.env.CLICK_SAVE_DIR || "").trim();
const isConfigured = () => saveDir() !== "";

// --- hälsotillstånd, exponeras i /health ---

let consecutiveFailures = 0;
let lastSaveAt = null;
let lastError = null;
let savedTotal = 0;

function storageStatus() {
  if (!isConfigured()) return { status: "disabled" };
  if (consecutiveFailures === 0) {
    return { status: "ok", last_save: lastSaveAt, saved_total: savedTotal };
  }
  return {
    status: "error",
    consecutive_failures: consecutiveFailures,
    message: lastError,
    saved_total: savedTotal,
  };
}

function _resetStatus() {
  consecutiveFailures = 0;
  lastSaveAt = null;
  lastError = null;
  savedTotal = 0;
}

// --- skrivning ---

// Skriv till en temp-fil i SAMMA katalog och byt namn. rename är atomiskt inom en
// filsystem, så iCloud får aldrig syn på en halvskriven PNG och börjar ladda upp den.
// Katalogen skapas medvetet inte: saknas den är iCloud sannolikt inte monterad, och
// då är ett tydligt fel bättre än en lokal mapp som ingen synkar.
async function writeAtomic(dir, filename, bytes) {
  const target = path.join(dir, filename);
  const tmp = path.join(dir, `.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, Buffer.from(bytes));
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return target;
}

/**
 * Sparar filerna. Kastar aldrig — anroparen får ett utfall att rapportera vidare,
 * eftersom en misslyckad sparning aldrig får sänka själva skärmdumpen.
 * @returns {Promise<"off"|"saved"|"failed">}
 */
async function saveShots(files) {
  if (!isConfigured()) return "off";
  const dir = saveDir();
  try {
    for (const file of files) {
      await writeAtomic(dir, file.filename, file.bytes);
    }
    consecutiveFailures = 0;
    lastError = null;
    lastSaveAt = new Date().toISOString();
    savedTotal += files.length;
    return "saved";
  } catch (err) {
    consecutiveFailures++;
    lastError = err.message;
    console.error("[storage]", err.message);
    return "failed";
  }
}

module.exports = {
  saveShots,
  writeAtomic,
  isConfigured,
  storageStatus,
  _resetStatus,
};
