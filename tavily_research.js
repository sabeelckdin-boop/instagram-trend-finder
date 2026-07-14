/**
 * tavily_research.js — Tavily-based audio research module.
 *
 * STANDALONE / ADDITIVE — NOT wired into gittest.js, replay_utils.js,
 * shazam_recognition.js, or comment_analysis.js. Nothing in this pass
 * modifies discovery, replay, growth calculation, reporting, prediction
 * scoring, or comment analysis. This module is only importable/callable
 * on its own; integrating it into the main pipeline is a separate task.
 *
 * Purpose: given an audio title (and artist, if already known — e.g. from
 * Shazam recognition), research four factual fields via Tavily web search:
 *   - artist
 *   - song language
 *   - origin state
 *   - origin country
 *
 * Explicitly OUT OF SCOPE for this module (by design):
 *   - No trend classification (that's comment_analysis.js + Groq).
 *   - No comment inspection of any kind.
 *   - No Groq / LLM calls — Tavily only.
 *   - No writes to any existing DB file (audio_growth_db.json,
 *     audio_recognition_db.json, etc).
 *
 * Auth: reads TAVILY_API_KEY from process.env (loaded via dotenv from
 * .env, same mechanism gittest.js already uses for GROQ_API_KEY). If the
 * key is missing, every research call fails gracefully — returns nulls
 * with an explanatory error, never throws.
 */

require("dotenv").config();

/* ===== Config ===== */
const TAVILY_API_URL = "https://api.tavily.com/search";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_QUERY = 3;

