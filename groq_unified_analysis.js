/**
 * groq_unified_analysis.js — Central Groq Analysis Module
 * 
 * CRITICAL RULES:
 * 1. ONLY use Tavily research data + Groq's own knowledge
 * 2. NEVER use Instagram creator names or generic titles
 * 3. ALWAYS output valid JSON (NO plain text, NO markdown)
 * 4. ALWAYS generate a clean spotifySearchQuery
 */

const Groq = require("groq-sdk");

/* ===== Config ===== */
const CONFIG = {
    GROQ_MODEL: "llama-3.3-70b-versatile",
    GROQ_TEMPERATURE: 0,
    GROQ_MAX_TOKENS: 600,
    MAX_COMMENTS: 45,
};

let _groqClient = null;

function getGroqClient() {
    if (_groqClient) return _groqClient;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.warn("   ⚠️ GROQ_API_KEY not set — unified analysis will be skipped.");
        return null;
    }

    try {
        _groqClient = new Groq({ apiKey });
        return _groqClient;
    } catch (e) {
        console.warn(`   ⚠️ Failed to initialize Groq client: ${e.message}`);
        return null;
    }
}

/* ===== Build the Unified Prompt ===== */

function buildUnifiedPrompt({ 
    title, 
    shazamArtist, 
    tavilyResults, 
    comments, 
    metrics 
}) {
    // Clean comments (first 45, no emojis)
    const cleanComments = comments
        .filter(c => c && c.trim())
        .slice(0, CONFIG.MAX_COMMENTS)
        .join("\n") || "No comments available";

    // Format Tavily results - THIS IS THE PRIMARY SOURCE OF TRUTH
    const tavilyText = `
TAVILY RESEARCH (PRIMARY SOURCE — USE THIS FOR IDENTIFICATION):
  - Artist from research: ${tavilyResults.artist || "Not found"}
  - Song Language: ${tavilyResults.songLanguage || "Not found"}
  - Origin State: ${tavilyResults.originState || "Not found"}
  - Origin Country: ${tavilyResults.originCountry || "Not found"}
  - Research Sources: ${tavilyResults.sources ? JSON.stringify(tavilyResults.sources.map(s => s.url).filter(Boolean).slice(0, 3)) : "None"}
    `;

    // Format metrics
    const metricsText = `
CURRENT METRICS (for context only):
  - Usage Count: ${metrics.count || 0} reels
  - Growth Velocity: ${metrics.velocity || 0}/hour
  - Age: ${metrics.ageHours || 0} hours
    `;

    return `You are a music identification expert. Your task is to identify the REAL song and artist from the evidence provided.

## CRITICAL RULES - YOU MUST FOLLOW THESE:

1. **IGNORE the Instagram title unless it's the ONLY clue**
   - Instagram titles are often generic ("Original audio", "Untitled")
   - They may contain multiple artists with "&" or ","
   - They may contain extra text like "(Slowed & Reverb)"

2. **USE Tavily Research as your PRIMARY source**
   - Tavily has already searched the web for this audio
   - Tavily's artist field contains the REAL artist name (e.g., "Sai Abhyankkar")
   - Tavily's origin fields contain the REAL origin

3. **USE your own knowledge as SECONDARY source**
   - If you know the song, use that knowledge
   - But only if it matches Tavily's research

4. **NEVER use Instagram creator usernames**
   - The creator who posted the reel is NOT the artist
   - Ignore "firstSeenCreator" or any username

5. **OUTPUT ONLY JSON** — No markdown, no explanations, no plain text

---

## INPUT DATA

### Instagram Title (may be unreliable)
${title || "Unknown"}

### Shazam Artist (if available — reliable)
${shazamArtist || "Not available"}

### TAVILY RESEARCH (PRIMARY SOURCE)
${tavilyText}

### Instagram Comments (for language context only)
${cleanComments}

### Metrics
${metricsText}

---

## YOUR TASK

Based on Tavily research + your knowledge, determine:

1. **REAL SONG NAME**: The actual song title
   - Example: "Aathi Raasathi" (not "Sai Abhyankkar, Dhass Benjamin & Pa Vijay — Aathi Raasathi")
   - Example: "Golden Brown" (not "The Stranglers — Golden Brown")

2. **REAL ARTIST NAME**: The actual artist name
   - Example: "Sai Abhyankkar" (not "Dhass Benjamin is the singer of...")
   - Example: "The Stranglers" (not "Hugh Cornwell, Dave Greenfield...")

3. **ORIGIN REGION**: Where the song is from
   - Options: "Kerala", "Tamil Nadu", "Karnataka", "Andhra/Telangana", "Rest of India", "Outside India (Global)", "Unknown"

4. **PRIMARY LANGUAGE**: The language of the song
   - Example: "Malayalam", "Tamil", "English", "Hindi"

5. **SPOTIFY SEARCH QUERY**: Clean query for Spotify search
   - Format: "[Song Name] [Artist Name]"
   - Example: "Aathi Raasathi Sai Abhyankkar"
   - Example: "Golden Brown The Stranglers"

6. **CONFIDENCE**: How confident are you (0.0 to 1.0)?

---

## OUTPUT FORMAT

CRITICAL: Your ENTIRE response must be a SINGLE JSON object. NO text before, NO text after, NO markdown.

{
  "officialSongName": "string",
  "officialArtistName": "string",
  "originRegion": "string",
  "primaryLanguage": "string",
  "trendClassification": "string",
  "spotifySearchQuery": "string",
  "confidence": 0.0,
  "reason": "string",
  "isrc": "string or null",
  "releaseYear": "string or null",
  "genre": "string or null"
}`;
}

