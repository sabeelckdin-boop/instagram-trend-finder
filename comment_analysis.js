/**
 * comment_analysis.js — Instagram Reel Comment Analysis Module
 *
 * ADDITIVE MODULE — does not touch any existing code in scrape.js,
 * diffusion_engine.js, shazam_recognition.js, or replay_utils.js.
 *
 * Architecture:
 *   1. Called AFTER prediction pipeline finishes (Phase 4 + diffusion)
 *   2. Only runs on a filtered subset of top candidates
 *   3. Reuses the authenticated Playwright browser session for API calls
 *   4. Fetches 50–80 comments via Instagram's /api/v1/media/{id}/comments/
 *   5. Sends audio metadata + comment text to Groq for trend classification
 *   6. Attaches { audioOrigin, trendClassification, reason } to report rows
 *
 * COMPATIBILITY:
 *   - Requires groq-sdk npm package (add to package.json)
 *   - Requires GROQ_API_KEY environment variable
 *   - All functions are wrapped so they can never throw — failures degrade
 *     gracefully to null/empty rather than crashing the pipeline.
 *   - No existing function is modified, renamed, or has its behavior changed.
 */

const Groq = require("groq-sdk");
// FIX (this pass): fallback media-ID lookup below replays the captured
// clips/music request (same mechanism scrape.js Phase 3 and
// shazam_recognition.js already use) instead of relying solely on
// firstSeenPost, which is frequently null — see getMediaIdForRow.
const replayUtils = require("./replay_utils");

/* ===== Config ===== */
const CONFIG = {
  TOP_N_BY_DIFFUSION: 9,
  MIN_COMMENTS: 45, // ADDED (this pass): paginate until at least this many are fetched (or no more pages)
  MAX_COMMENTS: 60, // CHANGED (this pass): was 80 — user requested a max of 60 fetched comments
  COMMENTS_API_TIMEOUT_MS: 15000,

  GROQ_MODEL: "llama-3.3-70b-versatile",
  GROQ_TEMPERATURE: 0,
  GROQ_MAX_TOKENS: 600,

  // ADDED (this pass): gates all verbose/technical console output (raw AI
  // responses, prompts, HTTP request bodies, token usage, parse-error
  // detail, stack traces) behind an explicit opt-in so normal runs stay
  // clean. Set DEBUG=true in the environment to see the full detail again.
  DEBUG: String(process.env.DEBUG).toLowerCase() === "true",

  COMMENT_ANALYSIS_FILE: "./comment_analysis_results.json",
};

/* ===== Groq client (lazy init) ===== */
let _groqClient = null;

function getGroqClient() {
  if (_groqClient) return _groqClient;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("   ⚠️  GROQ_API_KEY not set — comment analysis will be skipped.");
    return null;
  }

  try {
    _groqClient = new Groq({ apiKey });
    return _groqClient;
  } catch (e) {
    console.warn(`   ⚠️  Failed to initialize Groq client: ${e.message}`);
    return null;
  }
}

/* ===== Shortcode → numeric Media ID conversion ===== */

/**
 * Convert an Instagram shortcode (from /reel/CODE/) to a numeric media ID.
 * Instagram uses a custom base64 alphabet: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_
 * The shortcode is a base64 encoding of the media ID.
 */
function shortcodeToMediaId(shortcode) {
  if (!shortcode || typeof shortcode !== "string" || shortcode.length === 0) return null;

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // Use BigInt for 64-bit precision — media IDs can exceed Number.MAX_SAFE_INTEGER
  let id = 0n;

  for (const char of shortcode) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) return null; // invalid character
    id = id * 64n + BigInt(idx);
  }

  return id.toString();
}

/**
 * Extract shortcode from an Instagram reel URL.
 */
function extractShortcodeFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/reel\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Get a numeric media ID from a report row using only locally-available
 * data (no network). Uses the firstSeenPost URL to decode the shortcode.
 */
function getMediaIdFromReportRow(row) {
  if (!row) return null;

  // Try the firstSeenPost URL first
  const shortcode = extractShortcodeFromUrl(row.firstSeenPost);
  if (shortcode) {
    return shortcodeToMediaId(shortcode);
  }

  return null;
}

/**
 * FIX (this pass): extract a numeric media ID (and/or shortcode) from a
 * replayed /api/v1/clips/music/ response.
 * 
 * IMPROVEMENT: Now accepts a 'preferredCreator' username. Since we already have 
 * the JSON list of reels from the API replay, we simply scan that list for 
 * the original creator before falling back to the first available reel. 
 * This requires NO browser navigation.
 */
