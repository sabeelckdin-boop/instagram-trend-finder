/**
 * youtube_telegram_pipeline.js — Connects yt-dlp search/download to the
 * existing Telegram sender for the Top 1 candidate per trend region.
 *
 * STANDALONE / WIRING ONLY — does not modify prediction logic, AI
 * analysis, youtube_search.js, youtube_downloader.js, or
 * telegram_sender.js. Contains no new search, download, or Telegram
 * logic — it only calls those modules' existing exported functions in
 * order and passes data between them:
 *
 *   AI Classification (Top 1 per region)
 *        │
 *        ▼
 *   youtube_search.js       → searchYoutube()
 *        │
 *        ▼
 *   youtube_downloader.js   → downloadFromYoutube()
 *        │
 *        ▼
 *   telegram_sender.js      → sendTop1ToTelegram()   (existing, unmodified)
 *        │
 *        ▼
 *   (telegram_sender.js already deletes the temp MP3 on success and keeps
 *    it on failure — see note below)
 *
 * Duplicate protection: reuses telegram_sender.js's own hasBeenSent()
 * check BEFORE running any search/download work, so an audio that was
 * already sent skips the entire pipeline (not just the Telegram step) —
 * no wasted yt-dlp search or download for a song that's just going to be
 * skipped anyway. telegram_sender.js's own internal duplicate check inside
 * sendTop1ToTelegram() still applies too (defense in depth); no duplicate
 * -protection logic is reimplemented here.
 *
 * ⚠️ KNOWN, UNAVOIDABLE OVERLAP (given telegram_sender.js is off-limits):
 *   - telegram_sender.js prints its OWN console block (📤 Telegram /
 *     Sending... / ✅ Sent / Saved to telegram_sent_db.json / Deleting
 *     temporary file... / ✅ Done) in addition to this module's requested
 *     block below — both appear, since that file isn't touched here.
 *   - telegram_sender.js's caption always includes a "Spotify:" labeled
 *     URL line (it wasn't renamed). This module passes the YouTube URL
 *     into that same slot so the line is at least meaningful, but the
 *     label itself still says "Spotify" and the line still appears even
 *     though the requested caption example has neither.
 *   Fixing either requires a small edit to telegram_sender.js, which this
 *   task's instructions place off-limits.
 */

const youtubeSearch = require("./youtube_search");
const youtubeDownloader = require("./youtube_downloader");
const telegramSender = require("./Telegram_sender");

const REGIONS = ["Kerala Trending", "India Trending", "Global Trending"];

/* ===== Top-1-per-region selection (same small, established pattern
 * already used elsewhere in the project — kept local so this module has
 * no dependency on the removed Spotify workflow) ===== */
function selectTop1PerRegion(results) {
  const top1 = { "Kerala Trending": null, "India Trending": null, "Global Trending": null };
  if (!Array.isArray(results)) return top1;

  for (const r of results) {
    const region = r.trendRegion && r.trendRegion.region;
    if (REGIONS.includes(region) && !top1[region]) {
      top1[region] = r;
    }
  }

  return top1;
}

/* ===== Console output (this task's requested block) ===== */
function printRegionHeader(region) {
  console.log(`\n${region}\n`);
}

function printSendingStart() {
  console.log("Sending MP3...");
}

function printSentSuccess() {
  console.log("\nSent successfully.");
}

function printCleaning() {
  console.log("\nCleaning temporary file...");
}

function printDone() {
  console.log("\nDone.");
}

function printSkippedAlreadySent(region) {
  printRegionHeader(region);
  console.log("Already sent previously — skipping.");
}

function printSkippedNoMatch(region, reason) {
  console.log(`Skipped: ${reason}`);
}

/* ===== Public API ===== */

