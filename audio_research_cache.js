/**
 * audio_research_cache.js — Persistent cache layer in front of Tavily research.
 *
 * STANDALONE / ADDITIVE — NOT wired into gittest.js, replay_utils.js,
 * shazam_recognition.js, or comment_analysis.js. Nothing in this pass
 * changes any existing scraper logic (discovery, replay, growth
 * calculation, reporting, prediction scoring, or comment analysis).
 * Comment analysis integration is explicitly out of scope for this task.
 *
 * Purpose: sit in front of tavily_research.js so the same audio is never
 * researched twice.
 *
 *   1. Check audio_ai_cache.json for this audioId.
 *   2. If found → return the cached entry (no Tavily call).
 *   3. If not found → call Tavily via researchAudio().
 *   4. Save the result to the cache, keyed by audioId.
 *   5. Return the (now-cached) entry.
 *
 * Cache file: audio_ai_cache.json (same directory as this module), written
 * atomically (write-to-temp + rename), matching the pattern already used
 * by audio_recognition_db.json in shazam_recognition.js.
 *
 * Stored per audioId:
 *   { audioId, title, artist, origin, language, country, researchedAt }
 */

const fs = require("fs");
const path = require("path");
const { researchAudio } = require("./tavily_research");

/* ===== Config ===== */
const CACHE_FILE = path.join(__dirname, "audio_ai_cache.json");

/* ===== Atomic file I/O (mirrors shazam_recognition.js's pattern) ===== */
function atomicWriteSync(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8") || "{}");
  } catch (e) {
    return {};
  }
}

function saveCache(db) {
  atomicWriteSync(CACHE_FILE, JSON.stringify(db, null, 2));
}

/* ===== Public API ===== */

/**
 * getCachedResearch(audioId)
 * Read-only lookup — does NOT call Tavily. Returns the cached entry or
 * null if this audioId has never been researched.
 *
 * @param {string} audioId
 * @returns {object|null}
 */
function getCachedResearch(audioId) {
  if (!audioId) return null;
  const db = loadCache();
  return db[audioId] || null;
}

/**
 * researchAudioWithCache({ audioId, title, artist })
 *
 * Cache-first wrapper around tavily_research.researchAudio(). This is the
 * only entry point that should ever trigger a Tavily call for a given
 * audioId — once an audioId has an entry in audio_ai_cache.json, it is
 * never sent to Tavily again by this function.
 *
 * @param {object} params
 * @param {string} params.audioId - Stable identifier for this audio
 *   (e.g. audioAssetId / audioClusterId / idKey). Required — this is the
 *   cache key.
 * @param {string} params.title - Audio/song title (required if not cached)
 * @param {string} [params.artist] - Artist name, if already known
 * @returns {Promise<object>} Cache entry:
 *   {
 *     audioId, title, artist, origin, language, country,
 *     researchedAt,      // ISO timestamp of when it was researched
 *     fromCache,         // true if served from cache, false if freshly researched
 *     tavilySuccess,     // whether Tavily resolved at least one field (fresh only)
 *     tavilyErrors,      // per-field error messages, if any (fresh only)
 *   }
 */
async function researchAudioWithCache({ audioId, title, artist } = {}) {
  if (!audioId) {
    return {
      audioId: null,
      title: title || null,
      artist: artist || null,
      origin: null,
      language: null,
      country: null,
      researchedAt: null,
      fromCache: false,
      error: "No audioId provided — cannot cache or research",
    };
  }

  // 1. Check cache first.
  const db = loadCache();
  const existing = db[audioId];
  if (existing) {
    return { ...existing, fromCache: true };
  }

  // 2. Not cached — call Tavily.
  const research = await researchAudio({ title, artist });

  // 3. Build the cache entry (only the fields this task asks to store).
  const entry = {
    audioId,
    title: title || null,
    artist: artist || research.artist || null,
    origin: research.originState || null,
    language: research.songLanguage || null,
    country: research.originCountry || null,
    researchedAt: research.fetchedAt,
  };

  // 4. Save to cache — regardless of whether Tavily fully succeeded, so
  // this audioId is never re-researched (per requirement #5). tavilySuccess
  // / tavilyErrors are attached to the returned object (not persisted) so
  // the caller can see what happened on this fresh lookup without the
  // stored cache file carrying transient error noise.
  db[audioId] = entry;
  saveCache(db);

  // 5. Return the cached entry.
  return {
    ...entry,
    fromCache: false,
    tavilySuccess: research.success,
    tavilyErrors: research.errors,
  };
}

module.exports = {
  researchAudioWithCache,
  getCachedResearch,
  loadCache,
  saveCache,
  getCachedCommentLanguage,
  saveCommentLanguageToCache,
  getCachedTrendRegion,
  saveTrendRegionToCache,
};