function extractMediaIdFromClipsResponse(json, preferredCreator = null) {
  if (!json || typeof json !== "object") return null;

  function idFromItem(item) {
    if (!item || typeof item !== "object") return null;
    const media = item.media && typeof item.media === "object" ? item.media : item;
    if (typeof media.code === "string" && media.code.length > 0) {
      const id = shortcodeToMediaId(media.code);
      if (id) return id;
    }
    if (typeof media.pk === "string" || typeof media.pk === "number") {
      const s = String(media.pk);
      if (/^\d+$/.test(s)) return s;
    }
    return null;
  }

  if (Array.isArray(json.items) && json.items.length > 0) {
    // First pass: Scan the JSON list for the original creator to avoid 'random reel' bias
    if (preferredCreator) {
      for (const item of json.items) {
        const username = item.user?.username || item.owner?.username;
        if (username === preferredCreator) {
          const id = idFromItem(item);
          if (id) return id;
        }
      }
    }

    // Second pass: Fallback to the first available reel in the JSON list
    for (const item of json.items) {
      const id = idFromItem(item);
      if (id) return id;
    }
  }

  // Fallback: shallow recursive walk
  let found = null;
  function walk(obj, depth) {
    if (found || depth > 10 || obj == null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const id = idFromItem(it);
        if (id) { found = id; return; }
        walk(it, depth + 1);
        if (found) return;
      }
      return;
    }
    for (const v of Object.values(obj)) {
      walk(v, depth + 1);
      if (found) return;
    }
  }
  walk(json, 0);
  if (found) {
    console.log("      ⚠️ extractMediaIdFromClipsResponse: fell back to recursive walk — response shape may have changed");
  }
  return found;
}

/**
 * FIX (this pass): resolve a media ID for a report row, falling back to
 * replaying the captured clips/music request for this row's audio ID when
 * firstSeenPost is missing/unparseable.
 */
async function getMediaIdForRow(row, apiContext, captured) {
  const direct = getMediaIdFromReportRow(row);
  if (direct) return { mediaId: direct, source: "firstSeenPost" };

  if (!apiContext || !captured || (!row.audioClusterId && !row.audioAssetId)) {
    return { mediaId: null, source: null };
  }

  const target = row.audioClusterId
    ? { clusterId: row.audioClusterId }
    : { assetId: row.audioAssetId };

  try {
    const result = await replayUtils.replayApiRequest(apiContext, captured, target);
    if (result.error || !result.json) return { mediaId: null, source: null };
    
    // IMPROVEMENT: Pass the firstSeenCreator to the extractor to prioritize 
    // the correct reel from the already-fetched JSON data.
    const mediaId = extractMediaIdFromClipsResponse(result.json, row.firstSeenCreator);
    return { mediaId, source: mediaId ? "replay_fallback" : null };
  } catch (e) {
    return { mediaId: null, source: null };
  }
}

/* ===== Emoji stripping =====
 * CHANGED (this pass): user requested emojis be excluded from fetched
 * comments. Strips emoji/pictograph/symbol code points (and the variation
 * selectors / ZWJ sequences used to combine them) while leaving all actual
 * language text — including Malayalam/Tamil/Telugu/Kannada/Hindi script —
 * completely untouched, since that text still feeds language detection.
 */
const EMOJI_PATTERN = /([\u{1F1E6}-\u{1F1FF}]|[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{23FF}]|[\u{2B00}-\u{2BFF}]|[\u{FE0F}]|[\u{200D}])/gu;

function stripEmoji(text) {
  if (!text) return text;
  return text.replace(EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/* ===== Comment fetching ===== */

/**
 * Fetch comments for a given media ID using the authenticated Playwright
 * browser session. Reuses the proven approach from comment_test.js.
 *
 * @param {import('playwright').APIRequestContext} apiContext - page.request
 * @param {Array} cookies - Array of cookie objects from context.cookies()
 * @param {string} mediaId - Numeric Instagram media ID
 * @returns {Promise<Array<string>>} Array of comment texts
 */
async function fetchComments(apiContext, cookies, mediaId) {
  if (!apiContext || !mediaId) return [];

  const csrf = (cookies || []).find(c => c.name === "csrftoken")?.value || "";

  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-ig-app-id": "936619743392459",
    "x-csrftoken": csrf,
    "x-requested-with": "XMLHttpRequest",
    referer: "https://www.instagram.com/",
    origin: "https://www.instagram.com",
  };

  const baseUrl = `https://www.instagram.com/api/v1/media/${mediaId}/comments/`;

  // ADDED (this pass): paginate with next_max_id until we hit MIN_COMMENTS,
  // run out of pages, or hit MAX_COMMENTS — instead of stopping after a
  // single page (which is what capped some fetches at far fewer than the
  // user's requested 45-minimum).
  let collected = [];
  let nextMaxId = null;
  let page = 0;
  const MAX_PAGES = 6; // safety cap so a broken cursor can't loop forever

  while (collected.length < CONFIG.MIN_COMMENTS && page < MAX_PAGES) {
    const url = nextMaxId ? `${baseUrl}?max_id=${encodeURIComponent(nextMaxId)}` : baseUrl;

    let body;
    try {
      const response = await apiContext.get(url, {
        headers,
        timeout: CONFIG.COMMENTS_API_TIMEOUT_MS,
      });
      if (!response.ok()) break;

      const text = await response.text();
      body = JSON.parse(
        text.replace(/^for\s*\(\s*;;\s*\)\s*;?/, "").replace(/^\)\]\}'\s*/, "")
      );
    } catch (e) {
      break;
    }

    if (!body || !body.comments || !Array.isArray(body.comments)) break;

    const pageComments = body.comments
      .map(c => stripEmoji((c.text || "").trim())) // CHANGED (this pass): strip emoji per request
      .filter(Boolean);
    collected.push(...pageComments);

    const hasMore = body.has_more_comments && body.next_max_id;
    if (!hasMore) break;
    nextMaxId = body.next_max_id;
    page++;
  }

  return collected.slice(0, CONFIG.MAX_COMMENTS);
}

