/**
 * telegram_sender.js — Sends Top 1 per-region MP3s to Telegram.
 *
 * STANDALONE / ADDITIVE — does not modify the scraper (gittest.js) or any
 * other existing module. Only READS data already produced by:
 *   - audio_research_workflow.js / candidate_cache.js (title, artist,
 *     audioId, trendRegion)
 *   - spotify_search.js (Spotify URL)
 *   - mp3_downloader.js (local MP3 file path)
 * Integrate this only after mp3_downloader.js is confirmed working, per
 * instructions — this module assumes a real local MP3 file already
 * exists at the path it's given.
 *
 * Sends exactly 3 audios per run: Top 1 Kerala Trending, Top 1 India
 * Trending, Top 1 Global Trending — never more.
 *
 * Duplicate protection: telegram_sent_db.json, permanent, keyed by
 * audioId. An audio already recorded there is skipped completely — no
 * Telegram call, no console "sending" noise, just a short skip log.
 *
 * On send failure: nothing is written to telegram_sent_db.json, the local
 * MP3 is kept (for debugging), and the error is logged — the scraper is
 * never stopped.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

/* ===== Config ===== */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 60000;

const SENT_DB_FILE = path.join(__dirname, "telegram_sent_db.json");

const REGION_EMOJI = {
  "Kerala Trending": "🟢",
  "India Trending": "🟡",
  "Global Trending": "🌍",
};

/* ===== Duplicate-protection DB (telegram_sent_db.json) ===== */
function atomicWriteSync(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function loadSentDb() {
  try {
    return JSON.parse(fs.readFileSync(SENT_DB_FILE, "utf8") || "{}");
  } catch (e) {
    return {};
  }
}

function saveSentDb(db) {
  atomicWriteSync(SENT_DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * hasBeenSent(audioId)
 * Read-only lookup — true if this audio was already successfully sent to
 * Telegram in a previous run (or earlier in this one).
 */
function hasBeenSent(audioId) {
  if (!audioId) return false;
  const db = loadSentDb();
  return Boolean(db[audioId]);
}

function recordSent({ audioId, externalTrackId, trendRegion, timestamp }) {
  const db = loadSentDb();
  db[audioId] = {
    audioId,
    externalTrackId: externalTrackId || null,
    trendRegion: trendRegion || null,
    timestamp: timestamp || new Date().toISOString(),
  };
  saveSentDb(db);
}

/* ===== Caption formatting ===== */

/**
 * buildCaption({ region, title, artist, spotifyUrl })
 * Region heading changes automatically (🟢/🟡/🌍) based on `region`.
 */
function buildCaption({ region, title, artist, externalUrl }) {
  const emoji = REGION_EMOJI[region] || "⚪";
  const lines = [
    `${emoji} ${region}`,
    "",
    `🎵 ${title || "Unknown"}`,
    `👤 ${artist || "Unknown"}`,
    "",
    "Link:",
    externalUrl || "N/A",
  ];
  return lines.join("\n");
}

/* ===== Telegram Bot API ===== */

/**
 * sendTextMessage(text)
 * Sends a plain text message to the configured chat.
 */
async function sendTextMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env" };
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: "HTML",
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      return { ok: false, error: data?.description || `HTTP ${response.status}` };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * sendAudioToTelegram(filePath, caption)
 * Uploads the MP3 via multipart/form-data using the Bot API's sendAudio
 * method (native fetch + FormData/Blob — no extra dependencies needed).
 */
async function sendAudioToTelegram(filePath, caption) {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env" };
  }

  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `MP3 file not found at ${filePath}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("audio", new Blob([fileBuffer], { type: "audio/mpeg" }), path.basename(filePath));

    const response = await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendAudio`, {
      method: "POST",
      signal: controller.signal,
      body: form,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok !== true) {
      const desc = data && data.description ? data.description : `HTTP ${response.status}`;
      return { ok: false, error: `Telegram sendAudio failed: ${desc}` };
    }

    return { ok: true, messageId: data.result && data.result.message_id };
  } catch (e) {
    const isTimeout = e.name === "AbortError";
    return { ok: false, error: isTimeout ? "Telegram request timed out" : e.message };
  } finally {
    clearTimeout(timeout);
  }
}

/* ===== File cleanup ===== */
function deleteTempFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.log(`   ⚠️ Could not delete temporary file ${filePath}: ${e.message}`);
    return false;
  }
}

