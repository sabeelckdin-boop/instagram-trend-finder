/**
 * Instagram Reels Audio Trend Tracker v6 — Predictive Following Feed
 * (v5 base + additive Pre-Viral Diffusion Engine)
 *
 * Architecture (UNCHANGED FROM v4/v5):
 *   Phase 1: Following Feed discovery (intentionally curated for early trends)
 *            Captures: audio_id, title, first_seen_creator, first_seen_post, taken_at
 *   Phase 2: Capture ONE real /api/v1/clips/music/ request for HTTP replay
 *   Phase 3: Replay captured request for all audio IDs
 *   Phase 4: Predictive analytics — LEGACY heuristic score (unchanged), the v5
 *            production score (unchanged), PLUS a new additive v6 Pre-Viral
 *            Diffusion Engine (Hawkes/Bass/entropy — see diffusion_engine.js)
 *
 * BACKWARD COMPATIBILITY:
 *   - No existing function was removed, renamed, or had its behavior changed
 *     except where noted in CHANGELOG below (bug fixes only).
 *   - discoverFromFollowingFeed() and discoverAudio() each gained ONE new,
 *     OPTIONAL trailing parameter (default undefined). Calling them exactly
 *     as v5 did produces byte-identical behavior — the new parameter is
 *     inert unless a caller explicitly passes an accumulator array.
 *   - No database field was removed. New fields (`adoptionEvents`, per-row
 *     `diffusion`) are only ever appended.
 *   - Old audio_growth_db.json files load and continue to work unmodified.
 *   - The legacy `predictiveScore` / `trendStage` and v5 `productionScore` /
 *     `lifecycleStage` fields remain exactly as v5 produced them, and the
 *     report is still sorted by `predictiveScore` by default.
 *
 * WHAT'S NEW IN v6 (all additive — see diffusion_engine.js header for the
 * full design rationale and for what was deliberately NOT implemented):
 *   - Every reel sighting seen during Following Feed discovery (not just
 *     the first) is logged as an adoption event: {time, creatorId, engagement}.
 *     This reuses data already flowing through the existing response
 *     interceptor — it does NOT add any new network requests.
 *   - A static, hand-edited `creator_niches.json` file (optional) supplies
 *     niche labels for entropy/spread signals. No automated profile
 *     scraping or follower-count fetching was added.
 *   - Phase 4 additionally computes a `diffusion` object per audio (Hawkes
 *     branching ratio, gated Bass fit, entropy, single-source detection,
 *     half-life trend, and a redesigned diffusionScore) and a duplicate-
 *     audio-title review file — both purely additive to the report.
 *
 * WHAT'S NEW IN v7 (Shazam recognition — all additive):
 *   - New module shazam_recognition.js provides Shazam-based identification
 *     of Instagram Original Audio (audioAssetId without audioClusterId).
 *   - A separate audio_recognition_db.json caches every result (success or
 *     failure) so no audio is ever recognized twice before a 30-day retry.
 *   - Recognition happens AFTER Phase 2 (API capture), using the reel video
 *     URL extracted from the captured API response.
 *   - Canonical audio merging: multiple Instagram Original Audio IDs that
 *     resolve to the same Shazam ISRC / track ID are merged into one DB
 *     entry, consolidating growth history and preventing fragmented trends.
 *   - The python script shazam_recognize.py is called via child_process to
 *     perform the actual ShazamIO recognition.
 *
 * FIX v7.1: Each Original Audio now gets its OWN reel video URL by
 * replaying the captured request for that specific audio ID, instead of
 * all sharing the same video from the Phase 2 capture.
 *
 * ================================================================
 * CHANGELOG (this pass — code-review bugfixes, no feature changes):
 * ================================================================
 *   1. [CRITICAL] Phase 3 (fetchAllCounts) now writes growth snapshots
 *      under shazamRec.getEffectiveCanonicalKey(track) instead of raw
 *      track.idKey. Previously, mergeCanonicalAudios() would merge two
 *      IDs into db[canonicalKey] and delete the old per-ID entry, but the
 *      very next Phase 3 run wrote new snapshots straight back to
 *      db[idKey] (which no longer existed) — silently re-fragmenting the
 *      merge it had just performed, every single run.
 *   2. [CRITICAL] Replay ID substitution moved to replay_utils.js, which
 *      sets the correct form field (and blanks the other one) via
 *      URLSearchParams instead of a regex that silently no-op'd whenever
 *      the target field was empty or absent from the captured template
 *      (see replay_utils.js header for the full writeup).
 *   3. [MODERATE] captureRequest() no longer races two independent timers
 *      where the shorter one (6s) always fired first and always cleared
 *      the longer one (15s) regardless of whether data had arrived — that
 *      made the 15s timeout dead code and turned "capture" into a flat,
 *      unconditional 6-second wait. It now resolves as soon as both the
 *      request and response are captured, with 15s as a genuine max wait.
 *   4. [MODERATE] fetchAllCounts()'s session-expiry check now compares the
 *      actual HTTP status code (401/403) instead of doing a substring
 *      match against the error message text, which could false-trigger
 *      on unrelated text in a truncated error body.
 *   5. [MINOR] Removed the top-level replayForVideoUrl()/replayRequest()
 *      duplication; scrape.js's own replayForVideoUrl was dead code
 *      (defined, never called — confirmed by search). Both are replaced
 *      by a single call into replay_utils.replayApiRequest(), shared with
 *      shazam_recognition.js.
 *   6. [MINOR] extractCount()'s media_count.clips_count path now goes
 *      through the same parseCount/type validation as the other paths.
 * ================================================================
 */

// === ADDED (dotenv, additive): loads .env into process.env before anything
// else runs. Must be first, so GROQ_API_KEY is set before comment_analysis.js
// checks process.env.GROQ_API_KEY. If .env is missing, dotenv just no-ops —
// nothing else in the file changes.
require("dotenv").config();

const logger = require("./logger");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const diffusionEngine = require("./diffusion_engine");
const shazamRec = require("./shazam_recognition");
const replayUtils = require("./replay_utils");
// === ADDED (Tavily research workflow, this pass): purely additive module —
// see header of audio_research_workflow.js. Runs cache-first Tavily
// research over the Top 9 candidates and prints to console only. Never
// modifies discovery/replay/diffusion/prediction, and never touches
// comments or Groq.
const audioResearchWorkflow = require("./audio_research_workflow");
// === ADDED (results writer, this pass): purely additive module — writes
// the improved comment_analysis_results.json schema. Called AFTER
// commentAnalysis.runCommentAnalysis() below so its output (this module's
// improved, human-readable schema) is what's actually left on disk,
// without editing comment_analysis.js's own write logic at all.
const resultsWriter = require("./Results_writer");
// yt-dlp -> Telegram pipeline for the Top 1 candidate per trend region.
// See header of youtube_telegram_pipeline.js. Contains no new business
// logic, only connects youtube_search.js / youtube_downloader.js /
// telegram_sender.js (all pre-existing, unmodified).
const youtubeTelegramPipeline = require("./youtube_telegram_pipeline");
const telegramSender = require("./Telegram_sender");

const IS_DOCKER = fs.existsSync('/.dockerenv');

/* ===== Config ===== */
const CONFIG = {
  // Discovery
  MAX_DISCOVERED_AUDIO: 50,
  MAX_FEED_SCROLLS: 20,          // LEGACY fixed-count fallback, only used when FOLLOWING_DYNAMIC_DISCOVERY === false
  RECENCY_HOURS: 72, // 3 days — only audios within this window

  // === ADDED (dynamic discovery, additive): the Following Feed scroll loop
  // now stops based on real feed-exhaustion signals instead of a fixed
  // scroll count. Setting FOLLOWING_DYNAMIC_DISCOVERY to false restores the
  // old MAX_FEED_SCROLLS behavior exactly.
  FOLLOWING_DYNAMIC_DISCOVERY: true,
  FOLLOWING_MIN_SCROLLS: 20,           // don't evaluate stopping conditions before this many scrolls (warm-up)
  FOLLOWING_STALE_SCROLL_LIMIT: 8,     // stop after this many consecutive scrolls with no new reel loaded
  FOLLOWING_STALE_AUDIO_MS: 5 * 60 * 1000,   // stop if no new unique audio found for this long (5 min)
  FOLLOWING_MAX_RUNTIME_MS: 90 * 60 * 1000,  // absolute safety fail-safe (90 min)
  MAX_FEED_SCROLLS_HARD_CAP: 2000,     // absolute safety cap on scroll attempts regardless of mode

  // === ADDED (continuous scheduler, additive): setting this true makes a
  // plain `node scrape.js` run continuously (same as passing --continuous),
  // without needing the CLI flag. false (default) preserves the existing
  // "one cycle then exit" behavior used for manual/test runs.
  CONTINUOUS_MODE: false,
  CONTINUOUS_CYCLE_SLEEP_MS: 6300000,     // base sleep between completed cycles (1h45m)
  CONTINUOUS_CYCLE_JITTER_MS: 1800000,    // +/- random jitter added on top (up to 30m, i.e. up to ~2h15m)

  // Delays
  MIN_SCROLL_DELAY_MS: 2500,
  MAX_SCROLL_DELAY_MS: 4000,
  MIN_API_DELAY_MS: 1500,
  MAX_API_DELAY_MS: 3500,

  // Files
  DB_FILE: "./audio_growth_db.json",
  RESULTS_FILE: "./audio_trending_report.json",
  COOKIE_FILE: "./ig_session.json",
  CAPTURE_FILE: "./captured_request.json",
  PROFILE_PATH: "./ig-profile",

  // Capture timing
  CAPTURE_TIMEOUT_MS: 15000,

  // --- v5: Production prediction-engine tuning (additive, has sane defaults) ---
  SHORT_WINDOW_HOURS: 6,     // "what's happening right now"
  MEDIUM_WINDOW_HOURS: 24,   // "the established recent trend"
  LONG_WINDOW_HOURS: 72,     // "overall trajectory" (matches RECENCY_HOURS by default)
  MIN_COUNT_FLOOR: 20,       // below this, count noise dominates any relative-growth signal
  MAD_TO_SIGMA: 1.4826,      // standard MAD->stdev scaling constant under normal approximation
  ANOMALY_Z_THRESHOLD: 3.5,  // Iglewicz-Hoaglin robust-outlier convention
  BREAKOUT_Z_THRESHOLD: 2.0, // ~97.5th percentile one-sided under normal approximation

  // --- v6: Pre-Viral Diffusion Engine tuning (additive, has sane defaults) ---
  NICHE_MAP_FILE: "./creator_niches.json",             // optional, hand-maintained, zero-scraping
  DUPLICATE_REVIEW_FILE: "./duplicate_audio_review.json",
};

