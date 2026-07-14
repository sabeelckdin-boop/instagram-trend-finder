/**
 * groq_comment_language.js — Groq-based comment language detection.
 *
 * STANDALONE / ADDITIVE — does not modify prediction logic, discovery,
 * replay, growth calculation, reporting, diffusion scoring, or
 * comment_analysis.js's trend-classification behavior. This is a
 * SEPARATE, narrower Groq call with a single job: detect the language(s)
 * used in a set of already-fetched comments.
 *
 * Scope (intentionally narrow):
 *   - Groq ONLY analyzes the comment text it's given.
 *   - Groq NEVER searches the web — no tools/functions are passed to the
 *     API call, so there is nothing for the model to invoke; it can only
 *     respond with text based on the prompt.
 *   - Input: audio title, artist (if available), up to the first 30
 *     comments. Nothing else is sent.
 *   - Output: strict JSON only, no markdown, no explanations — enforced
 *     via response_format + a system prompt + a parser that rejects
 *     anything that isn't valid JSON.
 *
 * Caching: results are stored via audio_research_cache.js's
 * saveCommentLanguageToCache()/getCachedCommentLanguage(), under the same
 * audio_ai_cache.json entry Task 2/3 already use. Once an audioId has a
 * cached commentLanguage result, this module NEVER calls Groq for it
 * again — analyzeCommentLanguageWithCache() is cache-first.
 */

require("dotenv").config();

const Groq = require("groq-sdk");
const { getCachedCommentLanguage, saveCommentLanguageToCache } = require("./audio_research_cache");

/* ===== Config ===== */
const CONFIG = {
  GROQ_MODEL: "llama-3.3-70b-versatile",
  GROQ_TEMPERATURE: 0,
  GROQ_MAX_TOKENS: 300,
  MAX_COMMENTS: 30, // "Up to the first 30 comments" per spec
};

const EMPTY_COMMENTS_RESULT = Object.freeze({
  primaryLanguage: "Unknown",
  secondaryLanguage: "Unknown",
  commentSummary: "No comments",
  confidence: 0,
});

/* ===== Groq client (lazy init, separate instance from comment_analysis.js) ===== */
let _groqClient = null;

