/**
 * youtube_search.js — yt-dlp based YouTube search, replacing Spotify search.
 *
 * STANDALONE / ADDITIVE — does not modify any existing scraper logic, AI
 * analysis (Tavily/Groq/trend classification), Telegram code, prediction
 * engine, or download logic. This module only replaces the Spotify
 * search step that spotify_search.js used to perform — it does NOT
 * download anything (see youtube_downloader.js, a separate task).
 *
 * Removes the Spotify Client Credentials Flow entirely — no
 * SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / access-token logic here.
 *
 * Requires the `yt-dlp` Python package installed via pip (e.g., pip install yt-dlp).
 * The Python interpreter (python or python3) must be on PATH.
 *
 * Workflow:
 *   Song title + Artist
 *        │
 *        ▼
 *   ytsearch5:<song> <artist> official audio   (tier 1)
 *        │  (no acceptable match)
 *        ▼
 *   ytsearch5:<song> <artist>                  (tier 2)
 *        │  (no acceptable match)
 *        ▼
 *   ytsearch5:<song>                           (tier 3)
 *        │
 *        ▼
 *   Score + select the most official upload, filtering out
 *   Shorts / Slowed / Reverb / Remix / Bass boosted / Lyrics / Fan uploads
 *
 * Cache: youtube_cache.json — an audioId already cached is never
 * re-searched; the cached result is simply returned.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const CACHE_FILE = path.join(__dirname, "youtube_cache.json");
const SEARCH_RESULTS_PER_QUERY = 5;
const SEARCH_TIMEOUT_MS = 45000;

// === Detect Python interpreter (same as shazam_recognition.js) ===
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

/* ===== Cache (youtube_cache.json — permanent, survives restarts) ===== */
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

/**
 * getCachedResult(audioId)
 * Read-only lookup — does NOT call yt-dlp. Returns the cached record or
 * null if this audioId has never been searched.
 */
function getCachedResult(audioId) {
  if (!audioId) return null;
  const db = loadCache();
  return db[audioId] || null;
}

function saveResultToCache({ audioId, song, artist, youtubeId, youtubeUrl, channelName }) {
  if (!audioId) return null;
  const db = loadCache();
  db[audioId] = {
    audioId,
    song: song || null,
    artist: artist || null,
    youtubeId: youtubeId || null,
    youtubeUrl: youtubeUrl || null,
    channelName: channelName || null,
    cachedAt: new Date().toISOString(),
  };
  saveCache(db);
  return db[audioId];
}

/* ===== yt-dlp process helper (now uses Python -m yt_dlp) ===== */

/**
 * Runs yt-dlp with the given args and resolves with raw stdout text.
 * Rejects (never throws synchronously) on a non-zero exit code, spawn
 * error, or timeout.
 */
function runYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Call via python -m yt_dlp
    const child = spawn(PYTHON_BIN, ['-m', 'yt_dlp', ...args], { windowsHide: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = err.code === "ENOENT" ? " (is python installed and yt-dlp package installed via pip?)" : "";
      reject(new Error(`yt-dlp failed to start: ${err.message}${hint}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/* ===== Search query tiers ===== */

/**
 * Builds the 3 fallback search queries in priority order, exactly per spec.
 */
function buildSearchQueries(song, artist) {
  const queries = [];
  if (song && artist) {
    queries.push(`${song} ${artist} official audio`);
    queries.push(`${song} ${artist}`);
  }
  if (song) {
    queries.push(song);
  }
  return queries;
}

/**
 * Runs one ytsearchN: query via yt-dlp and returns normalized candidates.
 * Uses --flat-playlist for speed; entries carry id/title/channel/
 * uploader/duration/url, which is enough for scoring below.
 */
async function searchOnce(query) {
  const args = [
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--ignore-errors",
    `ytsearch${SEARCH_RESULTS_PER_QUERY}:${query}`,
  ];

  const stdout = await runYtDlp(args, SEARCH_TIMEOUT_MS);

  const candidates = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const youtubeId = entry.id || null;
      if (!youtubeId) continue;
      candidates.push({
        youtubeId,
        title: entry.title || "",
        channelName: entry.channel || entry.uploader || "Unknown",
        channelIsVerified: Boolean(entry.channel_is_verified),
        duration: typeof entry.duration === "number" ? entry.duration : null,
        youtubeUrl: entry.url && entry.url.startsWith("http")
          ? entry.url
          : `https://www.youtube.com/watch?v=${youtubeId}`,
      });
    } catch (e) {
      // Skip a malformed line rather than failing the whole search.
    }
  }

  return candidates;
}

