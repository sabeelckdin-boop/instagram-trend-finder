/**
 * trend_summary_printer.js — Redesigned Phase 5 console output.
 *
 * STANDALONE / ADDITIVE — pure formatting/printing. Makes no API calls,
 * touches no cache file, and does not modify prediction/diffusion logic,
 * discovery, replay, growth calculation, reporting, or comment_analysis.js
 * (its own "PHASE 5: COMMENT ANALYSIS" console block is untouched — this
 * is a separate, new phase's output).
 *
 * Groups candidates by their deterministic trend_region_classifier.js
 * result and prints a bordered, numbered summary:
 *
 * ═══════════════════════════════════════════════════════
 * 🔥 FINAL TREND SUMMARY
 * ═══════════════════════════════════════════════════════
 *
 * 🟢 KERALA TRENDING (4)
 *
 * 1. Aathi
 *    Artist   : Sai Abhyankkar
 *    Origin   : Tamil Nadu
 *    Audience : Malayalam (82%)
 * ...
 *
 * followed by a stats footer (new Tavily researches / loaded from cache /
 * Groq analyses).
 */

const BORDER = "═".repeat(59);
const REGION_ORDER = [
  { key: "Kerala Trending", emoji: "🟢", label: "KERALA TRENDING" },
  { key: "India Trending", emoji: "🟡", label: "INDIA TRENDING" },
  { key: "Global Trending", emoji: "🌍", label: "GLOBAL TRENDING" },
  { key: "Unknown", emoji: "⚪", label: "UNCLASSIFIED" },
];

/* ===== Helpers ===== */
function formatAudienceLine(commentLanguage) {
  if (!commentLanguage) return null;
  const { primaryLanguage, confidence } = commentLanguage;
  if (!primaryLanguage || primaryLanguage === "Unknown") return null;
  const pct = typeof confidence === "number" ? Math.round(confidence * 100) : null;
  return pct !== null ? `${primaryLanguage} (${pct}%)` : primaryLanguage;
}

function printGroup(group, candidates) {
  console.log(`\n${group.emoji} ${group.label} (${candidates.length})\n`);

  candidates.forEach((c, i) => {
    const tr = c.trendRegion || {};
    
    // Use Shazam data if available and recognized
    const isShazamed = c.shazamRecognition && c.shazamRecognition.status === "recognized";
    const displayTitle = isShazamed 
      ? `${c.shazamRecognition.title || c.title || "Untitled"} [SHAZAMED]` 
      : (c.title || "Untitled");
    const displayArtist = isShazamed 
      ? (c.shazamRecognition.artist || c.artist || "Unknown") 
      : (c.artist || "Unknown");

    console.log(`${i + 1}. ${displayTitle}`);
    console.log(`   Artist   : ${displayArtist}`);
    
    if (tr.scores) {
      const s = tr.scores;
      console.log(`   Scores   : Kerala:${s.Kerala} | India:${s.India} | Global:${s.Global}`);
    }

    if (tr.evidence && tr.evidence.length > 0) {
      console.log(`   Evidence : ${tr.evidence.join(", ")}`);
    }
    
    if (tr.confidence) {
      console.log(`   Confidence: ${tr.confidence}`);
    }

    const audience = formatAudienceLine(c.commentLanguage);
    if (audience) {
      console.log(`   Audience : ${audience}`);
    }
    if (i < candidates.length - 1) console.log("");
  });

  console.log(`\n${BORDER}`);
}

/* ===== Public API ===== */

/**
 * printTrendSummary(candidates)
 *
 * @param {Array} candidates - Array of enriched candidate objects:
 *   {
 *     title, artist,
 *     origin, country,
 *     trendRegion: { region },
 *     commentLanguage: { primaryLanguage, confidence },
 *     originFromCache, commentLanguageFromCache, groqCalled
 *   }
 *   (this is exactly the shape candidate_cache.getCandidateAnalysis()
 *   returns, merged with { title, artist } from the report row.)
 */
function printTrendSummary(candidates) {
  console.log(`\n${BORDER}`);
  console.log("🔥 FINAL TREND SUMMARY");
  console.log(BORDER);

  if (!candidates || candidates.length === 0) {
    console.log("\n   No candidates to summarize.\n");
    console.log(BORDER);
    return;
  }

  const grouped = new Map(REGION_ORDER.map(r => [r.key, []]));
  for (const c of candidates) {
    const region = (c.trendRegion && c.trendRegion.region) || "Unknown";
    if (!grouped.has(region)) grouped.set(region, []);
    grouped.get(region).push(c);
  }

  let printedAny = false;
  for (const groupDef of REGION_ORDER) {
    const list = grouped.get(groupDef.key);
    if (!list || list.length === 0) continue;
    printGroup(groupDef, list);
    printedAny = true;
  }

  if (!printedAny) {
    console.log("\n   No candidates to summarize.\n");
    console.log(BORDER);
  }

  // ===== Stats footer =====
  const newTavilyResearches = candidates.filter(c => c.originFromCache === false).length;
  const loadedFromCache = candidates.filter(c => c.fullyFromCache === true).length;
  const groqAnalyses = candidates.filter(c => c.groqCalled === true).length;

  console.log(`\nNew Tavily researches : ${newTavilyResearches}`);
  console.log(`Loaded from cache      : ${loadedFromCache}`);
  console.log(`Groq analyses          : ${groqAnalyses}`);
}

module.exports = { printTrendSummary };