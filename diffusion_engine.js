/**
 * diffusion_engine.js — v6 Pre-Viral Diffusion Engine (additive companion to scrape.js)
 *
 * Contract with scrape.js (DO NOT change these signatures — scrape.js calls
 * them exactly as follows):
 *
 *   diffusionEngine.extractAdoptionSightings(json)
 *     -> array of { idKey, title, audioClusterId, audioAssetId, creatorId, time, engagement }
 *     Called once per intercepted Following-Feed JSON payload (the SAME
 *     parsed object scrape.js's own extractAudioWithMetadata() walks). Must
 *     log EVERY reel sighting found in the payload (not just first-seen —
 *     that de-duplication happens later), because repeat sightings of the
 *     same audio from different creators are exactly the adoption signal
 *     this engine is built on.
 *
 *   diffusionEngine.mergeAdoptionSightings(db, sightings)
 *     -> number of newly-added (deduplicated) sighting rows
 *     Mutates `db` in place: ensures db[idKey].adoptionEvents exists and
 *     appends only sightings not already present (dedup by time+creator).
 *     If db[idKey] does not exist yet (adoption sightings can arrive before
 *     Phase 3 ever creates the "official" DB row), creates a minimal stub
 *     with `history: []` so Phase 3's `if (!db[data.idKey])` check in
 *     scrape.js correctly treats it as already-existing and only appends to
 *     history — adoptionEvents survive untouched.
 *
 *   diffusionEngine.generateDiffusionReport(db, { NICHE_MAP_FILE })
 *     -> { diffusionByIdKey: { [idKey]: diffusionObject | null }, duplicateReviewQueue: [...] }
 *     Pure read of `db` (does not mutate it). Computes, per audio: creator
 *     diffusion / diversity, niche entropy, single-source detection, a
 *     practical Hawkes branching-ratio approximation, a gated Bass-diffusion
 *     fit (only attempted with enough history), remaining growth upside, a
 *     normalized 0-100 diffusionScore, a 0-1 confidence, and a regimeLabel.
 *     Also emits a queue of likely duplicate-title audio pairs for manual
 *     review.
 *
 * Deliberately NOT implemented (out of scope / would require data this
 * engine does not have access to):
 *   - No follower-count-weighted reach modeling (would require profile
 *     scraping, which this engine explicitly avoids).
 *   - No true maximum-likelihood Hawkes fit (kernel bandwidth + branching
 *     ratio are jointly estimated here via a bounded closed-form heuristic
 *     instead of MLE/EM, which would need a proper optimizer dependency).
 *   - No nonlinear-least-squares Bass fit (a bounded deterministic grid
 *     search is used instead — no external numerical libraries allowed).
 *   - No cross-audio network/graph propagation model (each audio's
 *     diffusion is scored independently from its own adoption events).
 *
 * Design principles:
 *   - Every exported function is wrapped so it can never throw — malformed,
 *     missing, or partial data degrades gracefully to sane defaults (null /
 *     0 / empty array) rather than crashing the caller's run.
 *   - No external APIs, no additional npm packages, no network requests.
 *   - Deterministic given identical input (the only non-determinism is a
 *     `Date.now()` fallback used solely when an individual sighting/event
 *     is missing its own timestamp — a graceful-degradation path, not part
 *     of the scoring math itself).
 */

const fs = require("fs");
const crypto = require("crypto");

/* ================================================================
   Generic utilities
   ================================================================ */

function hashString(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
}

function round4(x) {
  return (typeof x === "number" && isFinite(x)) ? Math.round(x * 10000) / 10000 : x;
}

function isFiniteNumber(x) {
  return typeof x === "number" && isFinite(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

/* ================================================================
   1. extractAdoptionSightings
   ================================================================
   Walks an intercepted Instagram JSON payload (already parsed by the
   caller) looking for reel items that carry both a creator identity and
   an audio reference, and emits one adoption-event sighting per match.
   Mirrors the shape of audio detection scrape.js already performs in
   extractAudioWithMetadata()/normalizeAudio(), including the exact idKey
   derivation (`clusterId || assetId || "title:" + sha1(title).slice(0,12)`)
   so sightings merge cleanly into the same DB rows scrape.js maintains.
   ================================================================ */

function getEngagementFromMediaItem(obj) {
  const keys = ["like_count", "comment_count", "play_count", "ig_play_count", "view_count", "reshare_count"];
  let total = 0;
  let found = false;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && isFinite(v)) {
      total += v;
      found = true;
    }
  }
  return found ? total : null;
}

