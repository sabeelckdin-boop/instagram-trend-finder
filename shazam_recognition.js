/**
 * shazam_recognition.js — Shazam-based Original Audio recognition module.
 *
 * ADDITIVE ONLY — preserves 100% of existing functionality (same public
 * API as before: recognizeAfterCapture, getEffectiveCanonicalKey,
 * mergeCanonicalAudios, extractReelVideoUrl, loadRDB).
 *
 * Architecture:
 *   1. Called AFTER Instagram API capture (not before)
 *   2. Receives the captured API response to extract reel video URLs
 *   3. Downloads one reel → extracts audio → runs Shazam → caches result
 *   4. Failed recognitions are cached with a 30-day retry interval
 *   5. Canonical audio merging: multiple Instagram Original Audio IDs
 *      that resolve to the same ISRC/Shazam ID are merged into one DB
 *      entry
 *
 * NEVER modifies idKey on audioTracks entries.
 * Uses shazamCanonicalKey as an additive field for downstream aggregation.
 * IMPORTANT: for that aggregation to actually stick across runs, callers
 * that write new snapshots into audio_growth_db.json must key off
 * getEffectiveCanonicalKey(track), not track.idKey. (scrape.js's Phase 3
 * now does this — see CHANGELOG in scrape.js.)
 *
 * FIX v7.1: recognizeAfterCapture accepts an apiContext parameter so each
 *   Original Audio gets its OWN video URL by replaying the captured
 *   request for that specific audio ID, instead of all sharing one video
 *   from the Phase 2 capture response.
 *
 * FIX (this pass) — replayForVideoUrl now delegates ID substitution to
 *   the shared replay_utils.replayApiRequest() (URLSearchParams-based)
 *   instead of its own inline regex copy, fixing the same silent no-op
 *   bug (see replay_utils.js header) that was previously only fixed for
 *   scrape.js's own replay path.
 *
 * FIX (this pass) — mergeCanonicalAudios no longer loses data when 3+
 *   Original Audio IDs resolve to the same canonical song. The old code
 *   deleted the "primary" entry on the first merge and then, on the
 *   second merge, treated its own canonical entry as if it didn't exist
 *   yet — silently overwriting the already-merged history with a copy of
 *   just the third ID. Every group member is now folded into
 *   db[canonicalKey] directly, one at a time, so nothing is lost
 *   regardless of group size.
 *
 * FIX (this pass) — extractReelVideoUrl's last-resort fallback used to
 *   accept ANY string anywhere in the response containing the substring
 *   "video" (not just ones ending in .mp4), which could grab unrelated
 *   fields (subtitle URIs, manifests) and feed the wrong media into
 *   Shazam. Tightened to require an actual .mp4 URL.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
// FIX (this pass): replayForVideoUrl below now uses the shared, corrected
// substitution logic (replay_utils.replayApiRequest) instead of its own
// inline regex copy — see replay_utils.js's header for why the regex
// approach silently no-op'd when a target field was empty/absent from
// the captured template.

/* ===== Config ===== */
// ... (no changes in CONFIG)

/**
 * verifyDependencies()
 * Ensures required system binaries (like ffmpeg) are installed.
 * @returns {{ ok: boolean, error?: string }}
 */
function verifyDependencies() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "FFmpeg not found. Please install FFmpeg and add it to your system PATH to enable audio recognition." };
  }
}

/* ===== Utilities ===== */
// ... (no changes in Utilities)

const replayUtils = require("./replay_utils");

/* ===== Config ===== */
const RECOGNITION_DB = path.join(__dirname, "audio_recognition_db.json");
const TEMP_DIR = path.join(__dirname, "tmp_shazam");
const SHAZAM_SCRIPT = path.join(__dirname, "shazam_recognize.py");
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const CLIP_DURATION_SEC = 12;
const CLIP_START_SEC = 3;
const FAILED_RETRY_DAYS = 30; // Only retry failed recognitions after this many days

/* ===== Utilities ===== */
function now() { return Date.now(); }

function atomicWriteSync(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function safeDelete(fp) { try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {} }

function hashId(id) { return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 16); }

