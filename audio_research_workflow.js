/**
 * audio_research_workflow.js — Phase: AI Research Preview over Top
 * Candidates (Tavily origin + Groq comment language + deterministic trend
 * region), console output via trend_summary_printer.js.
 *
 * STANDALONE / ADDITIVE — does not modify gittest.js's prediction or
 * diffusion logic, does not modify comment_analysis.js (only calls its
 * already-exported, unmodified fetchComments()/getMediaIdForRow()), and
 * does not modify report rows. This module only READS the report after
 * the diffusion engine has already run.
 *
 * Candidate selection intentionally mirrors comment_analysis.js's
 * selectCandidates() (top N by diffusion score, backfilled by predictive
 * score) rather than importing/calling it, so this module never has to
 * touch comment_analysis.js's internals.
 *
 * Per candidate:
 *   1. Fetch up to 30 comments (reusing comment_analysis.js's existing
 *      fetchComments()/getMediaIdForRow() — read-only reuse, no changes
 *      to that file).
 *   2. Run getCandidateAnalysis() (candidate_cache.js, Task 6) — cache-
 *      first origin lookup (Tavily), comment language (Groq), and
 *      deterministic trend-region classification, permanently cached per
 *      ISRC/audioId so a candidate already analyzed makes zero new API
 *      calls.
 *   3. Hand the enriched results to trend_summary_printer.js for the
 *      final grouped, bordered console summary.
 */

const { getMediaIdForRow, fetchComments } = require("./comment_analysis");
const { getCandidateAnalysis } = require("./candidate_cache");
const { printTrendSummary } = require("./Trend_summary_printer");

const TOP_N = 9;

/* ===== Candidate selection (mirrors comment_analysis.js's logic) ===== */
function selectTopCandidates(report) {
  if (!report || report.length === 0) return [];

  const scored = report.filter(
    r => r.diffusion && typeof r.diffusion.diffusionScore === "number"
  );

  const sorted = [...scored].sort(
    (a, b) => (b.diffusion.diffusionScore || 0) - (a.diffusion.diffusionScore || 0)
  );

  const candidates = sorted.slice(0, TOP_N);

  if (candidates.length < TOP_N) {
    const existingIds = new Set(candidates.map(r => r.id));
    const byPredictive = [...report]
      .filter(r => !existingIds.has(r.id))
      .sort((a, b) => (b.predictiveScore || 0) - (a.predictiveScore || 0));

    const fillers = byPredictive.slice(0, TOP_N - candidates.length);
    candidates.push(...fillers);
  }

  return candidates;
}

/* ===== Public API ===== */

/**
 * runTopCandidateResearch(report, page, context, captured)
 *
 * Only ever called AFTER the diffusion engine has attached `diffusion` to
 * each report row (i.e. after run()'s diffusion-scoring step in
 * gittest.js). page/context/captured mirror runCommentAnalysis()'s own
 * signature and are used only to fetch comments (via comment_analysis.js's
 * existing exported helpers) and to resolve a media ID when a row's
 * firstSeenPost is missing.
 *
 * Wrapped so a failure for one candidate (or the whole phase) can never
 * break the main run — every error is caught and logged, not thrown.
 *
 * @param {Array} report - The predictive report, after diffusion scoring
 * @param {object} [page] - Playwright page (for apiContext / cookies)
 * @param {object} [context] - Playwright browser context (for cookies())
 * @param {object} [captured] - Captured API request template (replay fallback)
 * @returns {Promise<Array>} The enriched candidate results, for
 *   callers/tests that want the data rather than just the console output
 */
async function runTopCandidateResearch(report, page, context, captured) {
  console.log("\n" + "=".repeat(60));
  console.log("🌐 PHASE: AI RESEARCH (Tavily origin + Groq comment language, cache-first)");
  console.log("   Top 9 candidates from the diffusion/prediction engine");
  console.log("=".repeat(60));

  const candidates = selectTopCandidates(report);

  if (candidates.length === 0) {
    console.log("   ⚠️ No candidates with a diffusion/predictive score yet — skipping.");
    return [];
  }

  console.log(`   Candidates selected: ${candidates.length}`);

  const apiContext = page ? page.request : null;
  let cookies = [];
  try {
    cookies = context ? await context.cookies() : [];
  } catch (e) {
    cookies = [];
  }

  const results = [];

  for (const row of candidates) {
    try {
      const artistHint = row.shazamRecognition && row.shazamRecognition.status === "recognized"
        ? row.shazamRecognition.artist
        : null;
      const isrcHint = row.shazamRecognition && row.shazamRecognition.status === "recognized"
        ? row.shazamRecognition.isrc
        : null;

      // Fetch comments — read-only reuse of comment_analysis.js's own
      // exported helpers, no changes to that file.
      let comments = [];
      try {
        const { mediaId } = await getMediaIdForRow(row, apiContext, captured);
        if (mediaId) {
          comments = await fetchComments(apiContext, cookies, mediaId);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not fetch comments for "${row.title || row.id}": ${e.message}`);
      }

      const analysis = await getCandidateAnalysis({
        audioId: row.id,
        isrc: isrcHint,
        title: row.title,
        artist: artistHint,
        comments,
      });

      results.push({
        audioId: analysis.cacheKey,
        title: row.title,
        artist: analysis.artist,
        origin: analysis.origin,
        country: analysis.country,
        trendRegion: analysis.trendRegion,
        commentLanguage: analysis.commentLanguage,
        fullyFromCache: analysis.fullyFromCache,
        originFromCache: analysis.originFromCache,
        commentLanguageFromCache: analysis.commentLanguageFromCache,
        groqCalled: analysis.groqCalled,
      });
    } catch (e) {
      console.log(`\n   ⚠️ Analysis failed for "${row.title || row.id}": ${e.message}`);
    }
  }

  printTrendSummary(results);

  return results;
}

module.exports = { runTopCandidateResearch, selectTopCandidates };