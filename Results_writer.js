/**
 * results_writer.js — Writes the improved comment_analysis_results.json.
 *
 * STANDALONE / ADDITIVE — pure formatting + file write. Makes no API
 * calls, doesn't touch audio_ai_cache.json, and does not modify
 * comment_analysis.js's code (that file's own, differently-shaped write
 * to the same path happens earlier in run(); this module's write — called
 * afterward — is what makes the final file use the improved schema. See
 * the call-site comment in gittest.js for the exact ordering.)
 *
 * Output shape, one object per analyzed audio, exactly as requested:
 * {
 *   "audioId": "",
 *   "title": "",
 *   "artist": "",
 *   "origin": "",
 *   "commentLanguage": "",
 *   "trendRegion": "",
 *   "confidence": 0.94,
 *   "reason": "",
 *   "cache": { "origin": true, "comments": true },
 *   "analysisTime": ""
 * }
 *
 * File is pretty-printed (2-space indent) for human readability, and
 * written atomically (write-to-temp + rename) to avoid a half-written
 * file if the process is interrupted mid-write.
 */

const fs = require("fs");

// FIX (bug): comment_analysis.js writes its own version of this file to
// the cwd-relative path "./comment_analysis_results.json" (resolved
// against process.cwd() at runtime, NOT against its own script
// directory). This module's write is only guaranteed to land on the same
// file — which is the entire point, since it runs after Phase 5 to make
// the improved schema what's actually left on disk — if it resolves the
// default path the same way. Using path.join(__dirname, ...) here instead
// would silently write to a *different* file whenever the process is
// launched from a working directory other than the script's own folder
// (e.g. a cron job, pm2, or `cd elsewhere && node /path/to/gittest.js`),
// leaving the stale legacy-schema file untouched at the path anyone
// actually checks.
const DEFAULT_FILE = "./comment_analysis_results.json";

function atomicWriteSync(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

/**
 * Build one clean record from a candidate_cache-enriched result (as
 * collected by audio_research_workflow.js's runTopCandidateResearch()).
 */
function buildRecord(result) {
  const commentLanguage = result.commentLanguage || {};
  const trendRegion = result.trendRegion || {};

  return {
    audioId: result.audioId || "",
    title: result.title || "",
    artist: result.artist || "",
    origin: result.origin || result.country || "",
    commentLanguage: commentLanguage.primaryLanguage && commentLanguage.primaryLanguage !== "Unknown"
      ? commentLanguage.primaryLanguage
      : "",
    trendRegion: trendRegion.region || "Unknown",
    confidence: typeof commentLanguage.confidence === "number" ? commentLanguage.confidence : 0,
    reason: trendRegion.reason || "",
    cache: {
      origin: Boolean(result.originFromCache),
      comments: Boolean(result.commentLanguageFromCache),
    },
    analysisTime: new Date().toISOString(),
  };
}

/**
 * writeCommentAnalysisResults(results, filePath)
 *
 * @param {Array} results - Enriched candidate results, as returned by
 *   audio_research_workflow.js's runTopCandidateResearch()
 * @param {string} [filePath] - Defaults to comment_analysis_results.json
 *   next to this module (same file comment_analysis.js also writes to —
 *   see header comment on ordering).
 * @returns {Array} The records actually written, for callers/tests
 */
function writeCommentAnalysisResults(results, filePath = DEFAULT_FILE) {
  const records = Array.isArray(results) ? results.map(buildRecord) : [];

  atomicWriteSync(filePath, JSON.stringify(records, null, 2));
  console.log(`\n📄 Comment analysis results (improved schema) saved to ${filePath} (${records.length} audio${records.length === 1 ? "" : "s"})`);

  return records;
}

module.exports = { writeCommentAnalysisResults, buildRecord };