function extractAdoptionSightings(json) {
  const sightings = [];
  if (json == null || typeof json !== "object") return sightings;

  function pushSighting(rawAudioObj, mediaCtx) {
    try {
      if (!rawAudioObj || !mediaCtx) return;
      const title =
        rawAudioObj.title ||
        rawAudioObj.music_asset_info?.title ||
        rawAudioObj.original_sound_info?.original_audio_title ||
        rawAudioObj.original_sound_info?.title ||
        null;

      const clusterId = rawAudioObj.music_asset_info?.audio_cluster_id || rawAudioObj.audio_cluster_id || null;
      const assetId = rawAudioObj.original_sound_info?.audio_asset_id || rawAudioObj.audio_asset_id || null;

      if (!title && !clusterId && !assetId) return;

      const idKey = clusterId || assetId || (title ? `title:${hashString(title)}` : null);
      if (!idKey) return;

      sightings.push({
        idKey,
        title: title || "Unknown",
        audioClusterId: clusterId || null,
        audioAssetId: assetId || null,
        creatorId: mediaCtx.creatorUsername || null,
        time: isFiniteNumber(mediaCtx.takenAtMs) ? mediaCtx.takenAtMs : Date.now(),
        engagement: isFiniteNumber(mediaCtx.engagement) ? mediaCtx.engagement : null,
      });
    } catch (e) { /* never let a single malformed node break extraction */ }
  }

  function walk(obj, depth) {
    if (depth > 80 || obj == null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }

    try {
      let mediaCtx = null;
      const username = obj.user?.username || obj.owner?.username || null;
      if (obj.code && username) {
        const takenAtSec = obj.taken_at || obj.taken_at_timestamp || null;
        mediaCtx = {
          creatorUsername: username,
          takenAtMs: isFiniteNumber(takenAtSec) ? takenAtSec * 1000 : Date.now(),
          engagement: getEngagementFromMediaItem(obj),
        };
      }

      if (mediaCtx) {
        if (obj.clips_metadata?.music_info?.music_asset_info) {
          pushSighting({ music_asset_info: obj.clips_metadata.music_info.music_asset_info }, mediaCtx);
        }
        if (obj.clips_metadata?.original_sound_info?.audio_asset_id) {
          pushSighting({ original_sound_info: obj.clips_metadata.original_sound_info }, mediaCtx);
        }
        if (obj.music_info?.music_asset_info) {
          pushSighting({ music_asset_info: obj.music_info.music_asset_info }, mediaCtx);
        }
        if (obj.original_sound_info?.audio_asset_id) {
          pushSighting({ original_sound_info: obj.original_sound_info }, mediaCtx);
        }
      }
    } catch (e) { /* keep walking siblings even if this node is malformed */ }

    for (const v of Object.values(obj)) walk(v, depth + 1);
  }

  try {
    walk(json, 0);
  } catch (e) { /* return whatever was collected before the failure */ }

  return sightings;
}

/* ================================================================
   2. mergeAdoptionSightings
   ================================================================ */