/* ===== Low-level Tavily call =====
 * One focused search + Tavily's synthesized "answer" per field, so each
 * field is resolved independently and a failure/ambiguity in one never
 * affects the others.
 */
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) {
    return { ok: false, error: "TAVILY_API_KEY not set in environment (.env)", answer: null, sources: [] };
  }
  if (!query || typeof query !== "string" || !query.trim()) {
    return { ok: false, error: "Empty query", answer: null, sources: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: MAX_RESULTS_PER_QUERY,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: `Tavily HTTP ${response.status}: ${text.slice(0, 200)}`,
        answer: null,
        sources: [],
      };
    }

    const data = await response.json();

    const sources = Array.isArray(data.results)
      ? data.results.map(r => ({ title: r.title || null, url: r.url || null })).filter(s => s.url)
      : [];

    // Prefer Tavily's synthesized answer; fall back to the first result's
    // content snippet if include_answer didn't produce one.
    let answer = typeof data.answer === "string" && data.answer.trim() ? data.answer.trim() : null;
    if (!answer && Array.isArray(data.results) && data.results.length > 0) {
      const firstContent = data.results[0].content;
      if (typeof firstContent === "string" && firstContent.trim()) {
        answer = firstContent.trim().slice(0, 300);
      }
    }

    return { ok: true, error: null, answer, sources };
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    return {
      ok: false,
      error: isTimeout ? `Tavily request timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message,
      answer: null,
      sources: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ===== Query builders =====
 * Kept separate per field (rather than one combined query) so each field
 * gets a focused Tavily answer instead of one noisy free-text blob that
 * would then need fragile parsing to split back into 4 fields.
 */
function buildSubjectPhrase(title, artist) {
  return artist ? `the song "${title}" by ${artist}` : `the song "${title}"`;
}

function buildQueries(title, artist) {
  const subject = buildSubjectPhrase(title, artist);
  return {
    artist: `Who is the artist / singer of ${subject}?`,
    songLanguage: `What language is ${subject} sung in?`,
    originState: `What Indian state (or region) does ${subject} originate from?`,
    originCountry: `What country does ${subject} originate from?`,
  };
}

/* ===== Public API ===== */

/**
 * researchAudio({ title, artist })
 *
 * @param {object} params
 * @param {string} params.title - Audio/song title (required)
 * @param {string} [params.artist] - Artist name, if already known (e.g.
 *   from Shazam recognition). When provided, the artist field is still
 *   independently confirmed via Tavily rather than just echoed back, but
 *   queries for the other three fields use it to disambiguate the subject.
 * @returns {Promise<object>} Clean research object — see shape below.
 *
 * Return shape:
 * {
 *   input: { title, artist },
 *   artist: string|null,
 *   songLanguage: string|null,
 *   originState: string|null,
 *   originCountry: string|null,
 *   sources: { artist: [{title,url}], songLanguage: [...], originState: [...], originCountry: [...] },
 *   errors: { artist: string|null, songLanguage: string|null, originState: string|null, originCountry: string|null },
 *   success: boolean,   // true if at least one field was resolved
 *   fetchedAt: string,  // ISO timestamp
 * }
 */
/* =====================================================================
 * FIX (bug): Tavily's include_answer returns a full generated sentence
 * (e.g. `The song "X" by Y originates from Tamil Nadu, India.`), not a
 * short value. trend_region_classifier.js does an EXACT match against
 * known state/country names (normOrigin === "tamil nadu"), so a raw
 * sentence never matched anything — every candidate silently fell through
 * to "Global Trending" regardless of its real origin, no matter how
 * clearly the state/country was stated in the sentence. These two
 * extractors scan the raw answer for a known Indian state name or
 * country name and return a short, clean value the classifier can
 * actually match — falling back to the raw sentence only if nothing
 * recognizable was found (better than nothing, but should be rare).
 * ===================================================================== */
const INDIAN_STATE_NAMES = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh",
  "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand",
  "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram",
  "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu",
  "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "andaman and nicobar islands", "chandigarh",
  "dadra and nagar haveli and daman and diu", "delhi", "jammu and kashmir",
  "ladakh", "lakshadweep", "puducherry", "karnataka", "kerala",
];

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

/** Scans free text for a known Indian state/UT name, longest match first
 * (so e.g. "Uttar Pradesh" isn't accidentally shadowed by a shorter
 * unrelated substring). Returns a clean, title-cased value or null. */
function extractIndianState(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const sorted = [...INDIAN_STATE_NAMES].sort((a, b) => b.length - a.length);
  for (const state of sorted) {
    if (lower.includes(state)) return titleCase(state);
  }
  return null;
}

// Common country name/abbreviation hints, longest key first at lookup time.
const COUNTRY_HINTS = {
  "india": "India",
  "united states": "United States", "usa": "United States", "u.s.a": "United States",
  "united kingdom": "United Kingdom", "uk": "United Kingdom", "england": "United Kingdom",
  "scotland": "United Kingdom", "wales": "United Kingdom",
  "france": "France", "germany": "Germany", "canada": "Canada", "australia": "Australia",
  "japan": "Japan", "south korea": "South Korea", "korea": "South Korea",
  "nigeria": "Nigeria", "brazil": "Brazil", "mexico": "Mexico", "spain": "Spain",
  "italy": "Italy", "netherlands": "Netherlands", "sweden": "Sweden", "norway": "Norway",
  "ireland": "Ireland", "china": "China", "pakistan": "Pakistan", "bangladesh": "Bangladesh",
  "sri lanka": "Sri Lanka", "philippines": "Philippines", "indonesia": "Indonesia",
};

/** Scans free text for a known country name/abbreviation, longest key
 * first. Returns a clean value or null. */
function extractCountry(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const sortedKeys = Object.keys(COUNTRY_HINTS).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (lower.includes(key)) return COUNTRY_HINTS[key];
  }
  return null;
}

async function researchAudio({ title, artist } = {}) {
  const fetchedAt = new Date().toISOString();

  if (!title || typeof title !== "string" || !title.trim()) {
    return {
      input: { title: title || null, artist: artist || null },
      artist: null,
      songLanguage: null,
      originState: null,
      originCountry: null,
      researchEvidence: [],
      sources: { artist: [], songLanguage: [], originState: [], originCountry: [] },
      errors: {
        artist: "No title provided — cannot research",
        songLanguage: "No title provided — cannot research",
        originState: "No title provided — cannot research",
        originCountry: "No title provided — cannot research",
      },
      success: false,
      fetchedAt,
    };
  }

  const cleanTitle = title.trim();
  const cleanArtist = artist && typeof artist === "string" && artist.trim() ? artist.trim() : null;

  const queries = buildQueries(cleanTitle, cleanArtist);

  // Each field is researched independently and in parallel; one field's
  // failure never blocks or corrupts the others (Promise.allSettled-style
  // handling via individual try/catch inside tavilySearch already, plus
  // allSettled here as a second layer of isolation).
  const fieldNames = ["artist", "songLanguage", "originState", "originCountry"];
  const settled = await Promise.allSettled(fieldNames.map(name => tavilySearch(queries[name])));

  const result = {
    input: { title: cleanTitle, artist: cleanArtist },
    artist: null,
    songLanguage: null,
    originState: null,
    originCountry: null,
    researchEvidence: [],
    sources: { artist: [], songLanguage: [], originState: [], originCountry: [] },
    errors: { artist: null, songLanguage: null, originState: null, originCountry: null },
    success: false,
    fetchedAt,
  };

  fieldNames.forEach((name, i) => {
    const outcome = settled[i];

    if (outcome.status !== "fulfilled") {
      result.errors[name] = outcome.reason?.message || "Unknown error";
      return;
    }

    const { ok, error, answer, sources } = outcome.value;
    result.sources[name] = sources;

    if (!ok) {
      result.errors[name] = error;
      return;
    }

    if (name === "originState") {
      const cleanState = extractIndianState(answer) || answer;
      result[name] = cleanState;
      result.researchEvidence.push(`Audio origin: ${cleanState}`);
    } else if (name === "originCountry") {
      const cleanCountry = extractCountry(answer) || answer;
      result[name] = cleanCountry;
      result.researchEvidence.push(`Audio country: ${cleanCountry}`);
    } else if (name === "songLanguage") {
      result[name] = answer;
      result.researchEvidence.push(`Song language: ${answer}`);
    } else if (name === "artist") {
      result[name] = answer;
    }
  });

  result.success = fieldNames.some(name => result[name] !== null);

  return result;
}

module.exports = { researchAudio, tavilySearch };

/* ===== Self-test / manual verification =====
 * Run directly to verify the Tavily integration works end-to-end:
 *   node tavily_research.js "Song Title" ["Artist Name"]
 * Does not run when required as a module from elsewhere.
 */
if (require.main === module) {
  const [, , cliTitle, cliArtist] = process.argv;

  if (!cliTitle) {
    console.log('Usage: node tavily_research.js "Song Title" ["Artist Name"]');
    process.exit(1);
  }

  if (!TAVILY_API_KEY) {
    console.log("⚠️  TAVILY_API_KEY not found in .env — set it before running this test.");
    process.exit(1);
  }

  (async () => {
    console.log(`🔎 Researching: "${cliTitle}"${cliArtist ? ` by ${cliArtist}` : ""}...\n`);
    const research = await researchAudio({ title: cliTitle, artist: cliArtist });
    console.log(JSON.stringify(research, null, 2));
  })();
}