// === ADDED (dynamic discovery scoping, additive): computed once, shared by
// discoverFromFollowingFeed() (to decide whether to use dynamic scrolling)
// and by the entry point at the bottom of this file (to decide whether to
// run once or start the continuous scheduler) — same detection, single
// source of truth, instead of two independent checks that could drift.
const IS_CONTINUOUS_RUN =
  process.argv.includes('--continuous') || process.argv.includes('--daemon') || CONFIG.CONTINUOUS_MODE;

/* ===== Utilities ===== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return min + Math.random() * (max - min); }
function now() { return Date.now(); }
function hashString(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12); }
function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * cleanupOrphanedTempFiles()
 * Deletes files older than 24 hours from temporary audio/shazam directories
 * to prevent disk bloat after hard crashes.
 */
function cleanupOrphanedTempFiles() {
  const tempDirs = ['./tmp_shazam', './temp_audio'];
  const expiryMs = 24 * 60 * 60 * 1000;
  const currentTime = Date.now();

  tempDirs.forEach(dir => {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stats = fs.statSync(fullPath);
        if (currentTime - stats.mtimeMs > expiryMs) {
          fs.unlinkSync(fullPath);
        }
      });
    } catch (e) {
      console.log(`   ⚠️ Error cleaning ${dir}: ${e.message}`);
    }
  });
}

/* ===== Stealth ===== */
// ... (no changes in applyStealth)

async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    if (navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 }],
        configurable: true,
      });
    }
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  });
}

/* ===== Count parsing ===== */
function parseCount(str) {
  if (str == null) return null;
  const s = String(str).toUpperCase().trim().replace(/,/g, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.endsWith('K')) { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 1000); }
  if (s.endsWith('M')) { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 1000000); }
  if (s.endsWith('B')) { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 1000000000); }
  return null;
}

// Normalize a raw count field (may be a number or a formatted string like
// "12.3K") into a validated positive integer, or null.
function normalizeCountValue(raw) {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (typeof raw === 'string') {
    const p = parseCount(raw);
    if (p !== null && p > 0) return p;
  }
  return null;
}

function extractCount(obj, depth = 0) {
  if (depth > 50 || obj == null || typeof obj !== 'object') return null;
  const keys = ['clips_count', 'media_count', 'num_using_audio', 'display_num_using_audio', 'display_media_count', 'reels_count'];
  if (!Array.isArray(obj)) {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) {
        const v = normalizeCountValue(obj[k]);
        if (v !== null) return v;
      }
    }
    for (const k of Object.keys(obj)) {
      if (/formatted_.*count/i.test(k) && typeof obj[k] === 'string') {
        const p = parseCount(obj[k]); if (p !== null && p > 0) return p;
      }
    }
    // FIX: this path used to return obj.media_count.clips_count directly
    // without the same type/positivity validation the other paths get.
    if (obj.media_count && typeof obj.media_count === 'object') {
      const v = normalizeCountValue(obj.media_count.clips_count);
      if (v !== null) return v;
    }
  }
  if (Array.isArray(obj)) { for (const item of obj) { const r = extractCount(item, depth + 1); if (r !== null) return r; } }
  else { for (const v of Object.values(obj)) { const r = extractCount(v, depth + 1); if (r !== null) return r; } }
  return null;
}

/* ===== Audio extraction with metadata ===== */
function normalizeAudio(raw, mediaContext) {
  const title = raw.title || raw.music_asset_info?.title || raw.original_sound_info?.original_audio_title || raw.original_sound_info?.title || 'Unknown';
  const clusterId = raw.music_asset_info?.audio_cluster_id || raw.audio_cluster_id || null;
  const assetId = raw.original_sound_info?.audio_asset_id || raw.audio_asset_id || null;
  const idKey = clusterId || assetId || `title:${hashString(title)}`;

  return {
    idKey,
    title,
    audioClusterId: clusterId,
    audioAssetId: assetId,
    // First-seen metadata from the reel where we discovered this audio
    firstSeenCreator: mediaContext?.creatorUsername || null,
    firstSeenPost: mediaContext?.code ? `https://www.instagram.com/reel/${mediaContext.code}/` : null,
    takenAt: mediaContext?.takenAt || null,
    discoveredAt: now(),
  };
}

/**
 * Extract audio entries from a JSON API response.
 * Returns an array of { idKey, title, audioClusterId, audioAssetId, firstSeenCreator, firstSeenPost, takenAt }
 */
function extractAudioWithMetadata(json) {
  const results = new Map();

  function walk(obj, depth) {
    if (depth > 80 || obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth + 1)); return; }

    try {
      // Extract media context (creator, code, timestamp) — present on reel items
      let mediaContext = null;
      if (obj.code && (obj.user?.username || obj.owner?.username)) {
        mediaContext = {
          creatorUsername: obj.user?.username || obj.owner?.username,
          code: obj.code,
          takenAt: obj.taken_at || obj.taken_at_timestamp || null,
        };
      }

      // Check for audio info in various locations
      if (obj.clips_metadata?.music_info?.music_asset_info) {
        const n = normalizeAudio({ music_asset_info: obj.clips_metadata.music_info.music_asset_info }, mediaContext);
        if (!results.has(n.idKey)) results.set(n.idKey, n);
      }
      if (obj.clips_metadata?.original_sound_info?.audio_asset_id) {
        const n = normalizeAudio({ original_sound_info: obj.clips_metadata.original_sound_info }, mediaContext);
        if (!results.has(n.idKey)) results.set(n.idKey, n);
      }
      if (obj.music_info?.music_asset_info) {
        const n = normalizeAudio({ music_asset_info: obj.music_info.music_asset_info }, mediaContext);
        if (!results.has(n.idKey)) results.set(n.idKey, n);
      }
      if (obj.original_sound_info?.audio_asset_id) {
        const n = normalizeAudio({ original_sound_info: obj.original_sound_info }, mediaContext);
        if (!results.has(n.idKey)) results.set(n.idKey, n);
      }
    } catch (e) {}

    for (const v of Object.values(obj)) walk(v, depth + 1);
  }

  walk(json, 0);
  return [...results.values()];
}

/* ===== Reel novelty tracking (dynamic discovery, additive) =====
 * Lightweight walk that only collects reel `code` values (the same field
 * already used inside extractAudioWithMetadata's mediaContext detection).
 * This does NOT replace or alter extractAudioWithMetadata — it's a second,
 * independent pass used purely to detect when the feed stops returning any
 * reels we haven't already seen, which is one of the dynamic stop signals.
 */
function extractReelCodes(json) {
  const codes = new Set();
  function walk(obj, depth) {
    if (depth > 80 || obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth + 1)); return; }
    try {
      if (typeof obj.code === 'string' && obj.code.length > 0) codes.add(obj.code);
    } catch (e) {}
    for (const v of Object.values(obj)) walk(v, depth + 1);
  }
  try { walk(json, 0); } catch (e) {}
  return [...codes];
}

/* ===== DB ===== */
function loadDB() {
  try { return JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf8') || '{}'); }
  catch (e) { return {}; }
}
function saveDB(db) { atomicWriteFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2)); }

function makeAudioEntry(audioInfo) {
  return {
    idKey: audioInfo.idKey,
    title: audioInfo.title || 'Unknown audio',
    audioClusterId: audioInfo.audioClusterId || null,
    audioAssetId: audioInfo.audioAssetId || null,
    firstSeenCreator: audioInfo.firstSeenCreator || null,
    firstSeenPost: audioInfo.firstSeenPost || null,
    takenAt: audioInfo.takenAt || null,
    discoveredAt: now(),
  };
}

/* ================================================================
   DISCOVERY SOURCE: Following Feed (PRIMARY)
   ================================================================
   This account intentionally follows early-adopter creators.
   The Following Feed is therefore a high-quality trend discovery source.
   ================================================================ */

/**
 * @param {import('playwright').Page} page
 * @param {Array|undefined} sightingsSink - NEW (v6, OPTIONAL). If provided,
 *   every adoption-event sighting extracted from intercepted JSON during
 *   this scroll session is pushed here. Omitting it (as all v5 call sites
 *   used to) reproduces v5 behavior exactly — nothing is collected.
 */