/* ===== Deterministic comment analysis (no LLM guessing) =====
 * FIX (this pass): the LLM was being asked to both DETECT language and
 * DETECT locations from the comments AND freely guess audio origin from
 * the title/creator name/"general knowledge." That produced confident
 * nonsense — e.g. a generic/nonsense title pattern-matched to "Kerala",
 * and a location ("Portugal") that appeared nowhere in the actual
 * comments. These functions compute language mix and location mentions
 * directly from the fetched comment text (Unicode script ranges + a
 * fixed keyword list), so the LLM is given verified facts instead of
 * being asked to invent them.
 */

// Unicode script ranges for languages relevant to this classifier.
const SCRIPT_RANGES = {
  Malayalam: [[0x0D00, 0x0D7F]],
  Tamil: [[0x0B80, 0x0BFF]],
  Telugu: [[0x0C00, 0x0C7F]],
  Kannada: [[0x0C80, 0x0CFF]],
  Hindi: [[0x0900, 0x097F]], // Devanagari (Hindi/Marathi share this script)
};

function scriptOfChar(codePoint) {
  for (const [lang, ranges] of Object.entries(SCRIPT_RANGES)) {
    for (const [start, end] of ranges) {
      if (codePoint >= start && codePoint <= end) return lang;
    }
  }
  if ((codePoint >= 0x41 && codePoint <= 0x5A) || (codePoint >= 0x61 && codePoint <= 0x7A)) {
    return "English";
  }
  return null; // digits, punctuation, emoji, whitespace — not a language signal
}

/**
 * Detect the language mix of a set of comments by counting characters
 * per script. Returns per-language counts, the majority language, and
 * what fraction of language-bearing comments it represents.
 */
function detectCommentLanguages(comments) {
  const charCounts = {};
  for (const comment of comments) {
    for (const ch of comment) {
      const lang = scriptOfChar(ch.codePointAt(0));
      if (!lang) continue;
      charCounts[lang] = (charCounts[lang] || 0) + 1;
    }
  }

  const total = Object.values(charCounts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { charCounts: {}, primaryLanguage: null, primaryLanguageShare: 0 };
  }

  let primaryLanguage = null;
  let max = 0;
  for (const [lang, count] of Object.entries(charCounts)) {
    if (count > max) { max = count; primaryLanguage = lang; }
  }

  return {
    charCounts,
    primaryLanguage,
    primaryLanguageShare: Math.round((max / total) * 100) / 100,
  };
}

// Known place names, grouped by region. Matching is verbatim (word-boundary,
// case-insensitive) against the actual comment text — nothing here is
// inferred from language or username.
const LOCATION_KEYWORDS = {
  Kerala: ["kerala", "kochi", "cochin", "thiruvananthapuram", "trivandrum", "kozhikode", "calicut",
    "kannur", "thrissur", "kollam", "palakkad", "malappuram", "kottayam", "alappuzha", "alleppey",
    "idukki", "wayanad", "pathanamthitta", "kasaragod", "ernakulam"],
  "Tamil Nadu": ["tamil nadu", "tamilnadu", "chennai", "coimbatore", "madurai", "trichy",
    "tiruchirappalli", "salem", "erode", "vellore", "tirunelveli"],
  Karnataka: ["karnataka", "bangalore", "bengaluru", "mysore", "mysuru", "mangalore", "hubli"],
  "Andhra/Telangana": ["telangana", "andhra pradesh", "hyderabad", "vijayawada", "visakhapatnam",
    "vizag", "warangal"],
  "Rest of India": ["mumbai", "delhi", "pune", "kolkata", "bengal", "punjab", "gujarat",
    "rajasthan", "maharashtra", "bihar", "up", "uttar pradesh", "goa", "india"],
  Gulf: ["dubai", "uae", "saudi", "qatar", "kuwait", "oman", "bahrain", "gulf"],
};

/**
 * Extract only the location names that literally appear (as whole words)
 * in the comment text. Returns { region -> [matched keyword, ...] }.
 * This is the ONLY source of truth for audienceDetectedLocations — the
 * LLM is instructed not to add anything beyond this list.
 */
function extractExplicitLocations(comments) {
  const joined = comments.join(" \n ").toLowerCase();
  const found = new Set();

  for (const keywords of Object.values(LOCATION_KEYWORDS)) {
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (pattern.test(joined)) found.add(kw);
    }
  }

  return [...found];
}