/* ===== Parse Unified Response with Strict Validation ===== */

function parseUnifiedResponse(text) {
    if (!text) return { result: null, error: "Empty response" };

    const trimmed = text.trim();
    
    // Remove any markdown code fences if the model added them despite instructions
    let cleaned = trimmed;
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");
    cleaned = cleaned.replace(/```\s*$/i, "");
    cleaned = cleaned.trim();

    if (!cleaned.startsWith("{")) {
        return { 
            result: null, 
            error: `Response did not start with '{' — got: ${cleaned.slice(0, 100)}...` 
        };
    }

    try {
        const parsed = JSON.parse(cleaned);
        
        // Validate required fields
        const required = [
            'officialSongName', 
            'officialArtistName', 
            'originRegion', 
            'trendClassification',
            'spotifySearchQuery',
            'confidence'
        ];
        
        const missing = [];
        for (const field of required) {
            if (!parsed[field]) {
                missing.push(field);
            }
        }
        
        if (missing.length > 0) {
            return { 
                result: null, 
                error: `Missing required fields: ${missing.join(', ')}` 
            };
        }

        // Clean and validate
        const songName = parsed.officialSongName.trim();
        const artistName = parsed.officialArtistName.trim();
        const searchQuery = parsed.spotifySearchQuery.trim();
        
        // Validate search query format
        if (searchQuery.length < 3) {
            return {
                result: null,
                error: `spotifySearchQuery is too short: "${searchQuery}"`
            };
        }

        // Validate confidence
        const confidence = Math.min(1, Math.max(0, parsed.confidence));

        const result = {
            officialSongName: songName,
            officialArtistName: artistName,
            originRegion: parsed.originRegion,
            primaryLanguage: parsed.primaryLanguage || "Unknown",
            trendClassification: parsed.trendClassification,
            spotifySearchQuery: searchQuery,
            confidence: confidence,
            reason: parsed.reason || "",
            isrc: parsed.isrc || null,
            releaseYear: parsed.releaseYear || null,
            genre: parsed.genre || null,
        };

        return { result, error: null };
    } catch (e) {
        return { 
            result: null, 
            error: `JSON parse error: ${e.message}` 
        };
    }
}

/* ===== Main Unified Analysis Function ===== */

async function analyzeUnified({ 
    audioId, 
    title, 
    shazamArtist, 
    tavilyResults, 
    comments, 
    metrics 
}) {
    const client = getGroqClient();
    if (!client) {
        return {
            officialSongName: title || "Unknown",
            officialArtistName: shazamArtist || "Unknown",
            originRegion: "Unknown",
            primaryLanguage: "Unknown",
            trendClassification: "Unknown",
            spotifySearchQuery: title || "Unknown",
            confidence: 0,
            reason: "Groq unavailable",
            fromCache: false,
            error: "No Groq client"
        };
    }

    const prompt = buildUnifiedPrompt({
        title,
        shazamArtist,
        tavilyResults,
        comments: comments || [],
        metrics: metrics || {}
    });

    // Debug: Log what we're sending
    console.log(`      📝 Sending to Groq:`);
    console.log(`         Title: "${title}"`);
    console.log(`         Shazam: "${shazamArtist || 'None'}"`);
    console.log(`         Tavily Artist: "${tavilyResults.artist || 'None'}"`);
    console.log(`         Tavily Origin: "${tavilyResults.originState || 'None'}"`);

    try {
        const completion = await client.chat.completions.create({
            model: CONFIG.GROQ_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are a music identification expert. Respond ONLY with valid JSON. NEVER use markdown. NEVER use plain text. ALWAYS identify the real song and artist from Tavily research + your knowledge. NEVER invent data."
                },
                { role: "user", content: prompt }
            ],
            temperature: CONFIG.GROQ_TEMPERATURE,
            max_tokens: CONFIG.GROQ_MAX_TOKENS,
            response_format: { type: "json_object" }
        });

        const reply = completion.choices?.[0]?.message?.content;
        
        if (!reply) {
            console.log(`      ❌ Groq returned empty response`);
            return {
                officialSongName: title || "Unknown",
                officialArtistName: shazamArtist || "Unknown",
                originRegion: "Unknown",
                primaryLanguage: "Unknown",
                trendClassification: "Unknown",
                spotifySearchQuery: title || "Unknown",
                confidence: 0,
                reason: "Groq returned empty response",
                fromCache: false,
                error: "Empty response"
            };
        }

        console.log(`      📥 Groq response received (${reply.length} chars)`);
        
        // Try to parse the response
        const { result, error } = parseUnifiedResponse(reply);
        
        if (error || !result) {
            console.log(`      ❌ Parse error: ${error}`);
            console.log(`      📝 Raw response: ${reply.slice(0, 200)}...`);
            
            // Fallback: use Tavily data if available
            const fallbackSong = tavilyResults.artist && tavilyResults.artist.length < 30 
                ? tavilyResults.artist 
                : title || "Unknown";
            const fallbackArtist = shazamArtist || tavilyResults.artist || "Unknown";
            
            return {
                officialSongName: fallbackSong,
                officialArtistName: fallbackArtist,
                originRegion: tavilyResults.originState || "Unknown",
                primaryLanguage: tavilyResults.songLanguage || "Unknown",
                trendClassification: "Unknown",
                spotifySearchQuery: `${fallbackSong} ${fallbackArtist}`.trim(),
                confidence: 0.3,
                reason: `Fallback from Tavily: ${error}`,
                fromCache: false,
                error: error
            };
        }

        console.log(`      ✅ Parsed successfully`);
        console.log(`         Song: "${result.officialSongName}"`);
        console.log(`         Artist: "${result.officialArtistName}"`);
        console.log(`         Search: "${result.spotifySearchQuery}"`);

        return { ...result, fromCache: false, error: null };

    } catch (e) {
        console.log(`      ❌ Groq request failed: ${e.message}`);
        
        // Fallback: use Tavily data
        const fallbackSong = tavilyResults.artist && tavilyResults.artist.length < 30 
            ? tavilyResults.artist 
            : title || "Unknown";
        const fallbackArtist = shazamArtist || tavilyResults.artist || "Unknown";
        
        return {
            officialSongName: fallbackSong,
            officialArtistName: fallbackArtist,
            originRegion: tavilyResults.originState || "Unknown",
            primaryLanguage: tavilyResults.songLanguage || "Unknown",
            trendClassification: "Unknown",
            spotifySearchQuery: `${fallbackSong} ${fallbackArtist}`.trim(),
            confidence: 0.3,
            reason: `Fallback from Tavily: ${e.message}`,
            fromCache: false,
            error: e.message
        };
    }
}

module.exports = { analyzeUnified };