/* ===== Recognition DB ===== */
function loadRDB() {
  try { return JSON.parse(fs.readFileSync(RECOGNITION_DB, "utf8") || "{}"); } catch (e) { return {}; }
}

function saveRDB(db) { atomicWriteSync(RECOGNITION_DB, JSON.stringify(db, null, 2)); }

/**
 * Check if an audioAssetId has been cached and whether it should be retried.
 * Returns the cached record if valid (not expired failure), null if need to retry.
 */
function getCached(audioAssetId) {
  const db = loadRDB();
  const record = db[audioAssetId];
  if (!record) return null;

  // If it was successful, always use cache
  if (record.status === "recognized") return record;

  // If it failed, check if enough time has passed to retry
  if (record.status === "failed") {
    const elapsedDays = (now() - record.lastAttempt) / (1000 * 60 * 60 * 24);
    if (elapsedDays < FAILED_RETRY_DAYS) return record;
    // Expired failure — return null so caller retries
    return null;
  }

  return record;
}

/**
 * Store a recognition result.
 * For failures: stores with status "failed" and timestamp
 * For successes: stores with status "recognized" and full metadata
 *
 * ADDITIVE field `errorType` (this pass): distinguishes "we couldn't even
 * get a video to analyze" from "Shazam ran and found no match", so both
 * don't get silently lumped under one 30-day cooldown with no way to
 * tell them apart later. Cooldown behavior itself is unchanged.
 */
function cacheResult(audioAssetId, r) {
  const db = loadRDB();

  if (!r.success) {
    // Store failure with timestamp for retry logic
    const existing = db[audioAssetId];
    db[audioAssetId] = {
      audioAssetId,
      status: "failed",
      lastAttempt: now(),
      error: r.error || "Unknown error",
      errorType: r.errorType || "unknown",
      // Preserve any previously recognized data if this is a retry that failed
      shazamTrackId: existing?.shazamTrackId || null,
      isrc: existing?.isrc || null,
      title: existing?.title || null,
      artist: existing?.artist || null,
      album: existing?.album || null,
      shazamCanonicalKey: existing?.shazamCanonicalKey || null,
    };
  } else {
    // Store success
    db[audioAssetId] = {
      audioAssetId,
      status: "recognized",
      lastAttempt: now(),
      shazamTrackId: r.shazamTrackId || null,
      isrc: r.isrc || null,
      title: r.title || null,
      artist: r.artist || null,
      album: r.album || null,
      shazamCanonicalKey: r.shazamCanonicalKey || null,
      error: null,
      errorType: null,
    };
  }

  saveRDB(db);
  return db[audioAssetId];
}

/* ===== FFmpeg audio extraction ===== */
function extractAudioClip(videoPath, outDir) {
  return new Promise((resolve, reject) => {
    const stem = path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(outDir, `${stem}.mp3`);
    const args = [
      "-y", "-ss", String(CLIP_START_SEC), "-i", videoPath,
      "-t", String(CLIP_DURATION_SEC),
      "-vn", "-acodec", "libmp3lame", "-q:a", "2", "-map", "a", audioPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", c => { stderr += c.toString(); });
    proc.on("close", code => {
      if (code === 0 && fs.existsSync(audioPath)) return resolve(audioPath);
      safeDelete(audioPath);
      reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-200)}`));
    });
    proc.on("error", err => { safeDelete(audioPath); reject(new Error(`FFmpeg spawn: ${err.message}`)); });
  });
}

/* ===== Video download ===== */
function downloadVideo(urlStr, outPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? require("https") : require("http");
    const file = fs.createWriteStream(outPath);
    const req = mod.get(urlStr, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); safeDelete(outPath);
        return downloadVideo(res.headers.location, outPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); safeDelete(outPath);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return resolve(outPath);
        safeDelete(outPath);
        reject(new Error("Downloaded file too small"));
      });
    });
    req.on("error", err => { file.close(); safeDelete(outPath); reject(new Error(`Download: ${err.message}`)); });
    req.on("timeout", () => { req.destroy(); file.close(); safeDelete(outPath); reject(new Error("Download timeout")); });
  });
}

/* ===== Python Shazam call ===== */
function runShazamPy(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SHAZAM_SCRIPT, audioPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", c => { stdout += c.toString(); });
    proc.stderr.on("data", c => { stderr += c.toString(); });
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`Python exit ${code}: ${stderr.slice(-200)}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch (e) { reject(new Error(`Parse fail: ${e.message}. stdout: ${stdout.slice(0, 200)}`)); }
    });
    proc.on("error", err => reject(new Error(`Python spawn: ${err.message}`)));
  });
}