/* ===== Groq AI Analysis ===== */

function buildAnalysisPrompt(row, comments, mediaIdSource) {
  const title = row.title || "Unknown";
  const creator = row.firstSeenCreator || "Unknown";
  const shazam = row.shazamRecognition || {};

  // ADDED (this pass): when the media ID came from the replay fallback
  // (firstSeenPost was missing/unparseable), the fetched comments belong
  // to SOME other reel currently using this audio, not the reel where the
  // audio was originally discovered. That reel may have a different
  // audience/geography than the one this row is nominally about, so the
  // model needs to weight comment-derived evidence accordingly instead of
  // treating it as equivalent to a direct match.
  const mediaIdCaveat =
    mediaIdSource === "replay_fallback"
      ? "\nIMPORTANT: These comments were fetched from a DIFFERENT reel than the one where this audio was first discovered (the original post's URL was unavailable, so a fallback reel currently using the same audio was used instead). Treat comment-derived location/language evidence as weaker/less certain than usual for this reason, and do not assume this audience matches the original discovery reel's audience.\n"
      : "";

  const shazamSection =
    shazam.status === "recognized"
      ? `
Shazam Result (VERIFIED — audio was matched against a real recognition database):
  Artist: ${shazam.artist || "N/A"}
  Song: ${shazam.title || "N/A"}
  ISRC: ${shazam.isrc || "N/A"}
`
      : "Shazam Result: Not available (audio was NOT identified — no verified artist/song is known).";

  const commentsText =
    comments.length > 0
      ? comments.join("\n")
      : "No comments available";

  const langInfo = detectCommentLanguages(comments);
  const locations = extractExplicitLocations(comments);

  // ADDED (this pass): Language Safety Filter.
  // If we are using a fallback reel and the detected language is NOT an Indian script
  // and NOT English, it's a strong signal of 'Regional Fallback Bias'.
  const indianScripts = Object.keys(SCRIPT_RANGES);
  const isIndianOrEnglish = langInfo.primaryLanguage === "English" || indianScripts.includes(langInfo.primaryLanguage);
  const isForeign = langInfo.primaryLanguage && !isIndianOrEnglish;
  
  let biasWarning = "";
  if (mediaIdSource === "replay_fallback" && isForeign) {
    biasWarning = `\n\n🚨 CRITICAL WARNING: REGIONAL FALLBACK BIAS DETECTED\n` +
                 `The detected primary language is ${langInfo.primaryLanguage}, which is NOT English or an Indian script. ` +
                 `Since this is a fallback reel, these comments almost certainly come from a random user in a foreign country ` +
                 `and do NOT represent the actual trend audience. \n` +
                 `ACTION: Ignore the comment language for classification. Report 'audiencePrimaryLanguage' as "Unknown (Bias Detected)" ` +
                 `and do NOT use this language to determine the audioOrigin.\n`;
  }

  const langSummary = langInfo.primaryLanguage
    ? `Detected script breakdown (computed from actual comment characters, NOT a guess): ${JSON.stringify(langInfo.charCounts)}. Majority script: ${langInfo.primaryLanguage} (${Math.round(langInfo.primaryLanguageShare * 100)}% of language-bearing characters).`
    : `No identifiable language script was detected in the ${comments.length} fetched comment(s) (too few comments, or comments contain only emoji/numbers/usernames).`;

  const locationSummary = locations.length > 0
    ? `Locations found verbatim in the comment text (keyword match, NOT inferred): ${locations.join(", ")}.`
    : `No location names were found verbatim in the comment text.`;

  return `You are analyzing an Instagram Reel audio trend using ONLY verified evidence. You must NEVER guess, speculate, or use "general knowledge" about what a title or creator name might suggest.

## Audio Information (may be unreliable — titles are often auto-generated or generic and are NOT evidence of origin by themselves)

Title: ${title}
Creator: ${creator}
${shazamSection}
${mediaIdCaveat}${biasWarning}

## Evidence computed directly from the fetched comments (ground truth — do not override these numbers)

${langSummary}
${locationSummary}

NOTE on the script breakdown above: it only counts native-script characters (Malayalam/Tamil/Telugu/Kannada/Devanagari script, or literal a-z). It is a STARTING SIGNAL, not a verdict — it cannot see romanized/transliterated regional language (e.g. Malayalam typed in English letters — "Manglish" — Tamil in English letters — "Tanglish" — Hindi in English letters — "Hinglish", etc.), so a comment written in Latin letters shows as "English" above even when it's actually Manglish/Tanglish/Hinglish. Read the raw comments yourself to check for this — real linguistic identification of real text, not a guess.

## Raw comments (for context/reasoning only — do not extract anything from here that isn't reflected in the computed evidence above)

${commentsText}

## Task: Classify this audio's origin and audience

### Step 1: Audio Origin

Rules, in priority order (Priority 1 = the audio itself; Priority 2 = the comment section):
1. [PRIORITY 1 — Audio] If the Shazam Result above is VERIFIED, use that real artist/song's actual origin.
2. [PRIORITY 1 — Audio, continued] If Shazam is NOT available: this is normal and expected for licensed/catalog audio (Shazam only ever runs on unlabeled Original Audio, never on IG's own music catalog) — it does NOT mean the song is unidentifiable. Use the title, artist/creator name, song language, and your own general knowledge, exactly like a knowledgeable listener would. Most real, specific song titles (not generic captions like "vibes" or "mood") ARE identifiable this way — use that knowledge confidently. Only skip this step if the title is genuinely too generic/vague to name a real song (e.g. no real title at all, or something clearly not a song name).
3. [PRIORITY 2 — Comment section] If Priority 1 truly gives nothing to go on, use the comment-section evidence above:
   a. First re-read the raw comments for romanized regional language (Manglish/Tanglish/Kanglish/Hinglish/etc, see NOTE above) — if a clear majority of the substantive (non-generic, non-emoji-only) comments are romanized in one specific Indian language, treat that language as the majority language, overriding the "English" script-count above. Cite the specific words (e.g. "ippo", "ente" = Malayalam).
   b. Otherwise use the detected majority comment language from the computed script breakdown above.
   c. A location keyword found in the comments (e.g. "kerala") is CONTEXT ONLY, never proof by itself — only let it raise your confidence when it AGREES with the majority language from (a) or (b); never use a location keyword alone, with no language majority, to assign an origin.
   d. If there is no language majority at all and no comments were even retrieved, origin is "Unknown" — but this should be rare, since Priority 1 alone is usually enough for a real song title.
4. NEVER invent an origin from a title that has no real identifiable song/artist behind it, and never invent a location the comments don't contain. But DO use real, genuine knowledge of an actual identifiable song/artist — that's research, not guessing, and it's the normal, expected path for most audios here.

Possible origins: Kerala, Tamil Nadu, Karnataka, Andhra/Telangana, Rest of India, Outside India (Global), Unknown.

### Step 2: Audience

For audiencePrimaryLanguage: start from the computed script breakdown above, but if you identified a romanized regional language per Step 1(3a), report that instead (e.g. "Malayalam (romanized)") — cite the specific words that convinced you in the "reason" field. If neither the script breakdown nor romanized-text reading found anything, output "Unknown".

For locations, output ONLY locations from this exact list (copy verbatim, do not add, rename, or infer any other location): [${locations.map(l => `"${l}"`).join(", ") || "none found"}]. If the list is empty, output an empty array — do not invent a location.

### Step 3: Final Classification

- If audioOrigin is "Unknown" → trendClassification is "Unknown" (do not force a classification without a known origin).
- If audio origin is OUTSIDE INDIA → "Global Trending"
- If audio origin is KERALA and audience is mostly Malayalam → "Kerala Trending"
- If audio origin is TAMIL NADU and audience is mostly Malayalam → "Trending in Kerala"
- If audio origin is REST OF INDIA → "India Trending"

### Output Format

CRITICAL: Your entire response must be a single JSON object and NOTHING else. Do not include any explanation, preamble, commentary, or markdown code fences before or after the JSON. Do not write things like "Here is the analysis:" — output ONLY the JSON object itself. The very first character of your response MUST be "{" and the very last character MUST be "}".

{
  "audioOrigin": "Kerala|Tamil Nadu|Karnataka|Andhra/Telangana|Rest of India|Outside India (Global)|Unknown",
  "trendClassification": "Kerala Trending|Trending in Kerala|India Trending|Global Trending|Unknown",
  "audiencePrimaryLanguage": "${langInfo.primaryLanguage || "Unknown"}",
  "locations": [${locations.map(l => `"${l}"`).join(", ")}],
  "reason": "Cite the SPECIFIC evidence used (the real artist/song and what you know about it, or the computed language %, or a specific matched location keyword). If you output Unknown, say what evidence was missing.",
  "confidence": "A number between 0 and 1 representing how confident you are in this classification, based on the strength of the evidence above."
}`;
}

