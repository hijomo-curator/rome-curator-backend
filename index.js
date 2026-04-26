import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

// ── Rate limiting ────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
});

// ── CORS ─────────────────────────────────────────────────────────
// Replace with your actual Vercel frontend URL before deploying
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://rome-curator-frontend.vercel.app",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman) during development
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "10kb" }));

// ── Anthropic client ──────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Per-IP usage caps ─────────────────────────────────────────────
const MAX_GENERATIONS = 5;
const MAX_REFINEMENTS = 10;
const usageByIP = {};

function getIP(req) {
  return req.ip || req.connection.remoteAddress || "unknown";
}

function initUsage(ip) {
  if (!usageByIP[ip]) {
    usageByIP[ip] = { generations: 0, refinements: 0 };
  }
}

// ── Token budget based on trip length ────────────────────────────
function getTokenLimit(days) {
  if (days <= 3) return 2000;
  if (days <= 5) return 3000;
  if (days <= 7) return 4000;
  return 5000;
}

// ── System prompt factory ─────────────────────────────────────────
function getSystemPrompt(city) {
  return `You are the Rome Curator's local expert for ${city} — a deeply knowledgeable friend who has lived in ${city} for years, eats obsessively well, and hates tourist traps. You plan trips with precision, taste, and genuine love for the city.

CURATION PHILOSOPHY:
- Local always beats touristy. Iconic landmarks only if they carry genuine human historical or cultural significance (Colosseum, Pantheon, Taj Mahal — yes; Trevi Fountain photo stop — no, unless asked).
- Food is the anchor of every day. Sights come second.
- Maximum one iconic landmark per day.
- Be ruthlessly specific: name the exact place, dish, street, best time. Never generic advice.
- Plan in walkable neighbourhood clusters. Never send someone across the city for one thing.
- Warn about tourist traps near recommended spots.
- Prioritise small, family-run, cash-only, tucked-away places.
- Nature interest = parks, coastal walks, hill viewpoints, countryside day trips.
- Off-beat = hidden urban gems, unusual neighbourhoods, non-touristy streets.
- Nightlife = bars open late, live music, clubs — distinct from drinks/aperitivo which is early-evening social culture.
- Adapt to pace: relaxed = fewer things, more lingering; packed = efficient routing, more stops.

HARD RULES:
- Return ONLY valid JSON. No markdown, no explanation, no text outside the JSON object.
- Every morning, afternoon and evening block must have exactly 3 bullet points.
- Each bullet: name the exact place, what to order or do, and why — all in one specific sentence.
- The "why" field: exactly 2 sentences explaining the day's curation logic, like a knowledgeable friend.

Return this exact JSON shape:
{"title":"short evocative title","meta":"e.g. 4 days · food-first · relaxed pace","days":[{"day":1,"title":"short day title","morning":["bullet","bullet","bullet"],"afternoon":["bullet","bullet","bullet"],"evening":["bullet","bullet","bullet"],"why":"2-sentence rationale"}]}`;
}

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Rome Curator backend running" });
});

// ── Generate full itinerary ───────────────────────────────────────
app.post("/generate-itinerary", limiter, async (req, res) => {
  try {
    const { city, days, pace, interests } = req.body;
    const ip = getIP(req);
    initUsage(ip);

    // Validate inputs
    if (!city || !days || !pace || !Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ error: "Missing required fields: city, days, pace, interests" });
    }
    if (days < 1 || days > 14) {
      return res.status(400).json({ error: "Days must be between 1 and 14" });
    }

    // Check IP cap
    if (usageByIP[ip].generations >= MAX_GENERATIONS) {
      return res.status(429).json({ error: "Generation limit reached. Try again later." });
    }

    usageByIP[ip].generations += 1;
    console.log(`[generate] IP: ${ip} | City: ${city} | Days: ${days} | Count: ${usageByIP[ip].generations}`);

    const maxTokens = getTokenLimit(days);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: getSystemPrompt(city),
      messages: [{
        role: "user",
        content: `Plan a ${days}-day ${city} itinerary.\nPace: ${pace}\nInterests: ${interests.join(", ")}\nFood-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`,
      }],
    });

    const raw = message.content.find(b => b.type === "text")?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();

    let itinerary;
    try {
      itinerary = JSON.parse(clean);
    } catch {
      console.error("[generate] JSON parse failed:", raw.slice(0, 200));
      return res.status(500).json({ error: "Failed to parse itinerary from AI response." });
    }

    console.log(`[generate] Success | Tokens used: ${message.usage.input_tokens + message.usage.output_tokens}`);
    return res.json(itinerary);

  } catch (err) {
    console.error("[generate] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong generating your itinerary." });
  }
});

// ── Refine a single day ───────────────────────────────────────────
app.post("/refine-day", limiter, async (req, res) => {
  try {
    const { city, day, instruction } = req.body;
    const ip = getIP(req);
    initUsage(ip);

    if (!city || typeof day !== "object" || !instruction) {
      return res.status(400).json({ error: "Missing required fields: city, day, instruction" });
    }

    if (usageByIP[ip].refinements >= MAX_REFINEMENTS) {
      return res.status(429).json({ error: "Refinement limit reached. Try again later." });
    }

    usageByIP[ip].refinements += 1;
    console.log(`[refine] IP: ${ip} | City: ${city} | Day: ${day.day} | Count: ${usageByIP[ip].refinements}`);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: `You are the Rome Curator's local expert for ${city}. Refine this single day based on the instruction. Return ONLY valid JSON with the exact same structure — no markdown, no extra text.\n\nCurrent day:\n${JSON.stringify(day)}\n\nInstruction: "${instruction}"`,
      }],
    });

    const raw = message.content.find(b => b.type === "text")?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();

    let refined;
    try {
      refined = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Failed to parse refined day from AI response." });
    }

    console.log(`[refine] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);
    return res.json(refined);

  } catch (err) {
    console.error("[refine] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong refining your day." });
  }
});

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Rome Curator backend running on port ${PORT}`);
});
