/**
 * trend_region_classifier.js — Evidence-Based Trend Region Scoring System.
 *
 * This module replaces the rule-based classifier with a weighted scoring system.
 * It combines evidence from Tavily (audio research) and Groq (comment analysis)
 * to calculate scores for Kerala, India, and Global regions.
 */

/* ===== Scoring Weights ===== */
const WEIGHTS = {
  LANGUAGE: {
    MALAYALAM: 1.0, // 1 point per 1% of comments
    TAMIL: 0.2,
    KANNADA: 0.2,
    HINDI: 0.1,
    ENGLISH: 0.05,
  },
  RESEARCH: {
    ORIGIN_KERALA: 50,
    ORIGIN_INDIA: 30, // Increased from 20 to strengthen regional signal
    LANGUAGE_MALAYALAM: 30,
    REGIONAL_ADOPTION: 20, // Points for "Popular in Kerala creators" etc.
  },
};

const INDIAN_REGIONS = new Set([
  "india", "kerala", "tamil nadu", "karnataka", "andhra pradesh", "telangana",
  "maharashtra", "gujarat", "punjab", "west bengal", "uttar pradesh", "bihar",
  "odisha", "assam", "chennai", "bangalore", "bengaluru", "mumbai", "delhi", "kochi"
]);

function normalize(value) {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

/**
 * calculateScores({ origin, country, songLanguage, languageDistribution, researchEvidence })
 *
 * Converts evidence into numerical scores for different regions.
 *
 * @returns {object} { scores: { Kerala, India, Global }, evidence: [], winner: string, confidence: number }
 */
function calculateScores({
  origin = null,
  country = null,
  songLanguage = null,
  languageDistribution = {},
  researchEvidence = [],
} = {}) {
  let keralaScore = 0;
  let indiaScore = 0;
  let globalScore = 0;
  const evidence = [];

  const normOrigin = normalize(origin);
  const normCountry = normalize(country);
  const normSongLang = normalize(songLanguage);

  // Detect if this is fundamentally an Indian track to prevent 'Global' fallback
  const isIndianOrigin = (normOrigin && INDIAN_REGIONS.has(normOrigin)) || 
                         (normCountry && INDIAN_REGIONS.has(normCountry));

  // --- 1. Comment Language Evidence (Groq) ---
  if (languageDistribution && typeof languageDistribution === "object") {
    for (const [lang, pct] of Object.entries(languageDistribution)) {
      const normLang = normalize(lang);
      const weight = WEIGHTS.LANGUAGE[normLang?.toUpperCase()] || 0;
      
      if (normLang === "malayalam") {
        keralaScore += pct * WEIGHTS.LANGUAGE.MALAYALAM;
        evidence.push(`Malayalam Comments: ${pct}%`);
      } else if (weight > 0) {
        indiaScore += pct * weight;
      }
    }
  }

  // --- 2. Research Evidence (Tavily) ---
  if (normOrigin === "kerala") {
    keralaScore += WEIGHTS.RESEARCH.ORIGIN_KERALA;
    indiaScore += WEIGHTS.RESEARCH.ORIGIN_INDIA;
    evidence.push(`Audio Origin: Kerala`);
  } else if (normOrigin && (INDIAN_REGIONS.has(normOrigin))) {
    indiaScore += WEIGHTS.RESEARCH.ORIGIN_INDIA;
    evidence.push(`Audio Origin: ${origin}`);
  } else if (normCountry === "india") {
    indiaScore += WEIGHTS.RESEARCH.ORIGIN_INDIA;
    evidence.push(`Audio Country: India`);
  } else if (normCountry && normCountry !== "india" && !isIndianOrigin) {
    // ONLY award Global points if we haven't already identified this as Indian
    globalScore += 50;
    evidence.push(`Audio Country: ${country}`);
  }

  if (normSongLang === "malayalam") {
    keralaScore += WEIGHTS.RESEARCH.LANGUAGE_MALAYALAM;
    evidence.push(`Song Language: Malayalam`);
  }

  // Scan research evidence for specific keywords
  const researchText = researchEvidence.join(" ").toLowerCase();
  if (researchText.includes("kerala") || researchText.includes("malayalam edits")) {
    keralaScore += WEIGHTS.RESEARCH.REGIONAL_ADOPTION;
    evidence.push(`Tavily found Kerala creator adoption`);
  }

  // --- 3. Final Decision ---
  const scores = {
    Kerala: Math.round(keralaScore),
    India: Math.round(indiaScore),
    Global: Math.round(globalScore),
  };

  let region = "Unknown";
  let maxScore = -1;

  for (const [regName, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      region = `${regName} Trending`;
    }
  }

  if (maxScore === 0) region = "Unknown";

  // Confidence is a simple ratio of winner vs others (capped at 99%)
  const totalScore = keralaScore + indiaScore + globalScore;
  const confidence = totalScore > 0 
    ? Math.min(99, Math.round((maxScore / totalScore) * 100)) 
    : 0;

  return {
    scores,
    evidence,
    region,
    confidence: `${confidence}%`,
  };
}

module.exports = { calculateScores };

/* ===== Self-test / manual verification ===== */
if (require.main === module) {
  const testCases = [
    {
      name: "Strong Kerala",
      origin: "Tamil Nadu",
      country: "India",
      songLanguage: "Tamil",
      languageDistribution: { "Malayalam": 82, "Tamil": 12, "English": 6 },
      researchEvidence: ["Popular among Kerala Instagram creators"],
    },
    {
      name: "Strong India",
      origin: "Maharashtra",
      country: "India",
      songLanguage: "Hindi",
      languageDistribution: { "Hindi": 70, "English": 30 },
      researchEvidence: [],
    },
    {
      name: "Global",
      origin: "California",
      country: "United States",
      songLanguage: "English",
      languageDistribution: { "English": 100 },
      researchEvidence: [],
    }
  ];

  testCases.forEach(tc => {
    console.log(`
--- Test: ${tc.name} ---`);
    const res = calculateScores(tc);
    console.log(`Winner: ${res.winner}`);
    console.log(`Scores:`, res.scores);
    console.log(`Evidence:`, res.evidence);
    console.log(`Confidence: ${res.confidence}`);
  });
}