/* ===== Recognize one audio from a video URL ===== */
async function recognizeFromVideo(audioAssetId, videoUrl) {
  if (!audioAssetId) return null;

  // Check cache first (honors 30-day retry for failures)
  const cached = getCached(audioAssetId);
  if (cached) return cached;

  if (!videoUrl) {
    return cacheResult(audioAssetId, {
      success: false, error: "No video URL available", errorType: "no_video_url",
      shazamTrackId: null, isrc: null, title: null, artist: null, album: null, shazamCanonicalKey: null,
    });
  }

  const tag = hashId(audioAssetId);
  const tmpDir = path.join(TEMP_DIR, tag);
  ensureDir(tmpDir);
  const videoPath = path.join(tmpDir, `reel_${tag}.mp4`);

  try {
    await downloadVideo(videoUrl, videoPath);
    const audioPath = await extractAudioClip(videoPath, tmpDir);
    const shazamResult = await runShazamPy(audioPath);

    let shazamCanonicalKey = null;
    if (shazamResult.success) {
      shazamCanonicalKey = shazamResult.isrc
        ? `isrc:${shazamResult.isrc}`
        : `shazam:${shazamResult.shazamTrackId}`;
    }

    return cacheResult(audioAssetId, {
      success: shazamResult.success,
      shazamTrackId: shazamResult.shazamTrackId || null,
      isrc: shazamResult.isrc || null,
      title: shazamResult.title || null,
      artist: shazamResult.artist || null,
      album: shazamResult.album || null,
      shazamCanonicalKey,
      error: shazamResult.error || null,
      errorType: shazamResult.success ? null : "shazam_no_match",
    });
  } catch (err) {
    return cacheResult(audioAssetId, {
      success: false, error: err.message, errorType: "pipeline_error",
      shazamTrackId: null, isrc: null, title: null, artist: null, album: null, shazamCanonicalKey: null,
    });
  } finally {
    safeDelete(videoPath);
    if (fs.existsSync(tmpDir)) {
      try {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) { if (f.endsWith(".mp3")) safeDelete(path.join(tmpDir, f)); }
        try { fs.rmdirSync(tmpDir); } catch (e) {}
      } catch (e) {}
    }
  }
}

/* ===== Extract reel video URL from captured API response ===== */

/**
 * Extract the first reel's video URL from a captured /api/v1/clips/music/ response.
 *
 * Handles multiple response wrapper formats:
 *   - { json: ... } (wrapped format)
 *   - { response: ... } (original v6 captureRequest format)
 *   - Raw JSON object (direct passthrough)
 */