/* ===== Best-result selection ===== */

// Avoid: Shorts, Slowed, Reverb, Remix, Bass boosted, Lyrics videos, Fan uploads.
const BLOCKLIST_PATTERNS = [
  /\bshorts?\b/i,
  /\bslowed\b/i,
  /\breverb\b/i,
  /\bremix\b/i,
  /bass\s*boost(ed)?/i,
  /\blyrics?\b/i,
  /\bfan\s*(made|upload|edit|cover)\b/i,
  /\bcover\b/i,
];

function isBlocked(candidate) {
  if (BLOCKLIST_PATTERNS.some(re => re.test(candidate.title))) return true;
  // A YouTube Short is typically ≤ 60s and/or its URL path contains /shorts/.
  if (candidate.duration !== null && candidate.duration > 0 && candidate.duration <= 60) return true;
  if (candidate.youtubeUrl && candidate.youtubeUrl.includes("/shorts/")) return true;
  return false;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Scores a candidate by how "official" it looks, per the requested
 * preference order:
 *   1. Official Artist channel   (channel name matches the artist)
 *   2. Official Topic channel    (YouTube's auto-generated "<Artist> - Topic")
 *   3. Official Music Video      (title says "official video"/"official music video")
 *   4. Verified music channels   (channel_is_verified, or channel name says "official"/"vevo")
 */
function scoreCandidate(candidate, artist) {
  let score = 0;
  const channelNorm = normalize(candidate.channelName);
  const artistNorm = normalize(artist);
  const titleLower = (candidate.title || "").toLowerCase();

  // 1. Official Artist channel
  if (artistNorm && channelNorm && (channelNorm === artistNorm || channelNorm.includes(artistNorm))) {
    score += 100;
  }

  // 2. Official Topic channel (YouTube auto-generated, always "<Artist> - Topic")
  if (/\btopic\b/i.test(candidate.channelName || "")) {
    score += 90;
  }

  // 3. Official Music Video / Official Audio
  if (titleLower.includes("official music video") || titleLower.includes("official video")) {
    score += 60;
  } else if (titleLower.includes("official audio")) {
    score += 55;
  }

  // 4. Verified music channels
  if (candidate.channelIsVerified) score += 40;
  if (/\bofficial\b/i.test(candidate.channelName || "")) score += 20;
  if (/\bvevo\b/i.test(candidate.channelName || "")) score += 20;

  return score;
}

/**
 * selectBestMatch(candidates, artist)
 * Filters out blocked (non-official-style) uploads, then picks the
 * highest-scoring remaining candidate. Returns null if every candidate in
 * this batch is blocked/unsuitable — the caller should then try the next
 * fallback query tier rather than accept a bad upload.
 */
function selectBestMatch(candidates, artist) {
  const allowed = candidates.filter(c => !isBlocked(c));
  if (allowed.length === 0) return null;

  let best = allowed[0];
  let bestScore = scoreCandidate(best, artist);

  for (const c of allowed.slice(1)) {
    const s = scoreCandidate(c, artist);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }

  return best;
}

/* ===== Console output ===== */
function printSearching() {
  console.log("\nSearching YouTube...");
}

function printFound({ song, artist, channelName, cached }) {
  console.log("\nFound:");
  console.log(song || "Unknown");
  console.log("\nArtist:");
  console.log(artist || "Unknown");
  console.log("\nChannel:");
  console.log(channelName || "Unknown");
  console.log("\nCached: " + (cached ? "YES" : "NO"));
}

function printNotFound(error) {
  console.log(`\n❌ Not found on YouTube${error ? ` (${error})` : ""}`);
}

/* ===== Public API ===== */

/**
 * searchYoutube({ audioId, song, artist })
 *
 * Cache-first: an audioId already in youtube_cache.json is returned
 * immediately — yt-dlp is never called for it again. Otherwise runs the
 * 3-tier query fallback, scores/selects the best result, caches it, and
 * returns it.
 *
 * @param {object} params
 * @param {string} params.audioId - Stable identifier for this audio (cache key). Required to use the cache.
 * @param {string} params.song - Song title
 * @param {string} [params.artist] - Artist name, if available
 * @returns {Promise<object>} {
 *   found: boolean,
 *   fromCache: boolean,
 *   audioId, song, artist, youtubeId, youtubeUrl, channelName,
 *   error?: string
 * }
 */
async function searchYoutube({ audioId, song, artist } = {}) {
  printSearching();

  // 1. Check cache — never search again for an already-cached audioId.
  const cached = getCachedResult(audioId);
  if (cached) {
    printFound({ song: cached.song, artist: cached.artist, channelName: cached.channelName, cached: true });
    return {
      found: true,
      fromCache: true,
      audioId: cached.audioId,
      song: cached.song,
      artist: cached.artist,
      youtubeId: cached.youtubeId,
      youtubeUrl: cached.youtubeUrl,
      channelName: cached.channelName,
    };
  }

  const queries = buildSearchQueries(song, artist);
  if (queries.length === 0) {
    const error = "No song title provided — cannot search";
    printNotFound(error);
    return { found: false, fromCache: false, audioId, song, artist, error };
  }

  let lastError = null;

  for (const query of queries) {
    try {
      const candidates = await searchOnce(query);
      const best = selectBestMatch(candidates, artist);
      if (best) {
        if (audioId) {
          saveResultToCache({
            audioId, song, artist,
            youtubeId: best.youtubeId, youtubeUrl: best.youtubeUrl, channelName: best.channelName,
          });
        }
        printFound({ song, artist, channelName: best.channelName, cached: false });
        return {
          found: true,
          fromCache: false,
          audioId, song, artist,
          youtubeId: best.youtubeId,
          youtubeUrl: best.youtubeUrl,
          channelName: best.channelName,
        };
      }
      // No acceptable (non-blocked) match in this tier — fall through to
      // the next, less-specific query.
    } catch (e) {
      lastError = e.message;
      // Search failure for this tier — try the next fallback query rather
      // than giving up immediately.
    }
  }

  const error = lastError || "No acceptable match found in any search tier";
  printNotFound(error);
  return { found: false, fromCache: false, audioId, song, artist, error };
}

module.exports = {
  searchYoutube,
  getCachedResult,
  buildSearchQueries,
  selectBestMatch,
};

/* ===== Self-test / manual verification =====
 * Run directly to verify search + cache end-to-end (requires python and yt-dlp package):
 *   node youtube_search.js "Song Title" ["Artist Name"] ["audioId"]
 * Run it twice with the same audioId — the second run should print
 * "Cached: YES" and make no yt-dlp call.
 */
if (require.main === module) {
  const [, , cliSong, cliArtist, cliAudioId] = process.argv;

  if (!cliSong) {
    console.log('Usage: node youtube_search.js "Song Title" ["Artist Name"] ["audioId"]');
    process.exit(1);
  }

  (async () => {
    const result = await searchYoutube({
      audioId: cliAudioId || `test_${cliSong}`,
      song: cliSong,
      artist: cliArtist,
    });
    console.log("\nResult:", JSON.stringify(result, null, 2));
  })();
}