async function discoverFromFollowingFeed(page, sightingsSink) {
  console.log('\n--- Following Feed (curated early-adopter creators) ---');
  const audioMap = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  let skippedOld = 0;

  // === ADDED (dynamic discovery, additive): state used only to decide when
  // to stop scrolling. Does not affect what gets discovered or returned.
  const seenReelCodes = new Set();
  let lastNewAudioAt = Date.now();
  const discoveryStart = Date.now();

  try {
    await page.goto('https://www.instagram.com/?variant=following', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(randomDelay(3000, 5000));

    const handler = async (response) => {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      
      if (!url.includes('/graphql/') && !url.includes('/api/')) return;
      if (!ct.includes('json')) return;

      try {
        const text = await response.text().catch(() => null);
        if (!text || text.length < 50) return;
        let json;
        try { json = replayUtils.parseJsonpBody(text); } catch (e) { return; }

        // DIAGNOSTIC: Log that we found a JSON response and what the top-level keys are
        console.log(`      📡 Intercepted JSON from ${url.slice(-30)}... Keys: ${Object.keys(json).join(', ')}`);

        const entries = extractAudioWithMetadata(json);

        for (const entry of entries) {
          // Recency filter: only audios posted within the last 72 hours (3 days)
          if (entry.takenAt) {
            const ageHours = (nowSec - entry.takenAt) / 3600;
            if (ageHours > CONFIG.RECENCY_HOURS) { skippedOld++; continue; }
          }
          if (!audioMap.has(entry.idKey)) {
            audioMap.set(entry.idKey, entry);
            lastNewAudioAt = Date.now(); // NEW (dynamic discovery)
          }
        }

        // === ADDED (dynamic discovery, additive): note any reel codes seen
        // in this response, reusing the SAME already-parsed JSON.
        try {
          const codes = extractReelCodes(json);
          for (const c of codes) seenReelCodes.add(c);
        } catch (e) { /* never let novelty tracking break discovery */ }

        // --- NEW (v6, additive): log every reel sighting as an adoption
        // event, reusing the SAME already-parsed JSON — no new requests.
        if (sightingsSink) {
          try {
            const sightings = diffusionEngine.extractAdoptionSightings(json);
            if (sightings.length) sightingsSink.push(...sightings);
          } catch (e) { /* never let diffusion capture break discovery */ }
        }
      } catch (e) {}
    };

    page.on('response', handler);
    console.log('   Scrolling...');

    // FIX (this pass): dynamic scrolling used to apply unconditionally,
    // which made a quick manual `node scrape.js` test run scroll 80+ times
    // (until the 5-min stale-audio stop) — the same as a real production
    // cycle. Manual/single-shot runs now use the fast, fixed MAX_FEED_SCROLLS
    // cap instead, exactly like before dynamic discovery was introduced;
    // full dynamic discovery is reserved for continuous/daemon runs, where
    // scrolling until the feed is genuinely exhausted is actually wanted.
    const dynamic = CONFIG.FOLLOWING_DYNAMIC_DISCOVERY && IS_CONTINUOUS_RUN;
    let i = 0;
    let scrollsSinceNewReel = 0;

    while (true) {
      if (audioMap.size >= CONFIG.MAX_DISCOVERED_AUDIO) {
        console.log(`      ✅ Reached MAX_DISCOVERED_AUDIO (${CONFIG.MAX_DISCOVERED_AUDIO}) — stopping.`);
        break;
      }
      if (i >= CONFIG.MAX_FEED_SCROLLS_HARD_CAP) {
        console.log(`      🛑 Hit absolute scroll safety cap (${CONFIG.MAX_FEED_SCROLLS_HARD_CAP}) — stopping.`);
        break;
      }
      if (dynamic && (Date.now() - discoveryStart) > CONFIG.FOLLOWING_MAX_RUNTIME_MS) {
        console.log(`      ⏱ Max discovery runtime reached (${Math.round(CONFIG.FOLLOWING_MAX_RUNTIME_MS / 60000)} min) — stopping.`);
        break;
      }
      if (!dynamic && i >= CONFIG.MAX_FEED_SCROLLS) {
        break; // LEGACY behavior, byte-identical stop condition to pre-v8
      }

      const reelCountBefore = seenReelCodes.size;
      await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
      await sleep(randomDelay(CONFIG.MIN_SCROLL_DELAY_MS, CONFIG.MAX_SCROLL_DELAY_MS));
      i++;

      if (dynamic) {
        // FIX (logic): the page.on('response', handler) processing a
        // scroll's network response is async and wasn't guaranteed to have
        // finished by the time we read seenReelCodes/audioMap right here —
        // on a slow response this could count a scroll as "stale" when a
        // matching reel was actually still in flight. A short settle wait
        // gives any in-flight handler a chance to finish before we check.
        await sleep(400);

        scrollsSinceNewReel = (seenReelCodes.size === reelCountBefore) ? scrollsSinceNewReel + 1 : 0;

        if (i >= CONFIG.FOLLOWING_MIN_SCROLLS) {
          if (scrollsSinceNewReel >= CONFIG.FOLLOWING_STALE_SCROLL_LIMIT) {
            console.log(`      🛑 No new reels loaded after ${scrollsSinceNewReel} consecutive scrolls — feed exhausted.`);
            break;
          }
          if ((Date.now() - lastNewAudioAt) > CONFIG.FOLLOWING_STALE_AUDIO_MS) {
            console.log(`      🛑 No new unique audio found in ${Math.round(CONFIG.FOLLOWING_STALE_AUDIO_MS / 60000)} min — stopping.`);
            break;
          }
        }
      }

      if (i % 5 === 0) {
        const staleInfo = dynamic ? ` | reels seen: ${seenReelCodes.size} | stale scrolls: ${scrollsSinceNewReel}` : '';
        console.log(`      Scroll ${i} — ${audioMap.size} audio (${skippedOld} skipped, >3d)${staleInfo}`);
      }
    }

    try { page.removeListener('response', handler); } catch (e) {}
    console.log(`      Loads processed.`);
  } catch (err) { console.log(`      ❌ ${err.message?.slice(0, 150)}`); }
  console.log(`   [Following] ✅ ${audioMap.size} audio found (${skippedOld} filtered out)`);
  return audioMap;
}

/* ================================================================
   PHASE 1: DISCOVER AUDIO
   ================================================================
   Modular: add more sources here by calling additional discover* functions.
   Currently only Following Feed (PRIMARY).
   ================================================================ */

/**
 * @param {import('playwright').Page} page
 * @param {Array|undefined} sightingsSink - NEW (v6, OPTIONAL, see above).
 */
async function discoverAudio(page, sightingsSink) {
  console.log('\n' + '='.repeat(60));
  console.log('🔍 PHASE 1: DISCOVER AUDIO');
  console.log('   PRIMARY SOURCE: Following Feed (intentionally curated)');
  console.log('   Recency: ≤ ' + CONFIG.RECENCY_HOURS + ' hours (3 days)');
  console.log('   Max unique: ' + CONFIG.MAX_DISCOVERED_AUDIO);
  console.log('='.repeat(60));

  // --- Modular discovery sources ---
  // Add more sources here later (Explore, Hashtags, Suggested Reels, etc.)
  const sources = [
    { name: 'Following Feed', fn: discoverFromFollowingFeed },
  ];

  const allAudio = new Map();

  for (const source of sources) {
    const result = await source.fn(page, sightingsSink); // sightingsSink passthrough (v6, additive)
    for (const [key, entry] of result) {
      if (!allAudio.has(key)) allAudio.set(key, entry);
    }
  }

  const final = [...allAudio.values()].slice(0, CONFIG.MAX_DISCOVERED_AUDIO);

  if (final.length === 0) {
    console.log('\n⚠️  DIAGNOSTIC: No audio discovered. Saving debug info...');
    try {
      // We need the page object here. Since discoverAudio is called as:
      // let audioTracks = await discoverAudio(page, adoptionSightings);
      // we have access to 'page'.
      await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
      const html = await page.content();
      fs.writeFileSync('debug.html', html);
      console.log(`   ✅ Saved debug_screenshot.png and debug.html to ${IS_DOCKER ? '/app' : '.'}`);
    } catch (e) {
      console.log(`   ❌ Failed to save debug info: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 DISCOVERY SUMMARY');
  console.log(`   Unique audios: ${allAudio.size}`);
  console.log(`   Returning: ${final.length}`);
  if (final.length > 0) {
    console.log('\n   Top discoveries (by recency):');
    final.slice(0, 5).forEach((a, i) => {
      const creator = a.firstSeenCreator ? ` by @${a.firstSeenCreator}` : '';
      console.log(`   ${i + 1}. "${a.title}"${creator}`);
    });
  }

  return final.map(makeAudioEntry);
}

/* ================================================================
   PHASE 2: CAPTURE ONE REAL API REQUEST
   ================================================================ */

/**
 * FIX (this pass): the old implementation raced two independent timers —
 * a 15s setTimeout and a `sleep(6000).then(...)` — where the 6s branch
 * ALWAYS fired first and unconditionally cleared the 15s timeout, whether
 * or not the request/response had actually been captured yet. That made
 * the 15s timeout dead code and turned every capture into a flat,
 * unconditional 6-second wait (too slow when the API responds instantly,
 * too short if it takes 6-15s).
 *
 * This version resolves the instant both the request and the response
 * have been captured, and uses CONFIG.CAPTURE_TIMEOUT_MS as a genuine
 * upper bound rather than a race participant.
 */
async function captureRequest(page, context, audioId) {
  console.log(`\n📡 PHASE 2: CAPTURE REAL API REQUEST (ID: ${audioId})`);

  return new Promise((resolve, reject) => {
    let captured = null;
    let responseData = null;
    let settled = false;

    const cleanup = () => {
      try { page.off('request', reqHandler); } catch (e) {}
      try { page.off('response', resHandler); } catch (e) {}
    };

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn();
    };

    const tryResolveEarly = () => {
      if (captured && responseData) {
        finish(() => resolve({ ...captured, response: responseData, count: extractCount(responseData) }));
      }
    };

    const reqHandler = async (request) => {
      if (request.url().includes('/api/v1/clips/music/') && request.method() === 'POST') {
        try {
          const headers = await request.allHeaders();
          const postData = request.postData() || '';
          console.log(`   ✅ Found API request!`);
          console.log(`   Headers: ${Object.keys(headers).length}`);
          console.log(`   Body: ${postData.slice(0, 120)}...`);
          captured = { url: request.url(), headers, postData };
          tryResolveEarly();
        } catch (e) { console.log(`   Error: ${e.message}`); }
      }
    };

    const resHandler = async (response) => {
      if (response.url().includes('/api/v1/clips/music/') && response.status() === 200) {
        try {
          const text = await response.text();
          responseData = replayUtils.parseJsonpBody(text);
          const count = extractCount(responseData);
          console.log(`   Response: ${count ? count.toLocaleString() + ' reels' : 'no count'} (${(text.length / 1024).toFixed(1)}KB)`);
          tryResolveEarly();
        } catch (e) { console.log(`   Parse error: ${e.message}`); }
      }
    };

    page.on('request', reqHandler);
    page.on('response', resHandler);

    const timer = setTimeout(() => {
      finish(() => {
        if (captured && responseData) {
          resolve({ ...captured, response: responseData, count: extractCount(responseData) });
        } else {
          reject(new Error('Timed out waiting for API request'));
        }
      });
    }, CONFIG.CAPTURE_TIMEOUT_MS);

    page.goto(`https://www.instagram.com/reels/audio/${audioId}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 12000,
    }).catch(() => {});
  });
}