/**
 * Parse the raw LLM response text into the analysis fields.
 *
 * CHANGED (this pass): no longer prints anything itself — printing is the
 * caller's responsibility so it can be gated behind CONFIG.DEBUG. Returns
 * { result, raw, parseError } so the raw text and any parse failure detail
 * can still be captured for the debug data file even when nothing is
 * printed to the console.
 */
function parseAIResponse(text) {
  if (!text) return { result: null, raw: text ?? null, parseError: "empty response" };

  const trimmed = text.trim();

  // Only attempt JSON parsing when the response actually looks like JSON.
  // No regex is used to locate/extract JSON from the text — if the model
  // wrapped it in markdown fences or added explanatory text, this is
  // treated as a parse failure rather than something to strip out.
  if (!trimmed.startsWith("{")) {
    return { result: null, raw: trimmed, parseError: "response did not start with '{'" };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const result = {
      audioOrigin: parsed.audioOrigin || "Unknown",
      trendClassification: parsed.trendClassification || "Unknown",
      audiencePrimaryLanguage: parsed.audiencePrimaryLanguage || "Unknown",
      audienceDetectedLocations: Array.isArray(parsed.locations) ? parsed.locations : [],
      reason: parsed.reason || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    };
    return { result, raw: trimmed, parseError: null };
  } catch (e) {
    return { result: null, raw: trimmed, parseError: e.message };
  }
}