/* =====================================================================
 * ADDED (this pass) — Comment-language cache extension
 *
 * Adds two new optional fields to the SAME per-audioId cache entry used
 * by researchAudioWithCache():
 *   - commentLanguage         (the Groq JSON result — see groq_comment_language.js)
 *   - commentLanguageAnalyzedAt (ISO timestamp)
 *
 * This does not change the shape or behavior of any existing field
 * (audioId, title, artist, origin, language, country, researchedAt) —
 * those are still written exactly as before by researchAudioWithCache().
 * An entry may exist with only the Tavily fields (not yet comment-
 * analyzed), only if it was created before this pass, or with both once
 * saveCommentLanguageToCache() has run for it.
 * ===================================================================== */

/**
 * getCachedCommentLanguage(audioId)
 * Read-only lookup — does NOT call Groq. Returns the full cache entry
 * (including commentLanguage) if this audioId already has a Groq comment-
 * language result cached, or null if it doesn't (either never cached at
 * all, or cached for Tavily research only).
 *
 * @param {string} audioId
 * @returns {object|null}
 */
function getCachedCommentLanguage(audioId) {
  if (!audioId) return null;
  const db = loadCache();
  const entry = db[audioId];
  return entry && entry.commentLanguage ? entry : null;
}

/**
 * saveCommentLanguageToCache(audioId, commentLanguageResult)
 * Persists a Groq comment-language result into the cache entry for this
 * audioId, creating a minimal entry if one doesn't already exist (e.g.
 * comment-language analysis run before/without Tavily research). Once
 * saved, getCachedCommentLanguage(audioId) will short-circuit any future
 * Groq call for this audio — see requirement: "Groq never runs again for
 * the same audio."
 *
 * @param {string} audioId
 * @param {object} commentLanguageResult - The Groq JSON result (already
 *   validated/parsed by groq_comment_language.js)
 * @returns {object} The updated cache entry
 */
function saveCommentLanguageToCache(audioId, commentLanguageResult) {
  if (!audioId) return null;

  const db = loadCache();
  const existing = db[audioId] || {
    audioId,
    title: null,
    artist: null,
    origin: null,
    language: null,
    country: null,
    researchedAt: null,
  };

  db[audioId] = {
    ...existing,
    commentLanguage: commentLanguageResult,
    commentLanguageAnalyzedAt: new Date().toISOString(),
  };

  saveCache(db);
  return db[audioId];
}

/* =====================================================================
 * ADDED (this pass, Task 6) — Trend-region cache extension
 *
 * Adds two more additive fields to the SAME per-audioId entry:
 *   - trendRegion            (the deterministic classifier's output —
 *                              see trend_region_classifier.js)
 *   - trendRegionClassifiedAt (ISO timestamp)
 *
 * No existing field's shape or behavior changes. trend_region_classifier.js
 * itself makes no API calls (it's a pure function), so caching this isn't
 * about avoiding cost — it's about satisfying "if already analyzed, simply
 * read cache" uniformly across all three analyses for a given audio.
 * ===================================================================== */

/**
 * getCachedTrendRegion(audioId)
 * Read-only lookup. Returns the full cache entry (including trendRegion)
 * if this audioId already has a classified trend region, or null.
 *
 * @param {string} audioId
 * @returns {object|null}
 */
function getCachedTrendRegion(audioId) {
  if (!audioId) return null;
  const db = loadCache();
  const entry = db[audioId];
  return entry && entry.trendRegion ? entry : null;
}

/**
 * saveTrendRegionToCache(audioId, trendRegionResult)
 * Persists a classifyTrendRegion() result into the cache entry for this
 * audioId, creating a minimal entry if one doesn't already exist.
 *
 * @param {string} audioId
 * @param {object} trendRegionResult - { region, reason } from trend_region_classifier.js
 * @returns {object} The updated cache entry
 */
function saveTrendRegionToCache(audioId, trendRegionResult) {
  if (!audioId) return null;

  const db = loadCache();
  const existing = db[audioId] || {
    audioId,
    title: null,
    artist: null,
    origin: null,
    language: null,
    country: null,
    researchedAt: null,
  };

  db[audioId] = {
    ...existing,
    trendRegion: trendRegionResult,
    trendRegionClassifiedAt: new Date().toISOString(),
  };

  saveCache(db);
  return db[audioId];
}

/* ===== Self-test / manual verification =====
 * Run directly to verify cache-first behavior end-to-end:
 *   node audio_research_cache.js <audioId> "Song Title" ["Artist Name"]
 * Run it twice with the same audioId — the second run should report
 * fromCache: true and make no Tavily call.
 */
if (require.main === module) {
  const [, , cliAudioId, cliTitle, cliArtist] = process.argv;

  if (!cliAudioId || !cliTitle) {
    console.log('Usage: node audio_research_cache.js <audioId> "Song Title" ["Artist Name"]');
    process.exit(1);
  }

  (async () => {
    console.log(`🔎 Looking up audioId=${cliAudioId} ("${cliTitle}"${cliArtist ? ` by ${cliArtist}` : ""})...\n`);
    const result = await researchAudioWithCache({ audioId: cliAudioId, title: cliTitle, artist: cliArtist });
    console.log(result.fromCache ? "✅ Served from cache (no Tavily call made)" : "📡 Freshly researched via Tavily and cached");
    console.log(JSON.stringify(result, null, 2));
  })();
}