/* ===== PHASE 3: FETCH ALL COUNTS VIA HTTP REPLAY ===== */

/**
 * Replay the captured request for one audio track, using the correct
 * form field for its ID type (cluster vs. asset — see replay_utils.js).
 */
async function replayForTrack(apiContext, captured, track) {
  const target = track.audioClusterId
    ? { clusterId: track.audioClusterId }
    : { assetId: track.audioAssetId };

  const result = await replayUtils.replayApiRequest(apiContext, captured, target);
  if (result.error) return { error: result.error, status: result.status };

  const count = extractCount(result.json);
  return { count, json: result.json, status: result.status };
}

async function fetchAllCounts(apiContext, captured, audioTracks) {
  const db = loadDB();
  let success = 0;

  console.log(`\n📊 PHASE 3: FETCH ${audioTracks.length} COUNTS VIA HTTP REPLAY`);

  for (let i = 0; i < audioTracks.length; i++) {
    const data = audioTracks[i];
    const id = data.audioClusterId || data.audioAssetId;
    if (!id) {
      console.log(`\n[${i + 1}/${audioTracks.length}] "${data.title.slice(0, 50)}" ❌ No ID`);
      continue;
    }

    const display = data.title.length > 50 ? data.title.slice(0, 50) + '...' : data.title;
    console.log(`\n[${i + 1}/${audioTracks.length}] "${display}" (ID: ${id})`);

    await sleep(randomDelay(CONFIG.MIN_API_DELAY_MS, CONFIG.MAX_API_DELAY_MS));

    const result = await replayForTrack(apiContext, captured, data);

    // FIX (this pass, CRITICAL): write snapshots under the canonical key
    // (falls back to idKey when there's no Shazam merge) instead of the
    // raw idKey. Otherwise mergeCanonicalAudios()'s consolidation gets
    // silently undone the very next time this function runs, because it
    // would recreate an entry at the old, now-deleted idKey.
    const dbKey = shazamRec.getEffectiveCanonicalKey(data);

    if (result.count !== undefined && result.count > 0) {
      if (!db[dbKey]) {
        db[dbKey] = {
          idKey: dbKey,
          title: data.title,
          audioClusterId: data.audioClusterId,
          audioAssetId: data.audioAssetId,
          firstSeenCreator: data.firstSeenCreator || null,
          firstSeenPost: data.firstSeenPost || null,
          takenAt: data.takenAt || null,
          firstSeenTime: now(),
          history: [],
        };
      }
      const hist = db[dbKey].history;
      if (!hist.length || hist[hist.length - 1].count !== result.count) {
        hist.push({ time: now(), count: result.count });
        success++;
        // CHANGED (this pass): label clarified — this means the count
        // CHANGED since the last snapshot (a fresh data point was
        // recorded), not that the audio itself was newly discovered. An
        // actively growing/shrinking trend will legitimately show this
        // every single run.
        console.log(`      ✅ ${result.count.toLocaleString()} reels (snapshot recorded — count changed)`);
      } else {
        console.log(`      ○ ${result.count.toLocaleString()} reels (unchanged since last snapshot)`);
      }
    } else if (result.error) {
      console.log(`      ❌ ${result.error.slice(0, 150)}`);
      // FIX (this pass): compare the actual status code instead of doing
      // a substring search over the error message, which could false-
      // trigger on unrelated text inside a truncated response body.
      if (result.status === 401 || result.status === 403) {
        console.log(`      ⚠️ Auth error — session may have expired`);
        saveDB(db);
        return { success, needsRecapture: true };
      }
    } else {
      console.log('      ❌ No count found');
    }
  }

  saveDB(db);
  console.log(`\n✅ Done: ${success}/${audioTracks.length} new counts`);
  return { success, needsRecapture: false };
}

/* ================================================================
   PHASE 4: PREDICTIVE ANALYTICS (legacy + v5, UNCHANGED)
   ================================================================ */

function calculateDoublingTime(sortedHistory) {
  if (sortedHistory.length < 2) return null;
  const first = sortedHistory[0].count;
  const last = sortedHistory[sortedHistory.length - 1].count;
  if (first <= 0 || last <= first) return null;
  const elapsedHours = (sortedHistory[sortedHistory.length - 1].time - sortedHistory[0].time) / 3600000;
  if (elapsedHours <= 0) return null;
  const growthRate = Math.log(last / first) / elapsedHours;
  return growthRate > 0 ? Math.round((Math.log(2) / growthRate) * 100) / 100 : null;
}

function predictFutureCount(sortedHistory, hoursFromNow = 24) {
  if (sortedHistory.length < 2) return null;
  const last = sortedHistory[sortedHistory.length - 1];
  const prev = sortedHistory.length >= 2 ? sortedHistory[sortedHistory.length - 2] : null;
  if (!prev) return null;
  const gapHours = (last.time - prev.time) / 3600000;
  if (gapHours <= 0) return null;
  const velocity = (last.count - prev.count) / gapHours;
  return Math.round(last.count + velocity * hoursFromNow);
}

function calculatePredictiveScore(history) {
  if (history.length < 2) return { score: 0, stage: 'Insufficient data', details: {} };

  const sorted = [...history].sort((a, b) => a.time - b.time);
  const firstCount = sorted[0].count;
  const lastCount = sorted[sorted.length - 1].count;
  const totalHours = (sorted[sorted.length - 1].time - sorted[0].time) / 3600000;
  const totalGrowth = lastCount - firstCount;

  const avgVelocity = totalHours > 0 ? totalGrowth / totalHours : 0;

  let recentVelocity = avgVelocity;
  if (sorted.length >= 2) {
    const lastGap = (sorted[sorted.length - 1].time - sorted[sorted.length - 2].time) / 3600000;
    if (lastGap > 0) {
      recentVelocity = (sorted[sorted.length - 1].count - sorted[sorted.length - 2].count) / lastGap;
    }
  }

  let earlyVelocity = avgVelocity;
  if (sorted.length >= 4) {
    const mid = Math.floor(sorted.length / 2);
    const early = sorted.slice(0, mid);
    const recent = sorted.slice(mid);
    const earlyTime = (early[early.length - 1].time - early[0].time) / 3600000;
    const recentTime = (recent[recent.length - 1].time - recent[0].time) / 3600000;
    const earlyGrowth = early[early.length - 1].count - early[0].count;
    // Simplified from an obfuscated index expression that always resolved
    // to the same thing: recent[recent.length-1].count - recent[0].count.
    const recentGrowth = recent[recent.length - 1].count - recent[0].count;
    earlyVelocity = earlyTime > 0 ? earlyGrowth / earlyTime : avgVelocity;
    recentVelocity = recentTime > 0 ? recentGrowth / recentTime : avgVelocity;
  }
  const acceleration = recentVelocity - earlyVelocity;

  const doublingTime = calculateDoublingTime(sorted);

  let positiveChanges = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].count > sorted[i - 1].count) positiveChanges++;
  }
  const consistency = sorted.length > 1 ? positiveChanges / (sorted.length - 1) : 0;

  let stage;
  if (recentVelocity <= 0 && lastCount > 0) stage = 'Declining';
  else if (recentVelocity > 10000 && acceleration > 200) stage = 'Viral';
  else if (recentVelocity > 1000 && acceleration > 100) stage = 'Trending';
  else if (recentVelocity > 100 && acceleration > 10) stage = 'Growing';
  else if (recentVelocity > 10 && acceleration >= 0) stage = 'Emerging';
  else if (recentVelocity > 0) stage = 'Slow growth';
  else stage = 'Unknown';

  const velocityScore = Math.min(100, Math.log10(Math.max(recentVelocity, 1) + 1) * 25);

  const accelScore = acceleration > 0
    ? Math.min(100, acceleration * 1.5)
    : Math.max(0, Math.min(20, 20 + acceleration * 3));

  const doublingScore = doublingTime !== null
    ? Math.min(100, (1 / Math.max(doublingTime, 0.01)) * 50)
    : 0;

  const consistencyScore = consistency * 30;

  const sizeInversionBonus = lastCount < 5000
    ? Math.min(40, (1 - lastCount / 5000) * 40)
    : 0;

  const ageHours = totalHours;
  const ageBonus = ageHours < 24
    ? Math.min(30, (1 - ageHours / 24) * 30)
    : 0;

  const rawScore = (
    velocityScore * 0.25 +
    accelScore * 0.30 +
    doublingScore * 0.15 +
    consistencyScore * 0.10 +
    sizeInversionBonus * 0.10 +
    ageBonus * 0.10
  );

  const penalty = recentVelocity < 0 ? 30 : 0;

  const finalScore = Math.max(0, Math.round(Math.min(100, rawScore - penalty)));

  return {
    score: finalScore,
    stage,
    details: {
      velocity: Math.round(recentVelocity),
      acceleration: Math.round(acceleration),
      avgVelocity: Math.round(avgVelocity),
      doublingTime: doublingTime !== null ? doublingTime + 'h' : 'N/A',
      consistency: Math.round(consistency * 100) / 100,
      totalGrowth,
      ageHours: Math.round(totalHours * 100) / 100,
    },
    predicted24h: predictFutureCount(sorted, 24),
  };
}

/* ================================================================
   v5 PRODUCTION-GRADE DETERMINISTIC PREDICTION ENGINE (UNCHANGED)
   ================================================================ */