/**
 * FIX (this pass): defense-in-depth — even though the prompt now hands the
 * model a fixed, pre-computed location list and tells it not to add to it,
 * LLMs can still ignore instructions. This strips out any location the
 * model reported (under the "locations" key in its JSON response) that
 * isn't actually in the deterministic list computed from the real comment
 * text, so a hallucinated location can never survive into the saved report.
 */
function sanitizeAnalysisResult(result, allowedLocations) {
  if (!result) return result;
  const allowedLower = new Set(allowedLocations.map(l => l.toLowerCase()));
  result.audienceDetectedLocations = (result.audienceDetectedLocations || [])
    .filter(loc => typeof loc === "string" && allowedLower.has(loc.toLowerCase()));

  // ADDED (this pass): a non-compliant model response could otherwise say
  // audioOrigin: "Unknown" while still returning a real trendClassification
  // (or vice versa) — enforce the prompt's own Step 3 rule in code instead
  // of only asking for it in the prompt.
  if (result.audioOrigin === "Unknown") {
    result.trendClassification = "Unknown";
  }

  return result;
}

async function analyzeWithAI(row, comments, mediaIdSource) {
  const client = getGroqClient();
  if (!client) return { result: null, debug: null };

  const prompt = buildAnalysisPrompt(row, comments, mediaIdSource);
  const allowedLocations = extractExplicitLocations(comments);

  const requestBody = {
    model: CONFIG.GROQ_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a knowledgeable music/trend analyst. For any real, identifiable song or artist, use your genuine knowledge of that song/artist to determine its origin — this is normal, expected research, not guessing. Only fall back to comment-based evidence (verified language percentages, romanized regional words you can quote, or a location keyword literally present in the comments) when the title/artist truly isn't identifiable. Say 'Unknown' only when neither the audio itself nor the comments give you anything real to go on. Respond only with valid JSON.",
      },
      { role: "user", content: prompt },
    ],
    temperature: CONFIG.GROQ_TEMPERATURE,
    max_tokens: CONFIG.GROQ_MAX_TOKENS,
  };

  if (CONFIG.DEBUG) {
    console.log(`      📜 Prompt:\n${prompt}`);
    console.log(`      📦 HTTP body: ${JSON.stringify(requestBody)}`);
  }

  try {
    const completion = await client.chat.completions.create(requestBody);

    if (CONFIG.DEBUG && completion.usage) {
      console.log(
        `      🔢 Token usage: prompt=${completion.usage.prompt_tokens ?? "N/A"}, ` +
        `completion=${completion.usage.completion_tokens ?? "N/A"}, total=${completion.usage.total_tokens ?? "N/A"}`
      );
    }

    const reply = completion.choices?.[0]?.message?.content;
    if (!reply) {
      console.log(`      ❌ AI returned an empty response.\n         Audio skipped.`);
      return { result: null, debug: { rawResponse: null, tokenUsage: completion.usage || null } };
    }

    const { result: parsed, raw, parseError } = parseAIResponse(reply);

    if (CONFIG.DEBUG) {
      console.log(`      🧾 Raw AI response: ${reply}`);
    }

    if (parseError) {
      console.log(`      ❌ AI returned invalid JSON`);
      console.log(`         Audio skipped.`);
      if (CONFIG.DEBUG) {
        console.log(`      Parse error: ${parseError}`);
        console.log(`      Raw response: ${raw}`);
      }
      return { result: null, debug: { rawResponse: raw, parseError, tokenUsage: completion.usage || null } };
    }

    const sanitized = sanitizeAnalysisResult(parsed, allowedLocations);
    // ADDED (this pass): carry the caveat onto the result itself (not just
    // the console log / debug file) so anything downstream that reads
    // row.commentAnalysis directly — dashboards, exports, etc. — can also
    // tell that this classification was based on a different reel's
    // comments than the one the row nominally describes.
    sanitized.mediaIdSource = mediaIdSource || "firstSeenPost";
    return { result: sanitized, debug: { rawResponse: raw, tokenUsage: completion.usage || null } };
  } catch (e) {
    if (e.status === 429) {
      console.log(`      ⚠ AI rate limit reached.`);
      console.log(`         Analysis skipped for this audio.`);
    } else {
      console.log(`      ⚠️ AI request failed.`);
      console.log(`         Analysis skipped for this audio.`);
      if (CONFIG.DEBUG) {
        console.log(`      Details: ${e.message}`);
      }
    }
    if (CONFIG.DEBUG && e.stack) {
      console.log(e.stack);
    }
    return { result: null, debug: { error: e.message, status: e.status || null } };
  }
}