/* ===== Console output ===== */
function printSent() {
  console.log("\n📤 Telegram\n");
  console.log("Sending...");
}

/* ===== Public API ===== */

/**
 * sendTop1ToTelegram({ audioId, title, artist, region, externalTrackId, externalUrl, filePath })
 *
 * Sends a single Top 1 audio to Telegram, with duplicate protection,
 * caption formatting, post-send DB write, and temp-file cleanup — all per
 * spec. Never throws; any failure is logged and returned, never stops the
 * scraper.
 *
 * @returns {Promise<{ sent: boolean, skipped: boolean, error?: string }>}
 */
async function sendTop1ToTelegram({ audioId, title, artist, region, externalTrackId, externalUrl, filePath } = {}) {
  if (!audioId) {
    console.log("\n⚠️ [Telegram] No audioId provided — cannot check duplicate protection, skipping send.");
    return { sent: false, skipped: false, error: "No audioId provided" };
  }

  // Duplicate protection — skip completely, no Telegram call at all.
  if (hasBeenSent(audioId)) {
    console.log(`\n⏭️  [Telegram] "${title || audioId}" already sent previously — skipping.`);
    return { sent: false, skipped: true };
  }

  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`\n⚠️ [Telegram] No local MP3 found for "${title || audioId}" — skipping send.`);
    return { sent: false, skipped: false, error: "No local MP3 file available" };
  }

  printSent();

  const caption = buildCaption({ region, title, artist, externalUrl });
  const result = await sendAudioToTelegram(filePath, caption);

  if (!result.ok) {
    // Per spec: do NOT save as sent, KEEP the temp file, log and continue.
    console.log(`\n❌ Telegram send failed: ${result.error}`);
    console.log("   Keeping temporary file for debugging. Continuing scraper.");
    return { sent: false, skipped: false, error: result.error };
  }

  console.log("\n✅ Sent");

  recordSent({ audioId, externalTrackId, trendRegion: region, timestamp: new Date().toISOString() });
  console.log("\nSaved to telegram_sent_db.json");

  console.log("\nDeleting temporary file...");
  deleteTempFile(filePath);
  console.log("\n✅ Done");

  return { sent: true, skipped: false };
}

/**
 * sendTop1PerRegion(entries)
 *
 * Convenience driver for all three regions at once.
 *
 * @param {Array} entries - Array of up to 3 objects, one per region:
 *   { audioId, title, artist, region, externalTrackId, externalUrl, filePath }
 *   (region must be one of "Kerala Trending" / "India Trending" / "Global Trending")
 * @returns {Promise<object>} { "Kerala Trending": result, "India Trending": result, "Global Trending": result }
 */
async function sendTop1PerRegion(entries) {
  const REGIONS = ["Kerala Trending", "India Trending", "Global Trending"];
  const results = {};

  if (!Array.isArray(entries)) return results;

  for (const region of REGIONS) {
    const entry = entries.find(e => e.region === region);
    if (!entry) continue;

    try {
      results[region] = await sendTop1ToTelegram(entry);
    } catch (e) {
      // Final safety net — sendTop1ToTelegram already catches everything,
      // but per spec Telegram failures must never stop the scraper.
      console.log(`\n❌ [${region}] Unexpected Telegram error, continuing scraper: ${e.message}`);
      results[region] = { sent: false, skipped: false, error: e.message };
    }
  }

  return results;
}

module.exports = {
  sendTop1ToTelegram,
  sendTop1PerRegion,
  sendTextMessage,
  hasBeenSent,
  buildCaption,
};

/* ===== Self-test / manual verification =====
 * Run directly to verify a single send end-to-end:
 *   node telegram_sender.js <audioId> "Title" "Artist" "Kerala Trending" <spotifyTrackId> <spotifyUrl> <mp3FilePath>
 */
if (require.main === module) {
  const [, , audioId, title, artist, region, spotifyTrackId, spotifyUrl, filePath] = process.argv;

  if (!audioId || !filePath) {
    console.log('Usage: node telegram_sender.js <audioId> "Title" "Artist" <region> <spotifyTrackId> <spotifyUrl> <mp3FilePath>');
    process.exit(1);
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not found in .env — set them before running this test.");
    process.exit(1);
  }

  (async () => {
    const result = await sendTop1ToTelegram({
      audioId, title, artist, region: region || "Kerala Trending", spotifyTrackId, spotifyUrl, filePath,
    });
    console.log("\nResult:", JSON.stringify(result, null, 2));
  })();
}