function floorCount(c) { return Math.max(c, CONFIG.MIN_COUNT_FLOOR); }

function medianOf(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function madOf(arr, med) {
  if (arr.length === 0) return 0;
  const m = med !== undefined ? med : medianOf(arr);
  return medianOf(arr.map(x => Math.abs(x - m)));
}

function computeLogReturns(sortedHistory) {
  const out = [];
  for (let i = 1; i < sortedHistory.length; i++) {
    const dt = (sortedHistory[i].time - sortedHistory[i - 1].time) / 3600000;
    if (dt <= 0) continue;
    const c0 = floorCount(sortedHistory[i - 1].count);
    const c1 = floorCount(sortedHistory[i].count);
    out.push({
      rate: Math.log(c1 / c0) / dt,
      dt,
      midTime: (sortedHistory[i].time + sortedHistory[i - 1].time) / 2,
      time: sortedHistory[i].time,
      weight: 1,
    });
  }
  return out;
}

function flagAnomalies(logReturns) {
  if (logReturns.length < 4) return { anomalyCount: 0 };
  const rates = logReturns.map(r => r.rate);
  const med = medianOf(rates);
  const mad = madOf(rates, med);
  let anomalyCount = 0;
  for (const lr of logReturns) {
    const z = mad > 0 ? Math.abs(lr.rate - med) / (CONFIG.MAD_TO_SIGMA * mad) : 0;
    if (z > CONFIG.ANOMALY_Z_THRESHOLD) { lr.weight = 0.25; anomalyCount++; }
  }
  return { anomalyCount, median: med, mad };
}

function windowedEmaRate(logReturns, windowHours, halfLifeHours, refTime) {
  const cutoff = windowHours ? refTime - windowHours * 3600000 : -Infinity;
  const pts = logReturns.filter(r => r.midTime >= cutoff);
  if (pts.length === 0) return null;
  const lambda = Math.log(2) / halfLifeHours;
  let wSum = 0, wTotal = 0;
  for (const lr of pts) {
    const ageHours = (refTime - lr.midTime) / 3600000;
    const w = Math.exp(-lambda * ageHours) * lr.weight;
    wSum += w * lr.rate; wTotal += w;
  }
  return wTotal > 0 ? wSum / wTotal : null;
}

function computeVolatility(logReturns) {
  if (logReturns.length < 2) return null;
  const rates = logReturns.map(r => r.rate);
  const med = medianOf(rates);
  return CONFIG.MAD_TO_SIGMA * madOf(rates, med);
}

function fitLogLinear(sortedHistory) {
  const n = sortedHistory.length;
  if (n < 2) return null;
  const t0 = sortedHistory[0].time;
  const xs = sortedHistory.map(p => (p.time - t0) / 3600000);
  const ys = sortedHistory.map(p => Math.log(floorCount(p.count)));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0, n };
}

function computePersistence(shortRate, mediumRate, longRate) {
  const rates = [shortRate, mediumRate, longRate].filter(r => r !== null);
  if (rates.length < 2) return 0;
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  if (Math.abs(mean) < 1e-9) return 0;
  const variance = rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  return Math.max(0, 1 - Math.min(1, cv));
}

function computeGrowthEfficiency(shortRate, totalHoursObserved, longWindowHours) {
  if (shortRate === null || shortRate <= 0) return 0;
  // FIX (logic): the age term used to grow without bound — a track alive
  // for e.g. 10x the long window got its efficiency crushed toward zero
  // even while still growing at a genuinely strong, steady rate. That
  // directly fought against persistenceScore, which rewards exactly that
  // kind of sustained consistency. Capping the age factor at 1 means age
  // can at most halve efficiency, rather than erasing it as a track gets
  // older — persistence (not efficiency) remains the signal responsible
  // for rewarding longevity/consistency.
  const ageFactor = Math.min(1, totalHoursObserved / longWindowHours);
  return shortRate / (1 + ageFactor);
}

function detectBreakout(logReturns) {
  if (logReturns.length < 3) return { isBreakout: false, confirmed: false, z: 0 };
  const history = logReturns.slice(0, -1).map(r => r.rate);
  const med = medianOf(history), mad = madOf(history, med);
  const latest = logReturns[logReturns.length - 1].rate;
  const prev = logReturns[logReturns.length - 2].rate;
  const z = mad > 0 ? (latest - med) / (CONFIG.MAD_TO_SIGMA * mad) : 0;
  const prevZ = mad > 0 ? (prev - med) / (CONFIG.MAD_TO_SIGMA * mad) : 0;
  const isBreakout = z > CONFIG.BREAKOUT_Z_THRESHOLD;
  const confirmed = isBreakout && prevZ > CONFIG.BREAKOUT_Z_THRESHOLD * 0.5;
  return { isBreakout, confirmed, z: Math.round(z * 100) / 100 };
}

function computeConfidence(sortedHistory, fit, anomalyCount, longWindowHours) {
  const n = sortedHistory.length;
  const hours = (sortedHistory[n - 1].time - sortedHistory[0].time) / 3600000;
  const sampleFactor = Math.min(1, (n - 1) / 3);
  const timeFactor = Math.min(1, hours / (longWindowHours / 4));
  const fitFactor = fit ? Math.max(0, Math.min(1, fit.r2)) : 0;
  const anomalyPenalty = n > 1 ? Math.max(0, 1 - anomalyCount / (n - 1)) : 1;
  return sampleFactor * 0.30 + timeFactor * 0.25 + fitFactor * 0.25 + anomalyPenalty * 0.20;
}

function classifyLifecycleStage({ shortRate, mediumRate, longRate, volatility, breakout }) {
  if (shortRate === null || mediumRate === null) return 'Nascent';
  const sigma = volatility || 0.01;
  // FIX (logic): longRate was accepted as a parameter and even documented
  // as one of three windows this function considers, but no branch below
  // ever actually read it — it silently had zero effect on the stage,
  // only reaching the score indirectly via computePersistence(). Falling
  // back to mediumRate when a long-window fit isn't available yet (too
  // little history) preserves the exact old behavior for early audios;
  // once a long rate exists, it's now used to tell an already-established
  // trend ("Accelerating") apart from a fresh short-term burst that
  // hasn't shown up in the longer trend yet ("Emerging").
  const lr = longRate !== null && longRate !== undefined ? longRate : mediumRate;

  if (shortRate < -sigma) return 'Declining';
  if (breakout.confirmed) return 'Breakout';
  if (shortRate > mediumRate + sigma && mediumRate > lr) return 'Accelerating';
  if (shortRate > sigma && Math.abs(shortRate - mediumRate) <= sigma && mediumRate <= lr + sigma) return 'Emerging';
  if (shortRate > 0 && shortRate < mediumRate - sigma) return 'Peaking';
  if (Math.abs(shortRate) <= sigma) return 'Dormant';
  return 'Unclassified';
}

function calculateProductionPredictiveScore(history) {
  if (history.length < 2) {
    return { score: 0, confidence: 0, stage: 'Nascent', breakout: { isBreakout: false, confirmed: false, z: 0 }, details: {} };
  }

  const sorted = [...history].sort((a, b) => a.time - b.time);
  const refTime = sorted[sorted.length - 1].time;
  const logReturns = computeLogReturns(sorted);
  const { anomalyCount } = flagAnomalies(logReturns);
  const fit = fitLogLinear(sorted);

  const shortRate = windowedEmaRate(logReturns, CONFIG.SHORT_WINDOW_HOURS, CONFIG.SHORT_WINDOW_HOURS / 2, refTime);
  const mediumRate = windowedEmaRate(logReturns, CONFIG.MEDIUM_WINDOW_HOURS, CONFIG.MEDIUM_WINDOW_HOURS / 2, refTime);
  const longRate = fit ? fit.slope : null;
  const volatility = computeVolatility(logReturns);
  const persistence = computePersistence(shortRate, mediumRate, longRate);
  const totalHours = (sorted[sorted.length - 1].time - sorted[0].time) / 3600000;
  const efficiency = computeGrowthEfficiency(shortRate, totalHours, CONFIG.LONG_WINDOW_HOURS);
  const breakout = detectBreakout(logReturns);
  const confidence = computeConfidence(sorted, fit, anomalyCount, CONFIG.LONG_WINDOW_HOURS);

  const lastCount = sorted[sorted.length - 1].count;
  const growthPositive = shortRate !== null && shortRate > 0;
  const stage = classifyLifecycleStage({ shortRate, mediumRate, longRate, volatility, breakout });

  const growthScore = growthPositive ? Math.min(100, Math.log10((Math.exp(shortRate) - 1) * 100 + 1) * 35) : 0;
  const persistenceScore = persistence * 100;
  const efficiencyScore = Math.min(100, efficiency * 400);
  const breakoutScore = breakout.confirmed ? Math.min(100, breakout.z * 20) : 0;
  const sizeBonus = growthPositive && lastCount < 5000 ? (1 - lastCount / 5000) * 100 : 0;

  const rawScore = growthScore * 0.40 + persistenceScore * 0.25 + efficiencyScore * 0.15
                  + breakoutScore * 0.10 + sizeBonus * 0.10;

  const score = Math.max(0, Math.round(rawScore * confidence));

  return {
    score,
    confidence: Math.round(confidence * 100) / 100,
    stage,
    breakout,
    details: {
      shortRatePerHour: shortRate !== null ? Math.round(shortRate * 10000) / 10000 : null,
      mediumRatePerHour: mediumRate !== null ? Math.round(mediumRate * 10000) / 10000 : null,
      longRatePerHour: longRate !== null ? Math.round(longRate * 10000) / 10000 : null,
      volatility: volatility !== null ? Math.round(volatility * 10000) / 10000 : null,
      persistence: Math.round(persistence * 100) / 100,
      efficiency: Math.round(efficiency * 10000) / 10000,
      fitR2: fit ? Math.round(fit.r2 * 1000) / 1000 : null,
      anomalyCount,
    },
  };
}