/* ===== Candidate selection ===== */

/**
 * Select the top N candidates for comment analysis from the report.
 * Sorts by diffusion score descending, takes top N.
 */
function selectCandidates(report) {
  if (!report || report.length === 0) return [];

  // Filter to rows that have a diffusion score
  const scored = report.filter(
    (r) => r.diffusion && typeof r.diffusion.diffusionScore === "number"
  );

  // Sort by diffusion score descending
  const sorted = [...scored].sort(
    (a, b) => (b.diffusion.diffusionScore || 0) - (a.diffusion.diffusionScore || 0)
  );

  // Take top N
  const candidates = sorted.slice(0, CONFIG.TOP_N_BY_DIFFUSION);

  // If we have fewer than TOP_N, also include top by predictive score
  if (candidates.length < CONFIG.TOP_N_BY_DIFFUSION) {
    const existingIds = new Set(candidates.map((r) => r.id));
    const byPredictive = [...report]
      .filter((r) => !existingIds.has(r.id))
      .sort((a, b) => (b.predictiveScore || 0) - (a.predictiveScore || 0));

    const fillers = byPredictive.slice(0, CONFIG.TOP_N_BY_DIFFUSION - candidates.length);
    candidates.push(...fillers);
  }

  return candidates;
}

/* ===== Main entry point ===== */

/**
 * runCommentAnalysis(report, page, context)
 *
 * Called from scrape.js's run() function AFTER the prediction and
 * diffusion reports are generated.
 *
 * @param {Array} report - The full predictive report (mutated in place)
 * @param {import('playwright').Page} page - The authenticated Playwright page
 * @param {import('playwright').BrowserContext} context - The browser context
 * @param {object} [captured] - FIX (this pass, OPTIONAL/additive): the
 *   Phase 2 captured request template. When provided, enables a replay
 *   fallback for candidates whose firstSeenPost is missing (see
 *   getMediaIdForRow). Omitting it reproduces the old firstSeenPost-only
 *   behavior exactly.
 * @returns {Promise<number>} Number of successfully analyzed audios
 */
