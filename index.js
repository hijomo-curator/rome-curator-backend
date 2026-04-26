import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
});

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://rome-curator-frontend.vercel.app",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "10kb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_GENERATIONS = 5;
const MAX_REFINEMENTS = 10;
const usageByIP = {};

function getIP(req) { return req.ip || req.connection.remoteAddress || "unknown"; }
function initUsage(ip) { if (!usageByIP[ip]) usageByIP[ip] = { generations: 0, refinements: 0 }; }
function getTokenLimit(days) {
  if (days <= 3) return 2000;
  if (days <= 5) return 3000;
  if (days <= 7) return 4000;
  return 5000;
}

const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

const TRAVEL_STYLE_LABELS = {
  solo_male: 'solo male traveller',
  solo_female: 'solo female traveller',
  couple: 'couple',
  friends: 'group of friends',
  family_kids: 'family with young children',
  family_elderly: 'family with elderly members',
};

const BUDGET_LABELS = {
  backpacker: 'backpacker (budget-conscious, hostels, street food, free attractions)',
  'mid-range': 'mid-range (comfortable hotels, sit-down restaurants, paid attractions)',
  luxury: 'luxury (boutique hotels, fine dining, private experiences, skip-the-line)',
};

function getSystemPrompt(city, month, travelStyle, budget) {
  const monthName = month ? MONTH_NAMES[month] : null;
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle;
  const budgetLabel = BUDGET_LABELS[budget] || budget;

  const soloFemaleNote = travelStyle === 'solo_female' ? `
SOLO FEMALE SAFETY RULES:
- Only recommend areas that are well-lit, busy, and considered safe for solo female travellers.
- For evening activities, prioritise busy bars, restaurants, and areas with good foot traffic.
- For off-beat spots, add a safety note: e.g. "busy and safe during the day".
- Avoid isolated areas, poorly lit streets, or locations known for harassment.
- Never recommend arriving somewhere very late at night alone.` : '';

  const elderlyNote = travelStyle === 'family_elderly' ? `
ELDERLY-FRIENDLY RULES:
- Avoid recommendations requiring significant walking, climbing, or long standing periods.
- Prefer attractions with good accessibility, seating, and facilities.
- Include rest breaks in the day structure.
- Prefer ground-floor or lift-accessible venues.
- Avoid cobblestone-heavy routes where possible.` : '';

  const familyNote = travelStyle === 'family_kids' ? `
FAMILY WITH KIDS RULES:
- Include at least one child-friendly activity per day.
- Avoid overly long museum visits — keep sights varied and engaging.
- Suggest restaurants that are kid-friendly and relaxed.
- Build in rest time and don't over-schedule.` : '';

  return `You are the Rome Curator's local expert for ${city} — a deeply knowledgeable friend who has lived in ${city} for years, eats obsessively well, and hates tourist traps.

TRIP CONTEXT:
- Travelling: ${styleLabel}
- Budget: ${budgetLabel}
${monthName ? `- Travel month: ${monthName} — factor in seasonal weather, crowds, local events, and what's open or closed.` : ''}
${soloFemaleNote}${elderlyNote}${familyNote}

CURATION PHILOSOPHY:
- Local always beats touristy. Iconic landmarks only if they carry genuine human historical/cultural significance.
- Food is the anchor of every day. Sights come second.
- Maximum one iconic landmark per day.
- Be ruthlessly specific: name the exact place, dish, street, best time. Never generic advice.
- Plan in walkable neighbourhood clusters. Never send someone across the city for one thing.
- Warn about tourist traps near recommended spots.
- Match budget strictly: backpacker = street food, free sights. Mid-range = sit-down meals, paid museums. Luxury = tasting menus, private tours, rooftop bars.
- Nature = parks, coastal walks, hill viewpoints, countryside day trips.
- Off-beat = hidden urban gems, unusual neighbourhoods.
- Nightlife = bars open late, live music, clubs — distinct from drinks/aperitivo.
- Adapt to pace: relaxed = fewer things, more lingering; packed = efficient routing, more stops.

HARD RULES:
- Return ONLY valid JSON. No markdown, no explanation, no text outside the JSON object.
- Every morning, afternoon and evening block must have exactly 3 bullet points.
- Each bullet: name the exact place, what to order or do, and why — all in one specific sentence.
- The "why" field: exactly 2 sentences explaining the day's curation logic.

Return this exact JSON shape:
{"title":"short evocative title","meta":"e.g. 4 days · food-first · relaxed pace · mid-range budget","days":[{"day":1,"title":"short day title","morning":["bullet","bullet","bullet"],"afternoon":["bullet","bullet","bullet"],"evening":["bullet","bullet","bullet"],"why":"2-sentence rationale"}]}`;
}

// ── Save email to Google Sheets via Sheetdb ───────────────────────
async function saveEmailToSheet(firstName, lastName, email, country, source) {
  try {
    const res = await fetch(process.env.SHEETDB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          Timestamp: new Date().toISOString(),
          'First Name': firstName,
          'Last Name': lastName || '',
          Email: email,
          Country: country,
          Source: source,
        }]
      })
    });
    return res.ok;
  } catch (err) {
    console.error('[sheet] Save failed:', err.message);
    return false;
  }
}

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Rome Curator backend running" }));

// ── Save email ────────────────────────────────────────────────────
app.post("/save-email", limiter, async (req, res) => {
  try {
    const { firstName, lastName, email, country, source } = req.body;
    if (!firstName || !email || !country) {
      return res.status(400).json({ error: "Missing required fields: firstName, email, country." });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    console.log(`[email] Saving: ${email} | Source: ${source} | Country: ${country}`);
    const ok = await saveEmailToSheet(firstName, lastName, email, country, source);
    if (ok) return res.json({ success: true });
    return res.status(500).json({ error: "Failed to save email." });
  } catch (err) {
    console.error('[email] Error:', err.message);
    return res.status(500).json({ error: "Something went wrong saving your email." });
  }
});

// ── Generate itinerary ────────────────────────────────────────────
app.post("/generate-itinerary", limiter, async (req, res) => {
  try {
    const { city, days, pace, month, travelStyle, budget, interests } = req.body;
    const ip = getIP(req);
    initUsage(ip);

    if (!city || !days || !pace || !Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (days < 1 || days > 14) return res.status(400).json({ error: "Days must be between 1 and 14." });
    if (usageByIP[ip].generations >= MAX_GENERATIONS) {
      return res.status(429).json({ error: "Generation limit reached. Try again later." });
    }

    usageByIP[ip].generations += 1;
    console.log(`[generate] IP: ${ip} | City: ${city} | Days: ${days} | Style: ${travelStyle} | Budget: ${budget} | Count: ${usageByIP[ip].generations}`);

    const monthName = month ? MONTH_NAMES[month] : null;
    const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle || 'traveller';

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: getTokenLimit(days),
      system: getSystemPrompt(city, month, travelStyle, budget),
      messages: [{
        role: "user",
        content: `Plan a ${days}-day ${city} itinerary.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`,
      }],
    });

    const raw = message.content.find(b => b.type === "text")?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();

    let itinerary;
    try {
      itinerary = JSON.parse(clean);
    } catch {
      console.error("[generate] JSON parse failed:", raw.slice(0, 300));
      return res.status(500).json({ error: "Failed to parse itinerary. Please try again." });
    }

    console.log(`[generate] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);
    return res.json(itinerary);

  } catch (err) {
    console.error("[generate] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong generating your itinerary. Please try again." });
  }
});

// ── Refine a single day ───────────────────────────────────────────
app.post("/refine-day", limiter, async (req, res) => {
  try {
    const { city, day, instruction } = req.body;
    const ip = getIP(req);
    initUsage(ip);

    if (!city || typeof day !== "object" || !instruction) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (usageByIP[ip].refinements >= MAX_REFINEMENTS) {
      return res.status(429).json({ error: "Refinement limit reached. Try again later." });
    }

    usageByIP[ip].refinements += 1;
    console.log(`[refine] IP: ${ip} | City: ${city} | Day: ${day.day} | Count: ${usageByIP[ip].refinements}`);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
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
      return res.status(500).json({ error: "Failed to parse refined day. Please try again." });
    }

    console.log(`[refine] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);
    return res.json(refined);

  } catch (err) {
    console.error("[refine] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Rome Curator backend running on port ${PORT}`));
