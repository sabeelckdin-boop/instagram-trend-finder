/**
 * candidate_cache.js — Permanent, unified candidate analysis cache.
 *
 * STANDALONE / ADDITIVE — does not modify prediction logic, discovery,
 * replay, growth calculation, reporting, diffusion scoring, or any
 * existing module's behavior. This is an orchestration layer on top of
 * the three analyses already built:
 *   - Origin lookup      (tavily_research.js + audio_research_cache.js, Task 1/2)
 *   - Comment language    (groq_comment_language.js, Task 4)
 *   - Trend region         (trend_region_classifier.js, Task 5 — deterministic, no AI)
 *
 * Guarantee: if an audio has already been analyzed (all three pieces
 * present in audio_ai_cache.json), calling this module again for that
 * audio makes ZERO new API requests (no Tavily, no Groq) — it simply
 * reads the cache. This is enforced two ways:
 *   1. researchAudioWithCache() and analyzeCommentLanguageWithCache() are
 *      themselves already cache-first (Task 2 / Task 4) — this module
 *      calls them exactly as-is, so their own cache checks apply.
 *   2. classifyTrendRegion() makes no API calls at all (pure function),
 *      but its result is still cached and read back, so "if already
 *      analyzed, simply read cache" holds uniformly across all three.
 *
 * Cache identity — IMPORTANT:
 *   The cache key is the Shazam-recognized ISRC when available, NOT the
 *   raw Instagram audioId. The same real-world song can appear under
 *   multiple different Instagram audioClusterId/audioAssetId values
 *   (reposts, re-uploads, different original-audio wrappers), but it has
 *   ONE ISRC. Keying by ISRC means "only new audio IDs [meaning new
 *   *songs*, identified via Shazam ISRC] should trigger analysis" — a
 *   second Instagram audioId for a song we've already analyzed is
 *   recognized as the same candidate and short-circuits to cache.
 *   Falls back to the raw audioId only when Shazam hasn't recognized this
 *   audio yet (no ISRC available) — see caveat in getCandidateAnalysis's
 *   docstring below.
 *
 * Persistence: all data lives in audio_ai_cache.json on disk (written
 * atomically by audio_research_cache.js), so the cache survives process
 * restarts — nothing here is held only in memory.
 */

const { researchAudioWithCache, getCachedTrendRegion, saveTrendRegionToCache } = require("./audio_research_cache");
const { analyzeCommentLanguageWithCache } = require("./groq_comment_language");
const { calculateScores } = require("./Trend_region_classifier");

/* ===== Cache key resolution ===== */

/**
 * Resolve the canonical cache key for a candidate: ISRC when Shazam has
 * recognized it, otherwise the raw Instagram audioId.
 *
 * CAVEAT (documented, not silently papered over): if this audio hasn't
 * been Shazam-recognized yet, analysis runs and caches under the raw
 * audioId. If it's recognized as a known ISRC on a later run, that later
 * run will use the ISRC as the key instead — which is a *different* cache
 * entry, so the analysis will (correctly, if wastefully) run once more
 * under the new ISRC-keyed entry. From then on, every appearance of that
 * ISRC — including under other Instagram audioIds — reads from that one
 * ISRC-keyed entry.
 */
function resolveCacheKey({ audioId, isrc }) {
  const cleanIsrc = isrc && typeof isrc === "string" && isrc.trim() ? isrc.trim() : null;
  const cleanAudioId = audioId && typeof audioId === "string" && audioId.trim() ? audioId.trim() : null;
  return cleanIsrc || cleanAudioId || null;
}

/* ===== Public API ===== */

/**
 * getCandidateAnalysis({ audioId, isrc, title, artist, comments })
 *
 * The single entry point for full candidate analysis. Runs (or reads from
 * cache) all three pieces:
 *   1. Origin lookup (Tavily, cache-first)
 *   2. Comment language (Groq, cache-first)
 *   3. Trend region (deterministic, cache-first)
 *
 * If this candidate (by ISRC, or by audioId when no ISRC is available yet)
 * has already been fully analyzed, this makes NO new API requests at all
 * — every field is read straight from audio_ai_cache.json.
 *
 * @param {object} params
 * @param {string} params.audioId - Instagram audio identifier (fallback cache key)
 * @param {string} [params.isrc] - Shazam-recognized ISRC (preferred cache key)
 * @param {string} params.title - Audio/song title
 * @param {string} [params.artist] - Artist name, if known
 * @param {string[]} [params.comments] - Comment text strings (first 30 used)
 * @returns {Promise<object>} {
 *   cacheKey, keyedBy: "isrc"|"audioId",
 *   origin, country, artist,
 *   commentLanguage: { primaryLanguage, secondaryLanguage, commentSummary, confidence },
 *   trendRegion: { region, reason },
 *   fullyFromCache: boolean,   // true iff ALL THREE were served from cache — zero API calls made
 *   madeApiCalls: boolean,     // convenience inverse of fullyFromCache
 * }
 */