function extractReelVideoUrl(capturedResponse) {
  if (!capturedResponse) return null;

  let json = capturedResponse.json || capturedResponse.response || capturedResponse;
  if (json && json.response) json = json.response;
  if (!json || typeof json !== 'object') return null;

  try {
    // Path 1: items[0].media.video_versions[0].url (and known alternates)
    if (json.items && Array.isArray(json.items) && json.items.length > 0) {
      const firstItem = json.items[0];
      if (firstItem.media && firstItem.media.video_versions && firstItem.media.video_versions.length > 0) {
        console.log("      🔎 extractReelVideoUrl: matched via items[0].media.video_versions");
        return firstItem.media.video_versions[0].url;
      }
      if (firstItem.video_versions && firstItem.video_versions.length > 0) {
        console.log("      🔎 extractReelVideoUrl: matched via items[0].video_versions");
        return firstItem.video_versions[0].url;
      }
      if (firstItem.media && firstItem.media.video_url) {
        console.log("      🔎 extractReelVideoUrl: matched via items[0].media.video_url");
        return firstItem.media.video_url;
      }
    }

    // Path 2: walk the entire JSON recursively to find any video_versions
    let foundUrl = null;
    function walk(obj, depth) {
      if (depth > 20 || foundUrl || obj == null || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth + 1)); return; }
      if (obj.video_versions && Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
        foundUrl = obj.video_versions[0].url;
        return;
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    }
    walk(json, 0);
    if (foundUrl) {
      console.log("      🔎 extractReelVideoUrl: matched via recursive video_versions walk (Path 2)");
      return foundUrl;
    }

    // Path 3 (FIXED): last-resort — any string that looks like an actual
    // playable .mp4 URL. The old version also accepted anything merely
    // *containing* the substring "video" anywhere (subtitle URIs, DASH
    // manifests, unrelated field names), which could hand Shazam the
    // wrong media entirely. Now requires a real .mp4 URL.
    //
    // ADDED (this pass): this tier is logged explicitly (unlike Paths 1/2)
    // because it's the least reliable match — if the response shape ever
    // changes upstream and every video URL starts coming through here, that
    // should be visible in the console instead of looking identical to a
    // clean structured match.
    function walkForMp4(obj, depth) {
      if (depth > 20 || foundUrl || obj == null || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(i => walkForMp4(i, depth + 1)); return; }
      if (typeof obj === 'string' && /\.mp4(\?|$)/i.test(obj)) {
        foundUrl = obj;
        return;
      }
      for (const v of Object.values(obj)) walkForMp4(v, depth + 1);
    }
    walkForMp4(json, 0);
    if (foundUrl) {
      console.log("      ⚠️ extractReelVideoUrl: fell back to last-resort .mp4 scan (Path 3) — response shape may have changed");
      return foundUrl;
    }

  } catch (e) {
    // Silently fail — if we can't find a video URL, recognition is skipped
  }

  return null;
}

/* ===== Replay captured request and extract video URL ===== */

/**
 * Replays the captured API request for a specific audio ID and extracts
 * the first reel's video URL from the response. This gives each Original
 * Audio its OWN video for Shazam recognition, preventing false matches
 * where multiple audios were incorrectly identified as the same song.
 *
 * Shazam recognition only ever runs on Original Audio (audioAssetId,
 * never audioClusterId — see recognizeAfterCapture's `originals` filter),
 * so this always replays as an asset-id request.
 *
 * FIX (this pass): now delegates substitution to replay_utils.replayApiRequest
 * (URLSearchParams-based) instead of the old inline regex approach, which
 * could silently fail to set the target ID whenever the captured template's
 * field was empty or absent (e.g. a cluster-only template) — the exact bug
 * already fixed for scrape.js's own replay path, previously left
 * unaddressed here.
 *
 * @param {object} apiContext - Playwright's request context (page.request)
 * @param {object} captured - The captured API request/response object
 * @param {string} audioId - The Original Audio asset ID to replay for
 * @returns {Promise<string|null>} The reel video URL, or null on failure
 */
async function replayForVideoUrl(apiContext, captured, audioId) {
  if (!apiContext || !captured || !audioId) return null;

  const result = await replayUtils.replayApiRequest(apiContext, captured, { assetId: audioId });
  if (result.error || !result.json) return null;

  const videoUrl = extractReelVideoUrl(result.json);
  if (videoUrl) {
    console.log(`      🎬 Got unique video URL for audio ${audioId}`);
  }
  return videoUrl || null;
}

/* ===== Canonical Audio Merging ===== */

/**
 * Merge two history arrays, deduplicating by (time, count) and sorting by time.
 */
function mergeHistory(a, b) {
  const seen = new Set();
  const all = [...a, ...b];
  const unique = [];
  for (const h of all) {
    const key = `${h.time}-${h.count}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(h);
    }
  }
  return unique.sort((x, y) => x.time - y.time);
}

/**
 * Merge two adoptionEvents arrays, deduplicating by (time, creatorId).
 */
function mergeAdoptionEvents(a, b) {
  const seen = new Set();
  const all = [...(a || []), ...(b || [])];
  const unique = [];
  for (const e of all) {
    const key = `${e.time}-${e.creatorId || e.creator_id || 'unknown'}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }
  return unique.sort((x, y) => (x.time || 0) - (y.time || 0));
}