function mergeAdoptionSightings(db, sightings) {
  if (!db || typeof db !== "object") return 0;
  const list = safeArray(sightings);
  if (list.length === 0) return 0;

  let added = 0;
  const existingKeyCache = new Map(); // idKey -> Set of "time|creatorId" dedup keys

  function getExistingKeySet(idKey) {
    if (existingKeyCache.has(idKey)) return existingKeyCache.get(idKey);
    const set = new Set();
    const events = safeArray(db[idKey] && db[idKey].adoptionEvents);
    for (const e of events) {
      if (e) set.add(`${e.time}|${e.creatorId}`);
    }
    existingKeyCache.set(idKey, set);
    return set;
  }

  for (const s of list) {
    try {
      if (!s || !s.idKey) continue;
      const idKey = s.idKey;

      if (!db[idKey]) {
        db[idKey] = {
          idKey,
          title: s.title || "Unknown audio",
          audioClusterId: s.audioClusterId || null,
          audioAssetId: s.audioAssetId || null,
          firstSeenCreator: s.creatorId || null,
          firstSeenPost: null,
          takenAt: isFiniteNumber(s.time) ? Math.floor(s.time / 1000) : null,
          firstSeenTime: Date.now(),
          history: [],
          adoptionEvents: [],
        };
        existingKeyCache.set(idKey, new Set());
      }

      if (!Array.isArray(db[idKey].adoptionEvents)) {
        db[idKey].adoptionEvents = [];
        existingKeyCache.set(idKey, new Set());
      }

      const time = isFiniteNumber(s.time) ? s.time : Date.now();
      const creatorId = s.creatorId || null;
      const engagement = isFiniteNumber(s.engagement) ? s.engagement : null;
      const dedupKey = `${time}|${creatorId}`;

      const seen = getExistingKeySet(idKey);
      if (!seen.has(dedupKey)) {
        db[idKey].adoptionEvents.push({ time, creatorId, engagement });
        seen.add(dedupKey);
        added++;
      }
    } catch (e) { /* skip this sighting, keep processing the rest */ }
  }

  return added;
}

/* ================================================================
   3. generateDiffusionReport — internal helpers
   ================================================================ */

function loadNicheMap(nicheMapFile) {
  try {
    const file = nicheMapFile || "./creator_niches.json";
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {}; // missing / malformed niche map is always non-fatal
  }
}

/* ---- Creator diversity / single-source detection ---- */

function computeCreatorDiversity(sortedEvents) {
  const creators = sortedEvents.map(e => e.creatorId).filter(Boolean);
  const total = creators.length;

  if (total === 0) {
    return { uniqueCreators: 0, creatorDiversity: 0, maxCreatorShare: 0, singleSourceFlag: false, creatorCounts: {} };
  }

  const counts = {};
  for (const c of creators) counts[c] = (counts[c] || 0) + 1;

  const uniqueCreators = Object.keys(counts).length;
  const maxCount = Math.max(...Object.values(counts));
  const maxCreatorShare = maxCount / total;
  const creatorDiversity = uniqueCreators / total; // 1.0 = every sighting a distinct creator

  const singleSourceFlag = (uniqueCreators <= 2 && total >= 3) || maxCreatorShare >= 0.75;

  return { uniqueCreators, creatorDiversity, maxCreatorShare, singleSourceFlag, creatorCounts: counts };
}

/* ---- Niche entropy ---- */

function computeNicheEntropy(sortedEvents, nicheMap) {
  const creators = sortedEvents.map(e => e.creatorId).filter(Boolean);
  if (creators.length === 0) {
    return { nicheEntropy: 0, nicheEntropyNormalized: 0, nicheCount: 0 };
  }

  const niches = creators.map(c => (nicheMap && nicheMap[c]) || "unknown");
  const counts = {};
  for (const n of niches) counts[n] = (counts[n] || 0) + 1;

  const total = niches.length;
  let entropy = 0;
  for (const k of Object.keys(counts)) {
    const p = counts[k] / total;
    entropy += -p * Math.log2(p);
  }

  const nicheCount = Object.keys(counts).length;
  const maxEntropy = nicheCount > 1 ? Math.log2(nicheCount) : 1;
  const normalized = maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 0;

  return { nicheEntropy: round4(entropy), nicheEntropyNormalized: round4(normalized), nicheCount };
}

/* ---- Hawkes branching-ratio approximation ----
   Practical heuristic (not MLE): builds an exponential self-excitation
   kernel whose half-life adapts to the observed mean inter-arrival gap,
   then estimates the branching ratio as the average, capped-at-1,
   excitation each event receives from all prior events. A ratio near 1
   indicates a near-critical/explosive cascade (classic pre-viral signal);
   a ratio near 0 indicates independent, unrelated arrivals. */