function rankCohort(reportRows) {
  const eligible = reportRows.filter(r =>
    typeof r.scoreConfidence === 'number' && r.scoreConfidence >= 0.3 &&
    typeof r.shortRatePerHour === 'number'
  );
  const rates = eligible.map(r => r.shortRatePerHour).sort((a, b) => a - b);

  for (const row of reportRows) {
    if (typeof row.shortRatePerHour !== 'number' || rates.length === 0) {
      row.cohortPercentile = null;
      continue;
    }
    const below = rates.filter(r => r <= row.shortRatePerHour).length;
    row.cohortPercentile = Math.round((below / rates.length) * 100);
  }
  return reportRows;
}

function generatePredictiveReport(db) {
  const report = [];

  for (const [id, rec] of Object.entries(db)) {
    const h = rec.history || [];
    if (h.length < 2) continue;

    const sorted = [...h].sort((a, b) => a.time - b.time);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const analysis = calculatePredictiveScore(h);
    const production = calculateProductionPredictiveScore(h);

    const growths = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].time - sorted[i - 1].time) / 3600000;
      const g = sorted[i].count - sorted[i - 1].count;
      growths.push({
        from: sorted[i - 1].count,
        to: sorted[i].count,
        growth: g,
        velocity: gap > 0 ? Math.round(g / gap) : 0,
        timeGapHours: Math.round(gap * 100) / 100,
      });
    }

    report.push({
      id,
      title: rec.title || 'Unknown',
      audioClusterId: rec.audioClusterId,
      audioAssetId: rec.audioAssetId,

      firstSeenCreator: rec.firstSeenCreator || null,
      firstSeenPost: rec.firstSeenPost || null,
      firstSeenTime: rec.firstSeenTime || first.time,
      takenAt: rec.takenAt || null,
      ageHours: Math.round((now() - (rec.firstSeenTime || first.time)) / 3600000 * 100) / 100,

      currentCount: last.count,
      snapshotCount: sorted.length,

      totalGrowth: last.count - first.count,
      growths,

      ...analysis.details,

      trendStage: analysis.stage,
      predictiveScore: analysis.score,

      predicted24hCount: analysis.predicted24h,

      productionScore: production.score,
      scoreConfidence: production.confidence,
      lifecycleStage: production.stage,
      breakoutDetected: production.breakout.isBreakout,
      breakoutConfirmed: production.breakout.confirmed,
      breakoutZ: production.breakout.z,
      shortRatePerHour: production.details.shortRatePerHour,
      mediumRatePerHour: production.details.mediumRatePerHour,
      longRatePerHour: production.details.longRatePerHour,
      rateVolatility: production.details.volatility,
      persistence: production.details.persistence,
      growthEfficiency: production.details.efficiency,
      fitR2: production.details.fitR2,
      anomalyCount: production.details.anomalyCount,
      // diffusion (v6) is attached by run(), after this function returns —
      // it needs the full db (including adoptionEvents) which this function
      // already has, but keeping the attach step in run() keeps this
      // function byte-identical to v5 for anyone diffing the two versions.
    });
  }

  rankCohort(report);

  return report.sort((a, b) => b.predictiveScore - a.predictiveScore);
}

/* ================================================================
   RUN
   ================================================================ */

