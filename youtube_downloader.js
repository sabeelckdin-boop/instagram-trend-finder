/**
 * youtube_downloader.js — yt-dlp download, replacing the RapidAPI
 * Spotify-downloader step.
 *
 * STANDALONE / ADDITIVE — does not modify the scraper (gittest.js), AI
 * modules (Tavily/Groq/trend classification), telegram_sender.js, or
 * youtube_search.js (Task 1). This module ONLY downloads — it takes a
 * youtubeUrl already resolved by youtube_search.js and turns it into a
 * local MP3 file. No search logic lives here.
 *
 * Removes the RapidAPI dependency entirely — no RAPIDAPI_KEY /
 * RAPIDAPI_HOST / spotify-downloader9 endpoint call anywhere in this
 * module.
 *
 * Requires the `yt-dlp` Python package installed via pip (e.g., pip install yt-dlp).
 * The Python interpreter (python or python3) must be on PATH.
 * yt-dlp's audio extraction (-x --audio-format mp3) uses ffmpeg under the hood,
 * so ffmpeg must also be available on PATH.
 *
 * Workflow:
 *   youtubeUrl
 *        │
 *        ▼
 *   yt-dlp: download highest quality audio, convert directly to MP3
 *        │
 *        ▼
 *   temp_audio/<title>.mp3
 *
 * No Telegram logic here — this only returns the local file info.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TEMP_AUDIO_DIR = path.join(__dirname, "temp_audio");
const DOWNLOAD_TIMEOUT_MS = 180000;

// === Detect Python interpreter (same as shazam_recognition.js) ===
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

/* ===== yt-dlp process helper ===== */

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

/* ===== Filesystem helpers ===== */
function ensureTempAudioDir() {
  if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
  }
}

/** Sanitize a title into a safe, human-readable filename. */
function sanitizeFilename(title) {
  const cleaned = (title || "untitled")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "") // strip characters illegal in filenames
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "untitled";
}

/* ===== Console output ===== */
function printStart(youtubeUrl) {
  console.log("\nDownloading audio...\n");
  console.log("YouTube:");
  console.log(youtubeUrl || "Unknown");
}

function printDone(filename, filePath) {
  console.log("\nDownloaded:");
  console.log(filename);
  console.log("\nLocation:");
  console.log(filePath);
}

/* ===== Public API ===== */

/**
 * downloadFromYoutube({ youtubeUrl, title })
 *
 * Downloads the highest quality available audio for youtubeUrl and
 * extracts it directly to MP3 in temp_audio/. Never throws — any failure
 * is logged and this resolves to `null` so the caller can skip this audio
 * and continue the scraper.
 *
 * @param {object} params
 * @param {string} params.youtubeUrl - YouTube video URL (from youtube_search.js)
 * @param {string} params.title - Song title, used to name the output file
 * @returns {Promise<{ filePath: string, title: string, youtubeUrl: string } | null>}
 */
async function downloadFromYoutube({ youtubeUrl, title } = {}) {
  if (!youtubeUrl) {
    console.log("\n❌ Download failed: no youtubeUrl provided");
    return null;
  }

  printStart(youtubeUrl);

  try {
    ensureTempAudioDir();

    const filename = sanitizeFilename(title);
    const destPath = path.join(TEMP_AUDIO_DIR, `${filename}.mp3`);

    // Already downloaded (e.g. an earlier attempt this run) — nothing to
    // redo, just report the existing file.
    if (fs.existsSync(destPath)) {
      printDone(`${filename}.mp3`, destPath);
      return { filePath: destPath, title: title || filename, youtubeUrl };
    }

    // yt-dlp writes to "<outtmpl>.<ext>" — with the extension forced to
    // mp3 via --audio-format, the final file lands exactly at destPath.
    const outtmpl = path.join(TEMP_AUDIO_DIR, filename);

    const args = [
      "-f", "bestaudio",       // highest quality available audio stream
      "-x",                    // extract audio
      "--audio-format", "mp3", // convert directly to MP3
      "--audio-quality", "0",  // best MP3 encoding quality
      "--no-warnings",
      "--no-playlist",
      "-o", `${outtmpl}.%(ext)s`,
      youtubeUrl,
    ];

    await runYtDlp(args, DOWNLOAD_TIMEOUT_MS);

    if (!fs.existsSync(destPath)) {
      console.log(`\n❌ Download failed: yt-dlp finished but the expected MP3 file was not found at ${destPath}`);
      return null;
    }

    printDone(`${filename}.mp3`, destPath);
    return { filePath: destPath, title: title || filename, youtubeUrl };
  } catch (e) {
    // Per spec: never stop the scraper — log and return null so the
    // caller moves on to the next audio.
    console.log(`\n❌ Download failed: ${e.message}`);
    return null;
  }
}

module.exports = { downloadFromYoutube, ensureTempAudioDir };

/* ===== Self-test / manual verification =====
 * Run directly to verify the download flow end-to-end (requires python + yt-dlp + ffmpeg):
 *   node youtube_downloader.js <youtubeUrl> "Title"
 */
if (require.main === module) {
  const [, , cliUrl, cliTitle] = process.argv;

  if (!cliUrl) {
    console.log('Usage: node youtube_downloader.js <youtubeUrl> "Title"');
    process.exit(1);
  }

  (async () => {
    const result = await downloadFromYoutube({ youtubeUrl: cliUrl, title: cliTitle || "untitled" });
    console.log("\nResult:", JSON.stringify(result, null, 2));
  })();
}