// Mejlutskick via Resend. Ett enda POST-anrop, så det görs med global fetch
// istället för SDK:n — inget beroende att hålla i takt, och vi styr JSON:en själva.
//
// Avsändardomänen är gunnar.se, som redan är verifierad i Resend (DKIM på roten,
// return path på send.gunnar.se). Tjänstens egen domän är en annan; det spelar
// ingen roll för mejlet.

const API = "https://api.resend.com/emails";

// Resend tar 40 MB per meddelande *efter* base64-kodning. Men mottagarsidan är
// den bindande gränsen: Gmail och de flesta andra vägrar över 25 MB. Vi budgeterar
// 20 MB kodat och kollar själva — API:et har ingen dokumenterad felkod för
// "för stor bilaga", så det enda sättet att få ett begripligt fel är att aldrig fråga.
const MAX_ENCODED_BYTES = 20 * 1024 * 1024;

// Gratisnivån ger 100 mejl per dygn. Vi säger ifrån innan dess, så ett skenande
// skript möter vårt felmeddelande istället för Resends.
const DAILY_LIMIT = 80;

// Fel som är värda att försöka igen. De två kvotfelen delar statuskod 429 med
// rate_limit_exceeded men får aldrig retrias — det bränner budget och fördröjer
// bara det besked användaren behöver.
const TRANSIENT = new Set(["rate_limit_exceeded", "application_error", "service_unavailable"]);

// --- konfiguration, läses lat så tester kan byta den utan require-cache-trick ---

const apiKey = () => process.env.RESEND_API_KEY || "";
const from = () => process.env.CLICK_MAIL_FROM || "Click <click@gunnar.se>";
function isConfigured() {
  return apiKey() !== "";
}

// --- testsömmar, samma mönster som _setBrowserInstance i server.js ---

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sleep = realSleep;
let sender = null;

// Injicera en egen transport (tester rör aldrig nätverket).
function _setSender(fn) {
  sender = fn;
}
function _setSleep(fn) {
  sleep = fn || realSleep;
}

// --- hälsotillstånd, exponeras i /health ---

let consecutiveFailures = 0;
let lastSendAt = null;
let lastError = null;
let sentToday = 0;
let quotaDay = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rollQuota() {
  const d = today();
  if (quotaDay !== d) {
    quotaDay = d;
    sentToday = 0;
  }
}

function mailerStatus() {
  if (!isConfigured()) return { status: "disabled" };
  rollQuota();
  const base = { sent_today: sentToday, daily_limit: DAILY_LIMIT };
  if (consecutiveFailures === 0) {
    return { status: "ok", last_send: lastSendAt, ...base };
  }
  return { status: "error", consecutive_failures: consecutiveFailures, message: lastError, ...base };
}

function _resetStatus() {
  consecutiveFailures = 0;
  lastSendAt = null;
  lastError = null;
  sentToday = 0;
  quotaDay = null;
}

// --- bilagor ---

// page.screenshot() ger en Uint8Array. Buffer.from(u8) kopierar rätt;
// Buffer.from(u8.byteLength ? u8.buffer : u8) gör det INTE — den aliasar hela den
// underliggande ArrayBuffern och struntar i byteOffset. Puppeteers arrayer ligger
// ofta i en poolad buffer, så den varianten ger skräp plus grannens bytes.
function buildAttachment(bytes, filename) {
  return { filename, content: Buffer.from(bytes).toString("base64") };
}

function encodedSize(attachments) {
  return attachments.reduce((sum, a) => sum + Buffer.byteLength(a.content), 0);
}

// --- utskick ---

async function postToResend(payload, idempotencyKey) {
  if (sender) return sender(payload, idempotencyKey);

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Resend svarade ${res.status}`);
    err.resend = { name: body.name || "unknown", status: res.status };
    throw err;
  }
  return body;
}

function isTransient(err) {
  // Utan err.resend kom felet från fetch självt — DNS, TCP, TLS. Alltid övergående.
  if (!err.resend) return true;
  return TRANSIENT.has(err.resend.name);
}

/**
 * Skickar ett mejl. Kastar vid permanenta fel och när alla försök tagit slut.
 * Anroparen ansvarar för att ett mejlfel aldrig får sänka svaret till användaren.
 */
async function send({ to, subject, text, attachments = [], idempotencyKey }, { attempts = 3 } = {}) {
  if (!isConfigured()) throw new Error("mejl är inte konfigurerat");

  rollQuota();
  if (sentToday >= DAILY_LIMIT) {
    throw new Error(`dygnsgränsen på ${DAILY_LIMIT} mejl är nådd`);
  }

  const size = encodedSize(attachments);
  if (size > MAX_ENCODED_BYTES) {
    const mb = (n) => Math.round(n / (1024 * 1024));
    throw new Error(`bilagorna är ${mb(size)} MB, gränsen går vid ${mb(MAX_ENCODED_BYTES)} MB`);
  }

  const payload = { from: from(), to: Array.isArray(to) ? to : [to], subject, text };
  if (attachments.length) payload.attachments = attachments;

  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await postToResend(payload, idempotencyKey);
      consecutiveFailures = 0;
      lastError = null;
      lastSendAt = new Date().toISOString();
      sentToday++;
      return result;
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === attempts - 1) break;
      await sleep(Math.random() * (500 * 2 ** i));
    }
  }

  consecutiveFailures++;
  lastError = last.message;
  throw last;
}

module.exports = {
  send,
  buildAttachment,
  isConfigured,
  mailerStatus,
  MAX_ENCODED_BYTES,
  DAILY_LIMIT,
  _setSender,
  _setSleep,
  _resetStatus,
};