async function run() {
  console.log('='.repeat(60));
  console.log('🎵 IG AUDIO TREND TRACKER v6 — PREDICTIVE + DIFFUSION');
  console.log('   Source: Following Feed (curated early-adopter creators)');
  console.log('   Recency: 3 days | Legacy + v5 production + v6 diffusion engine');
  console.log('='.repeat(60));

  try { fs.unlinkSync('./cooldown_until.json'); } catch (e) {}

  // Startup Maintenance
  cleanupOrphanedTempFiles();
  const depCheck = shazamRec.verifyDependencies();
  if (!depCheck.ok) {
    console.log(`\n⚠️  [Dependency Warning] ${depCheck.error}`);
    console.log('   Shazam recognition will be skipped this run.');
  }

  // === DOCKER PROFILE DIAGNOSTICS ===
  if (IS_DOCKER) {
    console.log('\n🔍 [Docker Profile Diagnostic]');
    const absProfilePath = path.resolve(CONFIG.PROFILE_PATH);
    console.log(`   Resolved Profile Path: ${absProfilePath}`);
    
    if (fs.existsSync(absProfilePath)) {
      try {
        const stats = fs.statSync(absProfilePath);
        console.log(`   Directory exists. Permissions: ${stats.mode.toString(8)} | UID: ${stats.uid} | GID: ${stats.gid}`);
        
        const files = fs.readdirSync(absProfilePath);
        console.log(`   Contents (${files.length} items): ${files.join(', ')}`);
        
        const criticalFiles = ['Default', 'Local State', 'Default/Preferences'];
        criticalFiles.forEach(f => {
          const exists = fs.existsSync(path.join(absProfilePath, f));
          console.log(`   Critical file [${f}]: ${exists ? '✅ FOUND' : '❌ MISSING'}`);
        });
      } catch (e) {
        console.log(`   ❌ Error reading profile directory: ${e.message}`);
      }
    } else {
      console.log(`   ❌ Profile directory DOES NOT EXIST at ${absProfilePath}`);
    }
    console.log('='.repeat(30) + '\n');
  }

  // === LOCK FILE CLEANUP ===
  // Chromium creates lock files that can prevent a persistent profile from loading
  // if the previous session didn't shut down cleanly (common in Docker).
  if (IS_DOCKER) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    lockFiles.forEach(file => {
      const lockPath = path.join(CONFIG.PROFILE_PATH, file);
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          console.log(`   🧹 Removed lock file: ${file}`);
        } catch (e) {
          console.log(`   ⚠️ Could not remove lock file ${file}: ${e.message}`);
        }
      }
    });
  }

  const context = await chromium.launchPersistentContext(CONFIG.PROFILE_PATH, {
    headless: process.env.HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars'],
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 200) },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  try {
  await applyStealth(context);
  const page = context.pages()[0] || await context.newPage();

  console.log('[🌐] Checking login...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (page.url().includes('login')) {
    console.log('[⚠️] Please log in manually...');
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      if (!page.url().includes('login')) { console.log('[✅] Logged in!'); break; }
      if (i % 6 === 0) process.stdout.write('.');
    }
    console.log('');
  }

  // No need for context.storageState() as launchPersistentContext handles persistence automatically

  // --- NEW (v6, additive): accumulator for adoption-event sightings,
  // populated from the SAME intercepted responses Phase 1 already parses.
  const adoptionSightings = [];

  // Phase 1: Discover
  let audioTracks = await discoverAudio(page, adoptionSightings);
  console.log(`\n✅ Found ${audioTracks.length} tracks from Following Feed`);

  if (audioTracks.length === 0) { return; }

  // --- NEW (v6, additive): persist adoption events into the same DB file,
  // in a new `adoptionEvents` array per audio. Does not touch `history`.
  if (adoptionSightings.length > 0) {
    const dbForDiffusion = loadDB();
    const added = diffusionEngine.mergeAdoptionSightings(dbForDiffusion, adoptionSightings);
    saveDB(dbForDiffusion);
    const uniqueAudios = new Set(adoptionSightings.map(s => s.idKey)).size;
    console.log(`\n🧬 [Diffusion] Logged ${added} new adoption-event sighting(s) across ${uniqueAudios} audio(s)`);
  }

  const captureId = audioTracks.find(t => t.audioClusterId)?.audioClusterId ||
                    audioTracks.find(t => t.audioAssetId)?.audioAssetId;
  if (!captureId) { console.log('❌ No usable audio IDs'); return; }

  console.log(`\n   Using audio ID for capture: ${captureId}`);

  console.log('\n📡 PHASE 2: CAPTURE REAL API REQUEST');
  const captured = await captureRequest(page, context, captureId);

  console.log(`   ✅ Captured ${Object.keys(captured.headers).length} headers`);
  const filteredCount = Object.keys(captured.headers).filter(k => !k.startsWith(':')).length;
  console.log(`   ✅ Usable headers: ${filteredCount}`);

  atomicWriteFileSync(CONFIG.CAPTURE_FILE, JSON.stringify({
    capturedAt: now(),
    endpoint: captured.url,
    headers: captured.headers,
    postData: captured.postData,
    sampleCount: captured.count,
  }, null, 2));

  /* ================================================================
     FIX: Shazam recognition now gets the apiContext so each Original
     Audio receives its OWN video URL via request replay, instead of
     all sharing the same video from the Phase 2 capture response.
     ================================================================ */
  const { recognitionDb } = await shazamRec.recognizeAfterCapture(
    audioTracks,
    captured,
    page.request  // pass apiContext so each audio gets its own video URL
  );
  console.log(`\n✅ Shazam recognition phase complete`);

  // === ADDED v7: Merge canonical audio entries in the DB ===
  // If multiple Instagram Original Audio IDs resolve to the same song,
  // merge their growth histories so trends aren't fragmented
  const dbForMerge = loadDB();
  const mergesPerformed = shazamRec.mergeCanonicalAudios(dbForMerge, recognitionDb);
  if (mergesPerformed > 0) {
    console.log(`\n🔗 Merged ${mergesPerformed} canonical audio group(s) in the database`);
  }

  // === ADDED (title enrichment, additive): an entry's `title` is set once
  // from Instagram's own raw label (often literally the generic "Original
  // audio" IG gives unlabeled sounds) and mergeCanonicalAudios() never
  // overwrites it with what Shazam actually recognized — it only ever
  // keeps whichever generic label happened to already be there. This pass
  // upgrades the display title with the recognized "Artist — Title" once
  // Shazam has identified the song, for both merged and still-unmerged
  // entries. Only `title` (plus new, additive recognizedArtist/
  // recognizedTitle/recognizedIsrc fields) is touched — idKey, history,
  // and adoptionEvents are never modified here.
  let titlesUpgraded = 0;
  try {
    const GENERIC_TITLES = new Set(['original audio', 'unknown', 'unknown audio', '']);
    for (const entry of Object.values(dbForMerge)) {
      if (!entry) continue;
      const candidateIds = [entry.audioAssetId, ...(entry.alternateAudioAssetIds || [])].filter(Boolean);
      let rec = null;
      for (const aid of candidateIds) {
        const r = recognitionDb[aid];
        if (r && r.status === 'recognized' && r.artist && r.title) { rec = r; break; }
      }
      if (!rec) continue;

      entry.recognizedArtist = rec.artist;
      entry.recognizedTitle = rec.title;
      entry.recognizedIsrc = rec.isrc || null;

      const isGeneric = GENERIC_TITLES.has(String(entry.title || '').trim().toLowerCase());
      const recognizedLabel = `${rec.artist} — ${rec.title}`;
      if (isGeneric && entry.title !== recognizedLabel) {
        entry.title = recognizedLabel;
        titlesUpgraded++;
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Title enrichment skipped: ${e.message}`);
  }

  if (mergesPerformed > 0 || titlesUpgraded > 0) {
    if (titlesUpgraded > 0) {
      console.log(`   🏷️  Upgraded ${titlesUpgraded} generic title(s) with Shazam-recognized song name(s)`);
    }
    saveDB(dbForMerge);
  }

  const limit = Math.min(audioTracks.length, CONFIG.MAX_DISCOVERED_AUDIO);
  const result = await fetchAllCounts(page.request, captured, audioTracks.slice(0, limit));

  console.log('\n' + '='.repeat(60));
  console.log('🏆 PREDICTIVE TRENDING REPORT');
  console.log('   Legacy scoring: velocity × acceleration × doubling time × age');
  console.log('   v5 production scoring: relative growth × persistence × efficiency × breakout');
  console.log('   v6 diffusion scoring: Hawkes branching × gated Bass upside × spread × single-source check');
  console.log('='.repeat(60));

  const db = loadDB();
  const report = generatePredictiveReport(db);

  // --- NEW (v6, additive): compute the diffusion engine's output and
  // attach it as a new `diffusion` field per row. Does not alter report
  // sort order or any existing field.
  const diffusionResult = diffusionEngine.generateDiffusionReport(db, { NICHE_MAP_FILE: CONFIG.NICHE_MAP_FILE });
  for (const row of report) {
    row.diffusion = diffusionResult.diffusionByIdKey[row.id] || null;
  }
  if (diffusionResult.duplicateReviewQueue.length > 0) {
    atomicWriteFileSync(CONFIG.DUPLICATE_REVIEW_FILE, JSON.stringify(diffusionResult.duplicateReviewQueue, null, 2));
  }

  // === ADDED (comment analysis, v8, additive): attach a normalized
  // `shazamRecognition` field per row so comment_analysis.js (which expects
  // shazamRecognition.status === "recognized") can read it. This does NOT
  // change recognitionDb, does not alter any existing report field, and is
  // wrapped so a lookup miss/shape surprise can never break the report.
  try {
    for (const row of report) {
      const rec =
        (recognitionDb && (recognitionDb[row.id] || recognitionDb[row.audioAssetId])) || null;
      row.shazamRecognition = rec
        ? {
            status: rec.recognized ? "recognized" : "failed",
            artist: rec.artist || null,
            title: rec.title || null,
            isrc: rec.isrc || null,
          }
        : null;
    }
  } catch (e) {
    console.log(`   ⚠️ [Comment Analysis] Could not attach shazam context: ${e.message}`);
  }

  // === ADDED (Tavily research workflow, this pass): runs strictly AFTER
  // the diffusion engine has selected/scored candidates AND after the
  // shazamRecognition field above is attached (so the Shazam-confirmed
  // artist, when available, can be passed to Tavily as a hint). Only reads
  // `report` — never mutates it. Candidate selection, prediction scoring,
  // and diffusion scoring are completely untouched by this phase.
  // Cache-first via audio_research_cache.js (Task 2): a candidate already
  // in audio_ai_cache.json is never re-sent to Tavily. Console-only output
  // — does not analyze comments, does not call Groq, does not touch the
  // report or any existing DB file. Wrapped so a failure here can never
  // break the main run.
  let aiResearchResults = [];
  try {
    aiResearchResults = await audioResearchWorkflow.runTopCandidateResearch(report, page, context, captured);
  } catch (e) {
    console.log(`\n   ⚠️ [AI Research Preview] Phase skipped due to error: ${e.message}`);
  }

  // === UPDATED (yt-dlp migration): connects the already-built
  // youtube_search.js -> youtube_downloader.js -> telegram_sender.js
  // modules for the Top 1 candidate in each of Kerala/India/Global
  // Trending. Pure wiring — youtube_telegram_pipeline.js contains no new
  // business logic, it only calls those modules' existing exported
  // functions in order. Runs strictly after AI research/trend
  // classification (aiResearchResults above) and before the report is
  // printed below, exactly as specified. Every underlying module already
  // handles its own failures without throwing (search/download/Telegram
  // issues continue the scraper), and this call is additionally wrapped
  // so nothing here can ever break the main run or affect
  // prediction/report logic.
  try {
    await youtubeTelegramPipeline.sendTop1TrendingViaYoutube(aiResearchResults);
  } catch (e) {
    console.log(`\n   ⚠️ [YouTube/Telegram Pipeline] Skipped due to error: ${e.message}`);
  }

  if (report.length > 0) {
    report.slice(0, 10).forEach((r, i) => {
      console.log(`\n${i + 1}. "${r.title}"`);
      console.log(`   🎯 Legacy Score: ${r.predictiveScore}/100 | Stage: ${r.trendStage}`);
      console.log(`   🧪 v5 Score: ${r.productionScore}/100 (confidence ${Math.round(r.scoreConfidence * 100)}%) | Lifecycle: ${r.lifecycleStage}`);
      if (r.breakoutConfirmed) console.log(`   🚀 Confirmed breakout (z=${r.breakoutZ})`);
      console.log(`   📈 ${r.currentCount.toLocaleString()} reels (+${r.totalGrowth.toLocaleString()} total)`);
      console.log(`   ⚡ Velocity: ${r.velocity}/h | 🚀 Accel: ${r.acceleration}/h²`);
      console.log(`   ⏱  Doubling: ${r.doublingTime} | Consistency: ${r.consistency}`);
      console.log(`   🕐 Age: ${r.ageHours}h | Snapshots: ${r.snapshotCount}`);
      if (r.shortRatePerHour !== null) {
        console.log(`   📐 Rate (short/med/long, /h): ${r.shortRatePerHour} / ${r.mediumRatePerHour} / ${r.longRatePerHour} | Persistence: ${r.persistence}`);
      }
      if (r.cohortPercentile !== null) console.log(`   🏅 Cohort percentile: ${r.cohortPercentile}th`);
      if (r.predicted24hCount !== null) {
        console.log(`   🔮 Predicted (24h, legacy linear model): ${r.predicted24hCount.toLocaleString()} reels`);
      }
      if (r.diffusion) {
        console.log(`   🧬 Diffusion: ${r.diffusion.diffusionScore}/100 | ${r.diffusion.regimeLabel} | creators: ${r.diffusion.uniqueCreators} | confidence: ${Math.round(r.diffusion.confidence * 100)}%`);
        if (r.diffusion.singleSourceFlag) console.log(`      ⚠️  Single-source cascade detected (max creator share: ${Math.round(r.diffusion.maxCreatorShare * 100)}%)`);
      }
      if (r.firstSeenCreator) {
        console.log(`   👤 First seen: @${r.firstSeenCreator}`);
      }
    });

    console.log('\n🔥 FASTEST ACCELERATING (legacy metric, most likely to trend next):');
    const topAccel = [...report].sort((a, b) => b.acceleration - a.acceleration).slice(0, 5);
    topAccel.forEach((r, i) => {
      console.log(`   ${i + 1}. "${r.title}" — ${r.acceleration}/h², currently ${r.currentCount.toLocaleString()} reels`);
    });

    console.log('\n⚡ FASTEST DOUBLING (legacy metric, explosive growth):');
    const topDouble = [...report]
      .filter(r => r.doublingTime !== 'N/A')
      .sort((a, b) => parseFloat(a.doublingTime) - parseFloat(b.doublingTime))
      .slice(0, 5);
    topDouble.forEach((r, i) => {
      console.log(`   ${i + 1}. "${r.title}" — doubles every ${r.doublingTime}, score: ${r.predictiveScore}`);
    });

    console.log('\n🚀 CONFIRMED BREAKOUTS (v5, statistically significant + confirmed):');
    const breakouts = report.filter(r => r.breakoutConfirmed).sort((a, b) => b.breakoutZ - a.breakoutZ).slice(0, 5);
    if (breakouts.length === 0) {
      console.log('   None this run.');
    } else {
      breakouts.forEach((r, i) => {
        console.log(`   ${i + 1}. "${r.title}" — z=${r.breakoutZ}, v5 score: ${r.productionScore}, confidence: ${Math.round(r.scoreConfidence * 100)}%`);
      });
    }

    console.log('\n🧪 TOP BY v5 PRODUCTION SCORE:');
    const topProduction = [...report].sort((a, b) => b.productionScore - a.productionScore).slice(0, 5);
    topProduction.forEach((r, i) => {
      console.log(`   ${i + 1}. "${r.title}" — v5: ${r.productionScore}/100 | legacy: ${r.predictiveScore}/100 | ${r.lifecycleStage}`);
    });

    // --- NEW (v6): top by pre-viral diffusion score — the engine designed
    // to answer "will this take off soon" rather than "is this big now."
    console.log('\n🧬 TOP BY PRE-VIRAL DIFFUSION SCORE (v6, Hawkes + gated Bass + spread):');
    const topDiffusion = [...report]
      .filter(r => r.diffusion && r.diffusion.diffusionScore != null)
      .sort((a, b) => b.diffusion.diffusionScore - a.diffusion.diffusionScore)
      .slice(0, 5);
    if (topDiffusion.length === 0) {
      console.log('   Not enough adoption-event history yet — run Phase 1 a few more times to accumulate unique-creator arrivals per audio.');
    } else {
      topDiffusion.forEach((r, i) => {
        const d = r.diffusion;
        console.log(`   ${i + 1}. "${r.title}" — diffusion: ${d.diffusionScore}/100 | regime: ${d.regimeLabel} | confidence: ${Math.round(d.confidence * 100)}%`);
        console.log(`      creators: ${d.uniqueCreators} | branching ratio: ${d.hawkes ? d.hawkes.branchingRatio : 'N/A'} | remaining upside: ${d.remainingUpside ?? 'N/A (unidentifiable or n/a)'}`);
      });
    }

    if (diffusionResult.duplicateReviewQueue.length > 0) {
      console.log(`\n🔎 [Diffusion] ${diffusionResult.duplicateReviewQueue.length} possible duplicate-title audio pair(s) written to ${CONFIG.DUPLICATE_REVIEW_FILE} for manual review.`);
    }

  } else {
    console.log('\n   Not enough data for trending (need ≥ 2 snapshots per audio).');
    console.log('   Run again later to build history!');
  }

  // === ADDED (results writer, this pass): runs strictly AFTER Phase 5, so
  // this improved, human-readable schema is what ends up on disk at
  // comment_analysis_results.json — comment_analysis.js's own write (a few
  // lines above, inside runCommentAnalysis) is untouched; this simply
  // writes again afterward with the cleaner shape, using the data already
  // gathered by the AI Research phase above. Wrapped so a failure here can
  // never break the main run.
  try {
    resultsWriter.writeCommentAnalysisResults(aiResearchResults);
  } catch (e) {
    console.log(`\n   ⚠️ [Results Writer] Could not write improved results file: ${e.message}`);
  }

  atomicWriteFileSync(CONFIG.RESULTS_FILE, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report saved to ${CONFIG.RESULTS_FILE}`);
  console.log(`📊 ${result.success} new counts | 💾 ${Object.keys(db).length} entries in DB`);
  if (result.needsRecapture) console.log('⚠️ Session may need refreshing.');

  console.log('\n✅ Done!');
  } finally {
    // Always runs exactly once — on normal completion, an early return, or
    // an exception thrown anywhere above — so the browser process and its
    // profile lock are never leaked. .catch() swallows a redundant
    // "already closed" error in case something upstream already closed it.
    await context.close().catch(() => {});
  }
}