function estimateHawkesBranchingRatio(sortedTimesMs) {
  const times = safeArray(sortedTimesMs).filter(isFiniteNumber);
  const n = times.length;
  if (n < 3) return { branchingRatio: null, halfLifeHoursUsed: null };

  const gapsHours = [];
  for (let i = 1; i < n; i++) {
    const g = (times[i] - times[i - 1]) / 3600000;
    if (g > 0) gapsHours.push(g);
  }
  const meanGapHours = gapsHours.length ? gapsHours.reduce((a, b) => a + b, 0) / gapsHours.length : 1;
  const halfLifeHours = Math.max(0.25, meanGapHours);
  const lambda = Math.log(2) / halfLifeHours;

  let totalExcitation = 0;
  for (let i = 1; i < n; i++) {
    let excitation = 0;
    for (let j = 0; j < i; j++) {
      const dtHours = (times[i] - times[j]) / 3600000;
      if (dtHours >= 0) excitation += Math.exp(-lambda * dtHours);
    }
    totalExcitation += Math.min(1, excitation); // cap each event's contribution at one "triggered unit"
  }

  const branchingRatio = Math.max(0, Math.min(0.99, totalExcitation / (n - 1)));
  return { branchingRatio: round4(branchingRatio), halfLifeHoursUsed: round4(halfLifeHours) };
}

/* ---- Bass diffusion parameter estimation (gated, grid-search) ----
   Only attempted when there is enough history to make the fit meaningful.
   Uses a bounded deterministic grid search over (m, p, q) since no
   external numerical optimization packages are permitted. */

function bassCumulativeFraction(tDays, p, q) {
  const sum = p + q;
  const expTerm = Math.exp(-sum * tDays);
  const denom = 1 + (q / p) * expTerm;
  return denom !== 0 ? (1 - expTerm) / denom : 0;
}

function estimateBassParameters(sortedHistory) {
  const hist = safeArray(sortedHistory).filter(h => h && isFiniteNumber(h.time) && isFiniteNumber(h.count));
  if (hist.length < 4) return null; // gated: not enough snapshots to identify p, q, m

  const t0 = hist[0].time;
  const points = hist
    .map(h => ({ tDays: (h.time - t0) / 3600000 / 24, count: Math.max(0, h.count) }))
    .filter(p => p.tDays >= 0);

  if (points.length < 4) return null;

  const lastCount = points[points.length - 1].count;
  const totalSpanHours = points[points.length - 1].tDays * 24;
  if (lastCount <= 0 || totalSpanHours < 1) return null; // need real signal + real time spread

  const mCandidates = [1.1, 1.3, 1.6, 2, 3, 5, 8, 12, 20].map(mult => lastCount * mult);
  const pCandidates = [0.0005, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1];
  const qCandidates = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0];

  let best = null;
  for (const m of mCandidates) {
    for (const p of pCandidates) {
      for (const q of qCandidates) {
        let sse = 0;
        for (const pt of points) {
          const predicted = bassCumulativeFraction(pt.tDays, p, q) * m;
          const err = predicted - pt.count;
          sse += err * err;
        }
        if (best === null || sse < best.sse) best = { sse, m, p, q };
      }
    }
  }
  if (!best) return null;

  const rmse = Math.sqrt(best.sse / points.length);
  const fitQuality = Math.max(0, Math.min(1, 1 - rmse / lastCount));

  return {
    m: Math.round(best.m),
    p: round4(best.p),
    q: round4(best.q),
    fitQuality: round4(fitQuality),
    currentCount: lastCount,
  };
}

/* ---- Diffusion score, confidence, regime ---- */