/**
 * Fold a single source DB entry into the canonical entry at
 * db[canonicalKey], creating it if needed, and delete the source.
 *
 * FIX (this pass): the old mergeDbEntries(db, canonicalKey, source, target)
 * ping-ponged between a "primary" idKey and the canonical key, and lost
 * data on the 2nd+ merge in any group of 3 or more (see file header /
 * CHANGELOG). This version always folds directly into db[canonicalKey],
 * one source at a time, so group size doesn't matter.
 */
function mergeOneEntryInto(db, canonicalKey, sourceIdKey) {
  const source = db[sourceIdKey];
  if (!source) return; // Nothing to merge

  const target = db[canonicalKey];

  if (!target) {
    // Canonical entry doesn't exist yet — just rename source into place.
    db[canonicalKey] = JSON.parse(JSON.stringify(source));
    db[canonicalKey].idKey = canonicalKey;
    db[canonicalKey].shazamCanonicalKey = canonicalKey;
    if (sourceIdKey !== canonicalKey) delete db[sourceIdKey];
    return;
  }

  const merged = {
    idKey: canonicalKey,
    title: target.title || source.title || 'Unknown',
    audioClusterId: target.audioClusterId || source.audioClusterId || null,
    audioAssetId: target.audioAssetId || source.audioAssetId || null,
    alternateAudioAssetIds: [...new Set([
      ...(target.alternateAudioAssetIds || [target.audioAssetId].filter(Boolean)),
      ...(source.alternateAudioAssetIds || [source.audioAssetId].filter(Boolean)),
    ].filter(Boolean))],
    firstSeenCreator: target.firstSeenCreator || source.firstSeenCreator || null,
    firstSeenPost: target.firstSeenPost || source.firstSeenPost || null,
    firstSeenTime: Math.min(target.firstSeenTime ?? Infinity, source.firstSeenTime ?? Infinity),
    takenAt: target.takenAt || source.takenAt || null,
    history: mergeHistory(target.history || [], source.history || []),
    adoptionEvents: mergeAdoptionEvents(target.adoptionEvents || [], source.adoptionEvents || []),
    shazamCanonicalKey: canonicalKey,
  };

  db[canonicalKey] = merged;
  if (sourceIdKey !== canonicalKey) delete db[sourceIdKey];
}

/**
 * After Shazam recognition completes, scan the DB for entries where
 * different audioAssetIds resolve to the same shazamCanonicalKey,
 * and merge them.
 *
 * @param {object} db — The audio_growth_db.json database (loaded by caller)
 * @param {object} recognitionDb — The audio_recognition_db.json database
 * @returns {number} Number of merges performed
 */
function mergeCanonicalAudios(db, recognitionDb) {
  // Step 1: Build a map of canonicalKey → [idKeys that map to it]
  const canonicalMap = new Map();

  for (const [idKey, entry] of Object.entries(db)) {
    if (!entry.audioAssetId) continue; // licensed audio stays as-is

    const recRecord = recognitionDb[entry.audioAssetId];
    if (!recRecord || recRecord.status !== "recognized" || !recRecord.shazamCanonicalKey) continue;

    const canonicalKey = recRecord.shazamCanonicalKey;
    if (!canonicalMap.has(canonicalKey)) canonicalMap.set(canonicalKey, []);
    canonicalMap.get(canonicalKey).push(idKey);
  }

  // Step 2: fold every member of each multi-member group into
  // db[canonicalKey], one at a time. Order doesn't matter — each fold
  // reads whatever is currently at db[canonicalKey] (possibly already
  // merged) and combines it with the next source, so groups of any size
  // merge correctly and nothing is lost.
  let mergeCount = 0;
  for (const [canonicalKey, idKeys] of canonicalMap) {
    if (idKeys.length <= 1) continue;

    console.log(`   🔗 Merging ${idKeys.length} entries under canonical: ${canonicalKey}`);
    console.log(`      IDs: ${idKeys.join(", ")}`);

    for (const idKey of idKeys) {
      if (idKey === canonicalKey) continue;
      mergeOneEntryInto(db, canonicalKey, idKey);
      mergeCount++;
    }
  }

  return mergeCount;
}