async function getCandidateAnalysis({ audioId, isrc, title, artist, comments } = {}) {
  const cacheKey = resolveCacheKey({ audioId, isrc });

  if (!cacheKey) {
    return {
      cacheKey: null,
      keyedBy: null,
      error: "No audioId or isrc provided — cannot cache or analyze",
      fullyFromCache: false,
      madeApiCalls: false,
    };
  }

  const keyedBy = isrc && isrc.trim() ? "isrc" : "audioId";

  // 1. Origin lookup — cache-first (Task 2). No new Tavily call if this
  // cacheKey already has a research entry.
  const originResult = await researchAudioWithCache({ audioId: cacheKey, title, artist });

  // 2. Comment language — cache-first (Task 4). No new Groq call if this
  // cacheKey already has a commentLanguage entry.
  const commentLangResult = await analyzeCommentLanguageWithCache({
    audioId: cacheKey,
    title,
    artist: artist || originResult.artist || null,
    comments,
  });

  // 3. Trend region — check cache first; only compute (still zero API
  // cost either way) and persist if not already cached.
  let trendRegionResult;
  let trendRegionFromCache;
  const cachedTrendRegion = getCachedTrendRegion(cacheKey);
  if (cachedTrendRegion) {
    trendRegionResult = cachedTrendRegion.trendRegion;
    trendRegionFromCache = true;
  } else {
    trendRegionResult = calculateScores({
      origin: originResult.origin,
      country: originResult.country,
      songLanguage: originResult.language,
      languageDistribution: commentLangResult.languageDistribution,
      researchEvidence: originResult.researchEvidence || [],
    });
    saveTrendRegionToCache(cacheKey, trendRegionResult);
    trendRegionFromCache = false;
  }

  const fullyFromCache = originResult.fromCache && commentLangResult.fromCache && trendRegionFromCache;

  // ADDED (this pass): granular flags for downstream reporting (e.g. the
  // Phase 5 stats footer) — does not change fullyFromCache/madeApiCalls,
  // just exposes the per-source breakdown that was already available
  // internally.
  const hadComments = Array.isArray(comments) && comments.filter(c => typeof c === "string" && c.trim()).length > 0;
  const groqCalled = !commentLangResult.fromCache && hadComments;

  return {
    cacheKey,
    keyedBy,
    origin: originResult.origin,
    country: originResult.country,
    artist: artist || originResult.artist || null,
    commentLanguage: {
      primaryLanguage: commentLangResult.primaryLanguage,
      secondaryLanguage: commentLangResult.secondaryLanguage,
      commentSummary: commentLangResult.commentSummary,
      confidence: commentLangResult.confidence,
    },
    trendRegion: trendRegionResult,
    fullyFromCache,
    madeApiCalls: !fullyFromCache,
    originFromCache: originResult.fromCache,
    commentLanguageFromCache: commentLangResult.fromCache,
    groqCalled,
  };
}

module.exports = { getCandidateAnalysis, resolveCacheKey };

/* ===== Self-test / manual verification =====
 * Run directly to verify the permanent, unified cache end-to-end:
 *   node candidate_cache.js <audioId> "Song Title" ["Artist Name"] ["ISRC"]
 * Run it twice with the same arguments — the second run should report
 * fullyFromCache: true and madeApiCalls: false.
 */
if (require.main === module) {
  const [, , cliAudioId, cliTitle, cliArtist, cliIsrc] = process.argv;

  const SAMPLE_COMMENTS = ["nice song", "super hit", "love it"];

  if (!cliAudioId || !cliTitle) {
    console.log('Usage: node candidate_cache.js <audioId> "Song Title" ["Artist Name"] ["ISRC"]');
    process.exit(1);
  }

  (async () => {
    console.log(`🔎 Full candidate analysis for audioId=${cliAudioId}${cliIsrc ? ` (isrc=${cliIsrc})` : ""}...\n`);
    const result = await getCandidateAnalysis({
      audioId: cliAudioId,
      isrc: cliIsrc,
      title: cliTitle,
      artist: cliArtist,
      comments: SAMPLE_COMMENTS,
    });
    console.log(result.fullyFromCache ? "✅ Fully served from cache — zero API calls made" : "📡 At least one fresh API call was made and cached");
    console.log(JSON.stringify(result, null, 2));
  })();
}