function computeDiffusionScore({ branchingRatio, creatorDiversity, nicheEntropyNormalized, remainingUpsideRatio, singleSourceFlag, maxCreatorShare }) {
  const br = branchingRatio !== null && branchingRatio !== undefined ? Math.min(1, Math.max(0, branchingRatio)) : 0;
  const cd = isFiniteNumber(creatorDiversity) ? Math.min(1, Math.max(0, creatorDiversity)) : 0;
  const ne = isFiniteNumber(nicheEntropyNormalized) ? Math.min(1, Math.max(0, nicheEntropyNormalized)) : 0;

  // FIX (logic): remainingUpsideRatio needs a Bass-curve fit, which itself
  // needs >=4 history snapshots — unavailable for exactly the early-stage,
  // pre-viral audios this engine exists to catch. It used to default to 0
  // and still consume its full 30-point weight, so ANY audio without
  // enough history was hard-capped at 70/100 (35+20+15) even with a
  // perfect branching ratio, creator diversity, and niche entropy. Now,
  // when it's unavailable, its weight is redistributed across the signals
  // that ARE available, so early audios are judged on what's actually
  // known about them rather than being penalized for not yet having a
  // signal that structurally can't exist yet.
  const hasUpside = isFiniteNumber(remainingUpsideRatio);
  const ru = hasUpside ? Math.min(1, Math.max(0, remainingUpsideRatio)) : 0;

  const WEIGHTS = { br: 35, cd: 20, ne: 15, ru: 30 };
  const totalWeight = WEIGHTS.br + WEIGHTS.cd + WEIGHTS.ne + (hasUpside ? WEIGHTS.ru : 0);
  let score = ((br * WEIGHTS.br) + (cd * WEIGHTS.cd) + (ne * WEIGHTS.ne) + (ru * WEIGHTS.ru)) / totalWeight * 100;

  if (singleSourceFlag) score *= 0.4;
  else if (isFiniteNumber(maxCreatorShare) && maxCreatorShare > 0.5) score *= 0.75;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeConfidence({ totalEvents, spanHours, bassFitQuality, uniqueCreators }) {
  const eventFactor = Math.min(1, (totalEvents || 0) / 10);
  const spanFactor = Math.min(1, (spanHours || 0) / 48);
  const creatorFactor = Math.min(1, (uniqueCreators || 0) / 6);
  const bassFactor = isFiniteNumber(bassFitQuality) ? bassFitQuality : 0.2;
  return round4(eventFactor * 0.35 + spanFactor * 0.25 + creatorFactor * 0.2 + bassFactor * 0.2);
}

function classifyRegime({ hasEnoughData, singleSourceFlag, branchingRatio, bass, uniqueCreators }) {
  if (!hasEnoughData) return "Insufficient Data";
  if (singleSourceFlag) return "Single Source";

  if (bass && isFiniteNumber(bass.fitQuality) && bass.fitQuality >= 0.3 && bass.m > 0) {
    const saturation = bass.currentCount / bass.m;
    if (saturation >= 0.65) return "Saturating";
  }

  if (branchingRatio !== null && branchingRatio !== undefined && branchingRatio >= 0.55 && uniqueCreators >= 4) {
    return "Accelerating";
  }

  if (uniqueCreators >= 3) return "Emerging";

  return "Nascent";
}

/* ---- Per-audio computation ---- */

function computeDiffusionForAudio(idKey, rec, nicheMap) {
  const rawEvents = safeArray(rec && rec.adoptionEvents).filter(e => e && isFiniteNumber(e.time));
  const sortedEvents = [...rawEvents].sort((a, b) => a.time - b.time);
  const totalEvents = sortedEvents.length;

  const history = safeArray(rec && rec.history)
    .filter(h => h && isFiniteNumber(h.time) && isFiniteNumber(h.count))
    .sort((a, b) => a.time - b.time);

  const diversity = computeCreatorDiversity(sortedEvents);
  const nicheInfo = computeNicheEntropy(sortedEvents, nicheMap);

  const eventTimes = sortedEvents.map(e => e.time);
  const hawkesRaw = estimateHawkesBranchingRatio(eventTimes);
  const hawkes = hawkesRaw.branchingRatio !== null
    ? { branchingRatio: hawkesRaw.branchingRatio, halfLifeHoursUsed: hawkesRaw.halfLifeHoursUsed }
    : null;

  const bass = estimateBassParameters(history);
  const remainingUpside = (bass && isFiniteNumber(bass.m)) ? Math.max(0, bass.m - bass.currentCount) : null;
  const remainingUpsideRatio = (bass && bass.m > 0 && remainingUpside !== null) ? remainingUpside / bass.m : null;

  const spanHours = totalEvents >= 2 ? (eventTimes[eventTimes.length - 1] - eventTimes[0]) / 3600000 : 0;
  const hasEnoughData = totalEvents >= 2 || history.length >= 2;

  const regimeLabel = classifyRegime({
    hasEnoughData,
    singleSourceFlag: diversity.singleSourceFlag,
    branchingRatio: hawkes ? hawkes.branchingRatio : null,
    bass,
    uniqueCreators: diversity.uniqueCreators,
  });

  const diffusionScore = hasEnoughData
    ? computeDiffusionScore({
        branchingRatio: hawkes ? hawkes.branchingRatio : null,
        creatorDiversity: diversity.creatorDiversity,
        nicheEntropyNormalized: nicheInfo.nicheEntropyNormalized,
        remainingUpsideRatio,
        singleSourceFlag: diversity.singleSourceFlag,
        maxCreatorShare: diversity.maxCreatorShare,
      })
    : null;

  const confidence = computeConfidence({
    totalEvents,
    spanHours,
    bassFitQuality: bass ? bass.fitQuality : null,
    uniqueCreators: diversity.uniqueCreators,
  });

  return {
    idKey,
    uniqueCreators: diversity.uniqueCreators,
    creatorDiversity: round4(diversity.creatorDiversity),
    maxCreatorShare: round4(diversity.maxCreatorShare),
    singleSourceFlag: diversity.singleSourceFlag,
    nicheEntropy: nicheInfo.nicheEntropy,
    nicheEntropyNormalized: nicheInfo.nicheEntropyNormalized,
    nicheCount: nicheInfo.nicheCount,
    hawkes,
    bass: bass ? { m: bass.m, p: bass.p, q: bass.q, fitQuality: bass.fitQuality } : null,
    remainingUpside,
    diffusionScore,
    confidence,
    regimeLabel,
    totalAdoptionEvents: totalEvents,
    adoptionSpanHours: round4(spanHours),
  };
}

/* ---- Duplicate-audio-title review queue ---- */

function normalizeTitle(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenSet(title) {
  return new Set(normalizeTitle(title).split(" ").filter(Boolean));
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function buildDuplicateReviewQueue(entries) {
  const SIMILARITY_THRESHOLD = 0.6;
  const MAX_QUEUE_LENGTH = 200;

  const items = entries
    .map(([idKey, rec]) => ({ idKey, title: (rec && rec.title) || "", tokens: tokenSet(rec && rec.title) }))
    .filter(x => x.title && x.tokens.size > 0);

  // FIX (logic/perf): this used to compare every entry against every other
  // entry in the WHOLE database (O(n^2)), and the db only ever grows since
  // entries are never pruned. Two titles can only have nonzero Jaccard
  // similarity if they share at least one token, so an inverted index
  // (token -> items containing it) lets us skip every pair that was
  // mathematically guaranteed to score 0 anyway. Output is identical to
  // the old full scan — this only removes provably-zero comparisons — but
  // now scales with shared vocabulary size instead of DB size squared.
  const tokenIndex = new Map();
  for (const item of items) {
    for (const tok of item.tokens) {
      if (!tokenIndex.has(tok)) tokenIndex.set(tok, []);
      tokenIndex.get(tok).push(item);
    }
  }

  const seenPairs = new Set();
  const queue = [];
  for (const candidates of tokenIndex.values()) {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.idKey === b.idKey) continue;

        const pairKey = a.idKey < b.idKey ? `${a.idKey}|${b.idKey}` : `${b.idKey}|${a.idKey}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const similarity = jaccardSimilarity(a.tokens, b.tokens);
        if (similarity >= SIMILARITY_THRESHOLD) {
          queue.push({
            idKeyA: a.idKey,
            idKeyB: b.idKey,
            titleA: a.title,
            titleB: b.title,
            similarity: round4(similarity),
          });
        }
      }
    }
  }

  queue.sort((a, b) => b.similarity - a.similarity);
  return queue.slice(0, MAX_QUEUE_LENGTH);
}

/* ================================================================
   3. generateDiffusionReport — public entrypoint
   ================================================================ */

function generateDiffusionReport(db, options) {
  const opts = options || {};
  const diffusionByIdKey = {};
  const safeDb = (db && typeof db === "object") ? db : {};
  const entries = Object.entries(safeDb);

  let nicheMap = {};
  try { nicheMap = loadNicheMap(opts.NICHE_MAP_FILE); } catch (e) { nicheMap = {}; }

  // 1. Group IDs by ISRC to solve "Original Audio Fragmentation"
  const isrcGroups = new Map(); // isrc -> [idKeys]
  for (const [idKey, rec] of entries) {
    const isrc = rec?.shazamRecognition?.isrc;
    if (isrc && typeof isrc === "string") {
      if (!isrcGroups.has(isrc)) isrcGroups.set(isrc, []);
      isrcGroups.get(isrc).push(idKey);
    }
  }

  // 2. Pre-compute aggregated diffusion for each ISRC group
  const isrcResults = new Map(); // isrc -> diffusionObject
  for (const [isrc, ids] of isrcGroups.entries()) {
    try {
      // Create a Virtual Aggregated Record
      const aggregatedRec = {
        idKey: `isrc:${isrc}`,
        adoptionEvents: [],
        history: [],
        title: "", // will be picked from first member
      };

      for (const id of ids) {
        const rec = safeDb[id];
        if (!rec) continue;
        if (!aggregatedRec.title) aggregatedRec.title = rec.title;
        
        // Merge adoption events
        if (Array.isArray(rec.adoptionEvents)) {
          aggregatedRec.adoptionEvents.push(...rec.adoptionEvents);
        }
        // Merge history snapshots
        if (Array.isArray(rec.history)) {
          aggregatedRec.history.push(...rec.history);
        }
      }

      // Sort and deduplicate merged events
      aggregatedRec.adoptionEvents = aggregatedRec.adoptionEvents
        .filter(e => e && isFiniteNumber(e.time))
        .sort((a, b) => a.time - b.time);
      
      // Deduplicate events that might have been captured across different IDs 
      // (rare but possible if the same reel is linked to multiple audio IDs)
      const seenEvents = new Set();
      aggregatedRec.adoptionEvents = aggregatedRec.adoptionEvents.filter(e => {
        const key = `${e.time}|${e.creatorId}`;
        if (seenEvents.has(key)) return false;
        seenEvents.add(key);
        return true;
      });

      // Consolidate history: sum counts for identical timestamps
      const historyMap = new Map();
      for (const h of aggregatedRec.history) {
        if (!h || !isFiniteNumber(h.time)) continue;
        const t = h.time;
        historyMap.set(t, (historyMap.get(t) || 0) + (h.count || 0));
      }
      aggregatedRec.history = Array.from(historyMap.entries())
        .map(([time, count]) => ({ time, count }))
        .sort((a, b) => a.time - b.time);

      // Compute diffusion on the combined real-song data
      const result = computeDiffusionForAudio(aggregatedRec.idKey, aggregatedRec, nicheMap);
      if (result) isrcResults.set(isrc, result);
    } catch (e) {
      console.error(`      ⚠️ Failed to aggregate ISRC ${isrc}: ${e.message}`);
    }
  }

  // 3. Generate final report
  for (const [idKey, rec] of entries) {
    try {
      const isrc = rec?.shazamRecognition?.isrc;
      if (isrc && isrcResults.has(isrc)) {
        // Use the aggregated "Real Song" metrics
        diffusionByIdKey[idKey] = isrcResults.get(isrc);
      } else {
        // Fallback to standard per-ID computation (for original audios/non-recognized)
        diffusionByIdKey[idKey] = computeDiffusionForAudio(idKey, rec, nicheMap);
      }
    } catch (e) {
      diffusionByIdKey[idKey] = null;
    }
  }

  let duplicateReviewQueue = [];
  try {
    duplicateReviewQueue = buildDuplicateReviewQueue(entries);
  } catch (e) {
    duplicateReviewQueue = [];
  }

  return { diffusionByIdKey, duplicateReviewQueue };
}

/* ================================================================
   Exported, throw-proof wrappers
   ================================================================ */

function safeExtractAdoptionSightings(json) {
  try {
    return extractAdoptionSightings(json);
  } catch (e) {
    return [];
  }
}

function safeMergeAdoptionSightings(db, sightings) {
  try {
    return mergeAdoptionSightings(db, sightings);
  } catch (e) {
    return 0;
  }
}

function safeGenerateDiffusionReport(db, options) {
  try {
    return generateDiffusionReport(db, options);
  } catch (e) {
    return { diffusionByIdKey: {}, duplicateReviewQueue: [] };
  }
}

module.exports = {
  extractAdoptionSightings: safeExtractAdoptionSightings,
  mergeAdoptionSightings: safeMergeAdoptionSightings,
  generateDiffusionReport: safeGenerateDiffusionReport,
};