async function runCommentAnalysis(report, page, context, captured) {
  if (!report || report.length === 0) {
    console.log("\n   📝 Comment analysis: No report data available");
    return 0;
  }

  const client = getGroqClient();
  if (!client) {
    console.log("\n   📝 Comment analysis: Skipped (GROQ_API_KEY not configured)");
    return 0;
  }

  console.log("\n" + "=".repeat(60));
  console.log("📝 PHASE 5: COMMENT ANALYSIS (AI trend classification)");
  console.log("   Selecting top candidates from the prediction engine");
  console.log("=".repeat(60));

  const candidates = selectCandidates(report);
  console.log(`   Candidates selected: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log("   ⚠️ No candidates qualified for comment analysis");
    return 0;
  }

  let cookies = [];
  try {
    cookies = await context.cookies();
  } catch (e) {
    console.log(`   ⚠️ Could not get cookies: ${e.message}`);
  }

  let analyzed = 0;
  const candidateDebugLog = [];
  const trendCounts = {
    "Kerala Trending": 0,
    "Trending in Kerala": 0,
    "India Trending": 0,
    "Global Trending": 0,
    "Unknown": 0,
  };
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const title = (row.title || "Unknown").slice(0, 50);
    console.log(`\n   [${i + 1}/${candidates.length}] "${title}"`);

    // FIX (this pass): fall back to replaying this audio's captured
    // request when firstSeenPost is missing, instead of giving up.
    const { mediaId, source } = await getMediaIdForRow(row, page.request, captured);
    if (!mediaId) {
      console.log(`      ⚠️ Could not determine media ID from report data`);
      continue;
    }
    // CHANGED (this pass): surface how the media ID was resolved — a
    // "replay_fallback" reel is NOT guaranteed to be the exact reel the
    // audio was first discovered on, just some other reel currently using
    // the same audio, so its comments may look unfamiliar even though they
    // are genuinely fetched.
    const sourceLabel = source === "replay_fallback" ? "replay fallback — different reel, same audio" : "original post";
    console.log(`      📍 Media ID: ${mediaId} (source: ${sourceLabel})`);

    // Fetch comments
    let comments = [];
    try {
      comments = await fetchComments(page.request, cookies, mediaId);
      console.log(`      💬 Fetched ${comments.length} comments`);
      // FIX (this pass): print a sample so fetching correctness can be
      // visually verified in the console instead of just trusting the count
      // (a wrong media ID or endpoint shape could return 0 or garbage
      // comments while still "succeeding").
      if (comments.length > 0) {
        console.log(`         e.g. "${comments[0].slice(0, 80)}"`);
      }
    } catch (e) {
      console.log(`      ❌ Failed to fetch comments: ${e.message.slice(0, 100)}`);
    }

    if (comments.length === 0) {
      console.log(`      Comments`);
      console.log(`      --------`);
      console.log(`      No comments available.`);
      console.log(`      Classification based on audio metadata only.`);
    }

    // Send to Groq
    let analysisResult = null;
    let analysisDebug = null;
    try {
      const outcome = await analyzeWithAI(row, comments, source);
      analysisResult = outcome.result;
      analysisDebug = outcome.debug;
    } catch (e) {
      console.log(`      ⚠️ AI request failed.`);
      console.log(`         Analysis skipped for this audio.`);
      if (CONFIG.DEBUG) {
        console.log(`      Details: ${e.message}`);
        if (e.stack) console.log(e.stack);
      }
      analysisDebug = { error: e.message, status: e.status || null };
    }

    // ADDED (this pass): record full per-candidate data (including the raw
    // AI response, token usage, and any parse/error detail) regardless of
    // whether the console is showing it — this is what gets written to
    // CONFIG.COMMENT_ANALYSIS_FILE for debugging/future development.
    candidateDebugLog.push({
      id: row.id,
      title: row.title,
      mediaId,
      mediaIdSource: source,
      commentsFetched: comments.length,
      success: !!analysisResult,
      result: analysisResult,
      debug: analysisDebug,
    });

    if (analysisResult) {
      row.commentAnalysis = analysisResult;
      analyzed++;

      const trendKey = trendCounts.hasOwnProperty(analysisResult.trendClassification)
        ? analysisResult.trendClassification
        : "Unknown";
      trendCounts[trendKey]++;
      if (typeof analysisResult.confidence === "number") {
        confidenceSum += analysisResult.confidence;
        confidenceCount++;
      }

      console.log(`      🏷️  Origin: ${analysisResult.audioOrigin || "N/A"}`);
      console.log(`      🏷️  Trend: ${analysisResult.trendClassification || "N/A"}`);
      console.log(`      🗣️  Language: ${analysisResult.audiencePrimaryLanguage || "N/A"}`);
      console.log(`      📍 Locations: ${(analysisResult.audienceDetectedLocations || []).join(", ") || "N/A"}`);
      console.log(`      🎯 Confidence: ${analysisResult.confidence ?? "N/A"}`);
      console.log(`      💡 ${(analysisResult.reason || "").slice(0, 120)}...`);
    } else {
      console.log(`      ⚠️ Could not complete AI analysis`);
    }
  }

  // Save comment analysis results — CHANGED (this pass): now includes the
  // complete per-candidate data (raw AI response, token usage, parse/error
  // detail) for every attempted candidate, not just the successful ones
  // pulled off `report`, so failures can be inspected/debugged later even
  // though the console output above stays clean.
  const resultsForFile = candidateDebugLog.map((entry) => {
    const row = candidates.find((r) => r.id === entry.id);
    return {
      id: entry.id,
      title: entry.title,
      predictiveScore: row?.predictiveScore ?? null,
      productionScore: row?.productionScore ?? null,
      diffusionScore: row?.diffusion?.diffusionScore || null,
      mediaId: entry.mediaId,
      mediaIdSource: entry.mediaIdSource,
      commentsFetched: entry.commentsFetched,
      success: entry.success,
      commentAnalysis: entry.result,
      debug: entry.debug,
    };
  });

  try {
    const fs = require("fs");
    fs.writeFileSync(CONFIG.COMMENT_ANALYSIS_FILE, JSON.stringify(resultsForFile, null, 2));
    console.log(`\n   📄 Comment analysis saved to ${CONFIG.COMMENT_ANALYSIS_FILE}`);
  } catch (e) {
    console.log(`   ⚠️ Could not save analysis file: ${e.message}`);
  }

  // ADDED (this pass): clean end-of-phase dashboard summarizing the run,
  // replacing the single "X/Y analyzed" line.
  const failed = candidates.length - analyzed;
  const avgConfidencePct = confidenceCount > 0
    ? Math.round((confidenceSum / confidenceCount) * 100)
    : null;

  console.log("\n" + "═".repeat(59));
  console.log("AI TREND SUMMARY");
  console.log("═".repeat(59) + "\n");
  console.log(`Analyzed               : ${candidates.length}`);
  console.log(`Successful             : ${analyzed}`);
  console.log(`Failed                 : ${failed}\n`);
  console.log(`Kerala Trending        : ${trendCounts["Kerala Trending"]}`);
  console.log(`Trending in Kerala     : ${trendCounts["Trending in Kerala"]}`);
  console.log(`India Trending         : ${trendCounts["India Trending"]}`);
  console.log(`Global Trending        : ${trendCounts["Global Trending"]}`);
  console.log(`Unknown                : ${trendCounts["Unknown"]}\n`);
  console.log(`Average Confidence     : ${avgConfidencePct !== null ? avgConfidencePct + "%" : "N/A"}`);
  console.log("\n" + "═".repeat(59));

  return analyzed;
}

// ================================================================
// EXPORTS — ADDED fetchComments to fix the AI Research phase
// ================================================================
module.exports = {
  runCommentAnalysis,
  getMediaIdFromReportRow,
  getMediaIdForRow,
  fetchComments,
};