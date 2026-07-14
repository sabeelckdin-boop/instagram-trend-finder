/**
 * replay_utils.js — Shared HTTP replay utilities for Instagram API requests.
 *
 * Shared between scrape.js and shazam_recognition.js. Centralises:
 *   1. parseJsonpBody() — strips JSONP padding from Instagram responses
 *   2. filterReplayHeaders() — removes hop-by-hop and pseudo headers
 *   3. replayApiRequest() — replays a captured request with a specific
 *      audio ID substituted in, using URLSearchParams instead of regex
 *      so the substitution reliably works even when the target field is
 *      empty or absent from the captured template.
 *
 * FIX (this pass): the old regex-based substitution silently no-op'd
 * whenever the captured template didn't already contain the target field
 * (e.g. asset_id was empty or entirely missing in a cluster-only request).
 * URLSearchParams-based substitution always sets the correct field and
 * blanks the other one, so the API doesn't reject the replay.
 */

/* ===== Filter headers for HTTP replay ===== */
function filterReplayHeaders(rawHeaders) {
  const FORBIDDEN_EXACT = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'accept-encoding', 'content-length',
  ]);

  const filtered = {};

  for (const [key, value] of Object.entries(rawHeaders || {})) {
    const lower = key.toLowerCase();

    if (lower.startsWith(':')) continue;
    if (FORBIDDEN_EXACT.has(lower)) continue;
    if (lower.startsWith('proxy-') || lower.startsWith('sec-websocket')) continue;

    filtered[key] = value;
  }

  if (!filtered['Content-Type'] && !filtered['content-type']) {
    filtered['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  return filtered;
}

/* ===== Parse JSONP body ===== */

/**
 * Strips common Instagram JSONP wrappers and returns the raw object.
 * Handles: `for(;;);{...}`, `)]}',\n{...}`, and plain JSON.
 */
function parseJsonpBody(text) {
  if (!text || typeof text !== 'string') return null;
  let clean = text.trim();
  clean = clean.replace(/^for\s*\(\s*;;\s*\)\s*;?/, '');
  clean = clean.replace(/^\)\]\}'\s*/, '');
  return JSON.parse(clean);
}

/* ===== Replay a captured API request ===== */

/**
 * Build the POST body string for a replay, setting the correct audio ID
 * field(s) via URLSearchParams so the substitution is reliable regardless
 * of whether the target field was present/empty in the captured template.
 *
 * @param {string} originalPostData - The raw postData string from the capture
 * @param {object} target - { clusterId?: string, assetId?: string }
 * @returns {string} The modified POST body
 */
function buildReplayBody(originalPostData, target) {
  const params = new URLSearchParams(originalPostData || '');

  const templateKeys = [...params.keys()];
  
  // Heuristic to find the correct field name by looking for common patterns 
  // or by identifying which field currently holds a value that looks like an ID.
  const findFieldName = (pattern, fallback, targetValue) => {
    // 1. Try regex pattern match on key name
    const match = templateKeys.find(k => pattern.test(k));
    if (match) return match;

    // 2. If targetValue is provided, try to find which key currently holds a value 
    // that matches the format of the targetValue (basic length/char check).
    if (targetValue) {
      for (const [key, value] of params.entries()) {
        if (value && value.length === targetValue.length && /^[a-zA-Z0-9_]+$/.test(value)) {
          return key;
        }
      }
    }

    return fallback;
  };

  const assetIdField = findFieldName(/audio_asset_id$/i, 'original_sound_audio_asset_id', target.assetId);
  const clusterIdField = findFieldName(/audio_cluster_id$/i, 'audio_cluster_id', target.clusterId);

  // Set (or add) the cluster ID field
  if (target.clusterId) {
    params.set(clusterIdField, target.clusterId);
  } else {
    params.delete(clusterIdField);
  }

  // Set (or add) the asset ID field
  if (target.assetId) {
    params.set(assetIdField, target.assetId);
  } else {
    params.delete(assetIdField);
  }

  return params.toString();
}

/**
 * Replay a captured API request for a specific audio ID.
 *
 * @param {object} apiContext - Playwright's request context (page.request)
 * @param {object} captured - The captured API request/response object (must
 *   have .url, .headers, .postData)
 * @param {object} target - { clusterId?: string, assetId?: string } —
 *   at least one of the two must be provided
 * @returns {Promise<{count?: number, json?: object, status?: number, error?: string}>}
 */
async function replayApiRequest(apiContext, captured, target) {
  if (!apiContext || !captured || !captured.url || !captured.postData) {
    return { error: 'Missing apiContext, captured URL or postData', status: null, networkError: false };
  }

  const body = buildReplayBody(captured.postData, target);
  const headers = filterReplayHeaders(captured.headers);

  try {
    const response = await apiContext.post(captured.url, {
      headers,
      data: body,
      maxRedirects: 0,
    });

    const status = response.status();
    const text = await response.text();

    if (status !== 200) {
      // FIX (logic): a 3xx here almost always means the session/endpoint
      // itself has an issue (e.g. re-auth redirect), not that this
      // specific audio ID is invalid — worth being able to tell apart from
      // a normal 4xx/5xx at the call site instead of both looking like an
      // identical generic "HTTP <n>" string.
      const isRedirect = status >= 300 && status < 400;
      const label = isRedirect ? `HTTP ${status} redirect` : `HTTP ${status}`;
      return { error: `${label}: ${text.slice(0, 200)}`, status, isRedirect };
    }

    const json = parseJsonpBody(text);
    return { json, status };

  } catch (err) {
    // FIX (logic): this branch used to return only `{ error }`, with no
    // `status` field at all. fetchAllCounts() in scrape.js only triggers
    // its 401/403-driven "pause and recapture" logic when result.status is
    // present — so a real network-level failure (timeout, DNS, connection
    // reset) silently fell through that check and could get misread as
    // "no count found for this track" instead of "this batch needs to
    // pause/recapture". Explicit `status: null` plus `networkError: true`
    // lets a caller distinguish a transient network failure from both a
    // real HTTP status and a normal empty result.
    return { error: err.message, status: null, networkError: true };
  }
}

module.exports = {
  filterReplayHeaders,
  parseJsonpBody,
  buildReplayBody,
  replayApiRequest,
};