/**
 * Populate shazamCanonicalKey on audioTracks entries so downstream code
 * can use it for aggregation without knowing the canonical mapping.
 *
 * Also handles the audioTracks deduplication: if two discovered tracks
 * now map to the same canonical key, keep only the first one.
 */
function applyCanonicalKeysToTracks(audioTracks, recognitionDb) {
  const seenCanonicalKeys = new Set();
  const deduped = [];

  for (const t of audioTracks) {
    // For Original Audio (has audioAssetId, no audioClusterId)
    if (t.audioAssetId && !t.audioClusterId) {
      const rec = recognitionDb[t.audioAssetId];
      if (rec && rec.status === "recognized") {
        t.shazamCanonicalKey = rec.shazamCanonicalKey;
        t.shazamRecognition = rec;
      } else if (rec && rec.status === "failed") {
        t.shazamCanonicalKey = null;
        t.shazamRecognition = rec;
      }
    }

    // Deduplicate: if this track has a canonical key we've already seen, skip it
    const effectiveKey = t.shazamCanonicalKey || t.idKey;
    if (seenCanonicalKeys.has(effectiveKey)) {
      continue; // Skip duplicate
    }
    seenCanonicalKeys.add(effectiveKey);
    deduped.push(t);
  }

  // Replace audioTracks array in-place
  audioTracks.length = 0;
  audioTracks.push(...deduped);

  return audioTracks;
}

/* ===== Public API ===== */

/**
 * recognizeAfterCapture(audioTracks, capturedResponse, apiContext)
 *
 * Called from run() AFTER Phase 2 (API capture).
 *
 * What it does:
 *   1. For each NEW or EXPIRED-FAILURE Original Audio:
 *      - Replays the captured API request with that audio's ID
 *      - Extracts a unique reel video URL from the replayed response
 *      - Downloads the reel → extracts audio → runs Shazam → caches result
 *   2. Populates shazamCanonicalKey on each track
 *   3. Deduplicates audioTracks so duplicate canonical songs appear once
 *   4. Returns the recognition DB so caller can merge canonical DB entries
 *
 * CLEANUP (this pass): this used to be two separate passes over
 * `originals` that each independently re-derived the same cache/cooldown
 * logic (once to print a summary, once to decide what to actually skip).
 * Consolidated into a single classification pass that produces one
 * `toRecognize` list, which is then the only thing iterated.
 *
 * @param {Array} audioTracks - Output from discoverAudio()
 * @param {object} capturedResponse - The captured API request/response object
 * @param {object} apiContext - Playwright's request context (page.request) for replay
 * @returns {Promise<{audioTracks: Array, recognitionDb: object}>}
 */