function getGroqClient() {
  if (_groqClient) return _groqClient;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("   ⚠️  GROQ_API_KEY not set — comment language detection will be skipped.");
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

/* ===== Prompt ===== */
function buildPrompt(title, artist, comments) {
  const subject = artist ? `"${title}" by ${artist}` : `"${title}"`;
  const commentBlock = comments.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `Analyze the language(s) used in the Instagram comments below, for the audio ${subject}.

Comments:
${commentBlock}

Respond with ONLY a JSON object in exactly this shape (no markdown, no code fences, no explanation, no text before or after the JSON):
{
  "primaryLanguage": string,
  "languageDistribution": {
    "LanguageName": number, // Percentage (0-100)
    "LanguageName2": number
  },
  "commentSummary": string (one short sentence),
  "confidence": number (0 to 1)
}

Rules:
- Base your answer ONLY on the comment text provided above. Do not use outside knowledge about the song, artist, or title to infer language.
- The "languageDistribution" should sum up to approximately 100%.
- If you cannot determine a language at all, use "Unknown" for primaryLanguage and confidence 0.`;
}

/* ===== Strict JSON parsing (no markdown, no explanations allowed) ===== */
function parseStrictJson(text) {
  if (!text || typeof text !== "string") return { result: null, error: "Empty response" };

  let clean = text.trim();
  // Defensive: strip code fences if the model adds them despite instructions.
  clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    return { result: null, error: `Invalid JSON: ${e.message}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { result: null, error: "Response was not a JSON object" };
  }

  const { primaryLanguage, languageDistribution, commentSummary, confidence } = parsed;

  if (
    typeof primaryLanguage !== "string" ||
    typeof languageDistribution !== "object" ||
    typeof commentSummary !== "string" ||
    typeof confidence !== "number"
  ) {
    return { result: null, error: "Response JSON missing/mistyped required fields" };
  }

  return {
    result: {
      primaryLanguage,
      languageDistribution,
      commentSummary,
      confidence: Math.max(0, Math.min(1, confidence)),
    },
    error: null,
  };
}

/* ===== Public API ===== */

/**
 * analyzeCommentLanguage({ title, artist, comments })
 *
 * Calls Groq to detect the language(s) used in the given comments.
 * NEVER searches the web — no tools are given to the model. Only ever
 * looks at the title/artist/comments it's passed.
 *
 * @param {object} params
 * @param {string} params.title - Audio title
 * @param {string} [params.artist] - Artist name, if available
 * @param {Array<string>} params.comments - Comment texts (only the first
 *   MAX_COMMENTS are sent)
 * @returns {Promise<object>} { primaryLanguage, secondaryLanguage, commentSummary, confidence }
 */
async function analyzeCommentLanguage({ title, artist, comments } = {}) {
  // Per spec: empty comments short-circuits with the fixed object below —
  // no Groq call is made at all. This is a legitimate, permanent result
  // (this audio genuinely has no comments to analyze), so it's cacheable.
  if (!comments || comments.length === 0) {
    return { ...EMPTY_COMMENTS_RESULT, _cacheable: true };
  }

  const client = getGroqClient();
  if (!client) {
    // FIX (this pass): missing API key is a transient/config issue, not a
    // fact about this audio — must NOT be cached, or this audio would be
    // permanently stuck reporting "Groq unavailable" even after
    // GROQ_API_KEY is set correctly on a later run.
    return {
      primaryLanguage: "Unknown",
      secondaryLanguage: "Unknown",
      commentSummary: "Groq unavailable (GROQ_API_KEY not set)",
      confidence: 0,
      _cacheable: false,
    };
  }

  const trimmedComments = comments.slice(0, CONFIG.MAX_COMMENTS).filter(Boolean);
  if (trimmedComments.length === 0) {
    return { ...EMPTY_COMMENTS_RESULT, _cacheable: true };
  }

  const prompt = buildPrompt(title || "Unknown", artist || null, trimmedComments);

  try {
    const completion = await client.chat.completions.create({
      model: CONFIG.GROQ_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a language-detection assistant. You analyze only the text given to you in the prompt. You have no tools, cannot browse the web, and must never use outside knowledge to answer. Respond with ONLY a raw JSON object — no markdown, no code fences, no explanation.",
        },
        { role: "user", content: prompt },
      ],
      temperature: CONFIG.GROQ_TEMPERATURE,
      max_tokens: CONFIG.GROQ_MAX_TOKENS,
      response_format: { type: "json_object" },
      // Deliberately no `tools` / `tool_choice` — Groq has nothing to call
      // out to, so it can only ever respond with generated text.
    });

    const reply = completion.choices?.[0]?.message?.content;
    if (!reply) {
      // FIX (this pass): an empty API response is a transient hiccup, not
      // a fact about this audio — not cacheable, so it's retried next run.
      return {
        primaryLanguage: "Unknown",
        secondaryLanguage: "Unknown",
        commentSummary: "Groq returned an empty response",
        confidence: 0,
        _cacheable: false,
      };
    }

    const { result, error } = parseStrictJson(reply);
    if (!result) {
      // FIX (this pass): a malformed response is also transient (the next
      // call may well come back clean) — not cacheable.
      return {
        primaryLanguage: "Unknown",
        secondaryLanguage: "Unknown",
        commentSummary: `Analysis failed (${error})`,
        confidence: 0,
        _cacheable: false,
      };
    }

    // A real, successfully parsed Groq result — this is the thing the
    // cache exists to store.
    return { ...result, _cacheable: true };
  } catch (e) {
    // FIX (this pass): network/API errors are transient — not cacheable.
    return {
      primaryLanguage: "Unknown",
      secondaryLanguage: "Unknown",
      commentSummary: `Groq request failed: ${e.message}`,
      confidence: 0,
      _cacheable: false,
    };
  }
}

/**
 * analyzeCommentLanguageWithCache({ audioId, title, artist, comments })
 *
 * Cache-first wrapper. If audioId already has a cached commentLanguage
 * result, returns it directly — Groq is NEVER called again for the same
 * audio. Otherwise runs analyzeCommentLanguage(), caches the result under
 * the same audio_ai_cache.json entry as the Tavily research (Task 2/3),
 * and returns it.
 *
 * @param {object} params
 * @param {string} params.audioId - Cache key (required)
 * @param {string} params.title
 * @param {string} [params.artist]
 * @param {Array<string>} params.comments
 * @returns {Promise<object>} { primaryLanguage, secondaryLanguage, commentSummary, confidence, fromCache }
 */
async function analyzeCommentLanguageWithCache({ audioId, title, artist, comments } = {}) {
  if (!audioId) {
    const { _cacheable, ...result } = await analyzeCommentLanguage({ title, artist, comments });
    return { ...result, fromCache: false };
  }

  const cached = getCachedCommentLanguage(audioId);
  if (cached) {
    return { ...cached.commentLanguage, fromCache: true };
  }

  const { _cacheable, ...result } = await analyzeCommentLanguage({ title, artist, comments });

  // FIX (this pass): only persist genuinely cacheable outcomes (a real
  // Groq analysis, or the legitimate "no comments" short-circuit) — a
  // transient failure (missing key, network error, malformed response)
  // must NOT be cached, or this audioId would be permanently stuck
  // reporting that failure and "Groq never runs again for the same audio"
  // would wrongly apply to a call that never actually succeeded.
  if (_cacheable) {
    saveCommentLanguageToCache(audioId, result);
  }

  return { ...result, fromCache: false };
}

module.exports = {
  analyzeCommentLanguage,
  analyzeCommentLanguageWithCache,
};