/**
 * sendTop1TrendingViaYoutube(aiResearchResults)
 *
 * For each of Kerala/India/Global Trending's Top 1 candidate:
 *   1. Skip entirely if telegram_sender.js already recorded this audioId
 *      as sent (checked BEFORE searching/downloading).
 *   2. yt-dlp search (youtube_search.js) — skip this region on failure.
 *   3. yt-dlp download (youtube_downloader.js) — skip this region on failure.
 *   4. Hand off to telegram_sender.js's existing sendTop1ToTelegram(),
 *      which sends the MP3, records it in telegram_sent_db.json on
 *      success, deletes the temp file on success, and keeps it for retry
 *      on failure — all exactly as that module already does, unmodified.
 *
 * Every step is wrapped so a failure anywhere never stops the scraper —
 * it just skips to the next region.
 *
 * @param {Array} aiResearchResults - Results from audio_research_workflow.js
 *   (each item needs { audioId, title, artist, trendRegion: { region } })
 * @returns {Promise<object>} Per-region outcome, for logging/inspection.
 */
async function sendTop1TrendingViaYoutube(aiResearchResults) {
  const top1 = selectTop1PerRegion(aiResearchResults);
  const summary = {};

  for (const region of REGIONS) {
    const candidate = top1[region];
    if (!candidate) continue;

    try {
      // Skip the ENTIRE pipeline (no search, no download) for an audio
      // already sent — reuses telegram_sender.js's own duplicate-DB check.
      if (telegramSender.hasBeenSent(candidate.audioId)) {
        printSkippedAlreadySent(region);
        summary[region] = { sent: false, skipped: true, reason: "already sent" };
        continue;
      }

      printRegionHeader(region);

      // Step 1: yt-dlp search (youtube_search.js, unmodified)
      const searchResult = await youtubeSearch.searchYoutube({
        audioId: candidate.audioId,
        song: candidate.title,
        artist: candidate.artist,
      });

      if (!searchResult.found) {
        printSkippedNoMatch(region, `YouTube search failed (${searchResult.error || "no match"})`);
        summary[region] = { sent: false, skipped: false, error: searchResult.error || "search failed" };
        continue;
      }

      // Step 2: yt-dlp download (youtube_downloader.js, unmodified)
      const downloadResult = await youtubeDownloader.downloadFromYoutube({
        youtubeUrl: searchResult.youtubeUrl,
        title: candidate.title,
      });

      if (!downloadResult) {
        printSkippedNoMatch(region, "download failed");
        summary[region] = { sent: false, skipped: false, error: "download failed" };
        continue;
      }

      // Step 3: hand off to the existing, unmodified Telegram sender.
      // (spotifyTrackId/spotifyUrl are telegram_sender.js's existing
      // parameter names — carrying the YouTube video ID/URL here since
      // that file's interface wasn't renamed; see the header note above.)
      printSendingStart();

      const telegramResult = await telegramSender.sendTop1ToTelegram({
        audioId: candidate.audioId,
        title: candidate.title,
        artist: candidate.artist,
        region,
        externalTrackId: searchResult.youtubeId,
        externalUrl: searchResult.youtubeUrl,
        filePath: downloadResult.filePath,
      });

      if (telegramResult.sent) {
        printSentSuccess();
        printCleaning();
        printDone();
      } else if (telegramResult.skipped) {
        // Race condition guard: sent by something else between our
        // hasBeenSent() check and now — telegram_sender.js's own internal
        // check caught it. Nothing to clean up here; that module handles
        // its own state.
        console.log("\nAlready sent (caught by Telegram sender's own check) — skipping.");
      } else {
        console.log(`\n❌ Telegram send failed: ${telegramResult.error || "unknown error"}`);
        console.log("   MP3 kept for retry on the next run.");
      }

      summary[region] = telegramResult;
    } catch (e) {
      // Final safety net — every step above already catches its own
      // errors, but nothing here may ever stop the scraper.
      console.log(`\n❌ [${region}] Unexpected pipeline error, continuing scraper: ${e.message}`);
      summary[region] = { sent: false, skipped: false, error: e.message };
    }
  }

  return summary;
}

module.exports = { sendTop1TrendingViaYoutube, selectTop1PerRegion };