async function main() {
  try {
    try { fs.unlinkSync('./cooldown_until.json'); } catch (e) {}
    await run();
  } catch (err) {
    console.error('\n❌ FATAL:', err?.message || err);
    if (err?.stack) console.error(err.stack);
  }
}

/* ================================================================
   CONTINUOUS MONITORING SCHEDULER (fully additive, non-invasive)
   ================================================================
   Two entry modes:
     node scrape.js              — one run, exit (unchanged behavior)
     node scrape.js --continuous — perpetual monitoring with fixed schedule
*/

function formatDuration(ms) {
  const totalSec = Math.round(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function dbEntryCount(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8') || '{}';
    return Object.keys(JSON.parse(raw)).length;
  } catch { return 0; }
}

function recognitionStats(filePath) {
  try {
    const db = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    const entries = Object.values(db);
    return {
      recognized: entries.filter(e => e.recognized).length,
      failed: entries.filter(e => !e.recognized).length,
    };
  } catch { return { recognized: 0, failed: 0 }; }
}

async function updateHeartbeat() {
  try {
    fs.writeFileSync('.heartbeat', Date.now().toString());
  } catch (e) {
    logger.error("Failed to update heartbeat file", e);
  }
}

// === ADDED (Hosting): Fixed schedule slots (hours) ===
const SCHEDULE_SLOTS = [6, 8, 10, 12, 14, 16, 18, 20];

/**
 * getMsUntilNextSlot()
 * Calculates milliseconds from now until the next fixed schedule slot.
 */
function getMsUntilNextSlot() {
  const now = new Date();
  const currentHour = now.getHours();
  
  const nextSlot = SCHEDULE_SLOTS.find(slot => slot > currentHour);
  
  if (nextSlot !== undefined) {
    const target = new Date(now);
    target.setHours(nextSlot, 0, 0, 0);
    return target.getTime() - now.getTime();
  } else {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(SCHEDULE_SLOTS[0], 0, 0, 0);
    return target.getTime() - now.getTime();
  }
}

function formatTime(date) {
  return date.toTimeString().slice(0, 5);
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

async function sendHeartbeat(type, details = {}) {
  if (process.env.TELEGRAM_HEARTBEAT !== 'true') return;

  const now = new Date();
  let text = "";

  if (type === 'START') {
    text = `🟢 <b>Instagram Trend Scraper</b>\n\nStatus: Running\n\nRun Time:\n${formatDate(now)} ${formatTime(now)}\n\nHost:\nDocker Container`;
  } else if (type === 'SUCCESS') {
    const { start, end, duration, candidates, kerala, india, global } = details;
    text = `✅ <b>Run Completed</b>\n\nStarted:\n${start}\n\nFinished:\n${end}\n\nDuration:\n${duration} minutes\n\nCandidates:\n${candidates}\n\nKerala Trending:\n${kerala}\n\nIndia Trending:\n${india}\n\nGlobal Trending:\n${global}\n\nStatus:\nCompleted Successfully`;
  } else if (type === 'FAILURE') {
    const { time, error, nextRun } = details;
    text = `🔴 <b>Instagram Trend Scraper</b>\n\nRun Failed\n\nTime:\n${time}\n\nReason: ${error}\n\nNext scheduled run:\n${nextRun}`;
  }

  if (text) {
    logger.info(`Sending Telegram heartbeat: ${type}`);
    await telegramSender.sendTextMessage(text);
  }
}

async function continuousRunner() {
  logger.info('='.repeat(60));
  logger.info('🎵 IG AUDIO TREND TRACKER — PRODUCTION HOSTING MODE');
  logger.info(`   Started:        ${formatTimestamp(Date.now())}`);
  logger.info(`   Schedule:       06:00, 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00`);
  logger.info('='.repeat(60));

  let cycleNumber = 0;
  let consecutiveBrowserFailures = 0;
  const MAX_BROWSER_RETRIES = 3;

  const onSignal = (sig) => { logger.warn(`\n⚠️ ${sig} received — exiting.`); process.exit(0); };
  process.on('SIGINT',  () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  logger.info('[🚀] Performing immediate startup run...');
  try {
    await sendHeartbeat('START');
    const startT = Date.now();
    await run();
    await handleRunCompletion(startT);
    consecutiveBrowserFailures = 0;
  } catch (err) {
    logger.error(`\n❌ STARTUP RUN FAILED:`, err);
    await sendHeartbeat('FAILURE', {
      time: formatTime(new Date()),
      error: err.message,
      nextRun: getNextSlotTime()
    });
  }

  while (true) {
    cycleNumber++;
    const waitMs = getMsUntilNextSlot();
    const nextSlotDate = new Date(Date.now() + waitMs);
    
    logger.info(`\n💤 Sleeping until next scheduled run: ${formatTimestamp(nextSlotDate.getTime())} (${formatDuration(waitMs)})`);
    await sleep(waitMs);

    const cycleStart = Date.now();
    logger.info('\n' + '='.repeat(60));
    logger.info(`🔄 SCHEDULED CYCLE #${cycleNumber}`);
    logger.info(`   Started: ${formatTimestamp(cycleStart)}`);
    logger.info('='.repeat(60));

    try {
      await updateHeartbeat();
      await sendHeartbeat('START');
      await run();
      await handleRunCompletion(cycleStart);
      consecutiveBrowserFailures = 0;
    } catch (err) {
      logger.error(`\n❌ CYCLE #${cycleNumber} FAILED:`, err);
      
      const isBrowserError = err.message?.includes('playwright') || 
                             err.message?.includes('Target closed') || 
                             err.message?.includes('browser') || 
                             err.message?.includes('context');

      if (isBrowserError && consecutiveBrowserFailures < MAX_BROWSER_RETRIES) {
        consecutiveBrowserFailures++;
        logger.warn(`Browser crash detected. Attempting recovery ${consecutiveBrowserFailures}/${MAX_BROWSER_RETRIES} in 30s...`);
        await sleep(30000);
        continue; 
      }

      await sendHeartbeat('FAILURE', {
        time: formatTime(new Date()),
        error: err.message,
        nextRun: getNextSlotTime()
      });
      
      await sleep(15 * 60 * 1000);
    }
  }
}

async function handleRunCompletion(startTime) {
  const endTime = Date.now();
  const durationMin = Math.round((endTime - startTime) / 60000);
  
  let candidates = 0, kerala = 0, india = 0, global = 0;
  try {
    const report = JSON.parse(fs.readFileSync(CONFIG.RESULTS_FILE, 'utf8') || '[]');
    candidates = report.length;
    kerala = report.filter(r => r.diffusion?.regimeLabel === 'Kerala').length || 0;
    india = report.filter(r => r.diffusion?.regimeLabel === 'India').length || 0;
    global = report.filter(r => r.diffusion?.regimeLabel === 'Global').length || 0;
  } catch (e) {
    logger.warn(`Could not read report for completion message: ${e.message}`);
  }

  await sendHeartbeat('SUCCESS', {
    start: formatTime(new Date(startTime)),
    end: formatTime(new Date(endTime)),
    duration: durationMin,
    candidates: candidates,
    kerala: kerala,
    india: india,
    global: global
  });
  logger.info(`Completion message sent. Duration: ${durationMin}m`);
}

function getNextSlotTime() {
  const waitMs = getMsUntilNextSlot();
  return formatTime(new Date(Date.now() + waitMs));
}

if (IS_CONTINUOUS_RUN) {
  continuousRunner().catch(err => {
    console.error('\n❌ FATAL (continuous):', err?.message || err);
    process.exit(1);
  });
} else {
  main();
}