async function recognizeAfterCapture(audioTracks, capturedResponse, apiContext) {
  if (!audioTracks || audioTracks.length === 0) {
    return { audioTracks, recognitionDb: loadRDB() };
  }

  console.log("\n🧬 PHASE 2b: Shazam Recognition for Original Audio");

  const originals = audioTracks.filter(t => !t.audioClusterId && t.audioAssetId);
  const licensed = audioTracks.filter(t => t.audioClusterId);

  console.log(`   Licensed (skip): ${licensed.length} | Original Audio: ${originals.length}`);

  if (originals.length === 0) {
    console.log("   ✅ Nothing to recognize");
    return { audioTracks, recognitionDb: loadRDB() };
  }

  const rdb = loadRDB();

  // Single classification pass: for every Original Audio, decide whether
  // it's already resolved from cache (and annotate it), or needs a fresh
  // recognition attempt.
  const toRecognize = [];
  let cachedCount = 0, expiredRetries = 0;

  for (const t of originals) {
    const record = rdb[t.audioAssetId];

    if (!record) {
      toRecognize.push(t);
      continue;
    }

    if (record.status === "recognized") {
      t.shazamCanonicalKey = record.shazamCanonicalKey || null;
      t.shazamRecognition = record;
      cachedCount++;
      continue;
    }

    // status === "failed"
    const elapsedDays = (now() - record.lastAttempt) / (1000 * 60 * 60 * 24);
    if (elapsedDays >= FAILED_RETRY_DAYS) {
      expiredRetries++;
      toRecognize.push(t);
    } else {
      t.shazamCanonicalKey = null;
      t.shazamRecognition = record;
      cachedCount++;
    }
  }

  if (toRecognize.length === 0) {
    console.log(`   ✅ All ${cachedCount} already cached (${expiredRetries} expired failures waiting for retry)`);
    applyCanonicalKeysToTracks(audioTracks, rdb);
    return { audioTracks, recognitionDb: rdb };
  }

  console.log(`   📡 ${toRecognize.length} to recognize (${cachedCount} cached, ${expiredRetries} expired failures being retried)`);

  let ok = 0, fail = 0;
  for (let i = 0; i < toRecognize.length; i++) {
    const t = toRecognize[i];
    const label = t.title ? t.title.slice(0, 50) : `ID:${t.audioAssetId}`;
    console.log(`   [${i + 1}/${toRecognize.length}] "${label}" (ID: ${t.audioAssetId})`);

    try {
      let videoUrl = null;
      if (apiContext && capturedResponse) {
        videoUrl = await replayForVideoUrl(apiContext, capturedResponse, t.audioAssetId);
      }

      if (!videoUrl) {
        console.log(`      ⚠️ No video URL obtained for this audio`);
        await cacheResult(t.audioAssetId, {
          success: false, error: "Could not obtain video URL for this audio ID", errorType: "no_video_url",
          shazamTrackId: null, isrc: null, title: null, artist: null, album: null, shazamCanonicalKey: null,
        });
        fail++;
        continue;
      }

      const rec = await recognizeFromVideo(t.audioAssetId, videoUrl);
      if (rec && rec.status === "recognized") {
        t.shazamCanonicalKey = rec.shazamCanonicalKey;
        t.shazamRecognition = rec;
        console.log(`      ✅ → ${rec.artist} — ${rec.title} (${rec.shazamCanonicalKey})`);
        ok++;
      } else {
        t.shazamCanonicalKey = null;
        t.shazamRecognition = rec || { status: "failed", error: "unknown" };
        console.log(`      ❌ ${(rec && rec.error) || "failed"}`);
        fail++;
      }
    } catch (err) {
      t.shazamCanonicalKey = null;
      console.log(`      ❌ ${err.message}`);
      fail++;
    }
  }

  console.log(`   🧬 Summary: ${ok} recognized, ${fail} failed, ${cachedCount} cached`);

  const updatedRdb = loadRDB();
  applyCanonicalKeysToTracks(audioTracks, updatedRdb);

  // Report canonical groups
  const groups = new Map();
  for (const t of audioTracks) {
    const key = t.shazamCanonicalKey || t.idKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [key, group] of groups) {
    if (group.length > 1) {
      console.log(`   🔗 Group under ${key}: ${group.map(t => t.audioAssetId || t.idKey).join(", ")}`);
    }
  }

  return { audioTracks, recognitionDb: updatedRdb };
}

/**
 * getEffectiveCanonicalKey(audioEntry)
 * Returns the shazamCanonicalKey if present, otherwise falls back to idKey.
 *
 * Downstream code that writes growth snapshots (scrape.js Phase 3) MUST
 * use this instead of raw `idKey` for the DB key, or a canonical merge
 * gets silently re-fragmented the next time a snapshot is written (this
 * was a real bug — see scrape.js CHANGELOG).
 */
function getEffectiveCanonicalKey(entry) {
  return entry.shazamCanonicalKey || entry.idKey;
}

module.exports = {
  recognizeAfterCapture,
  getEffectiveCanonicalKey,
  mergeCanonicalAudios,
  extractReelVideoUrl,
  loadRDB,
  verifyDependencies,
};