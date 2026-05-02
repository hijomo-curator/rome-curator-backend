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

// ── Send itinerary email via Resend ───────────────────────────────
async function sendItineraryEmail({ toEmail, firstName, city, itinerary, travelMonth, travelStyle, budget }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.log('[resend] RESEND_API_KEY not set — skipping email');
    return { skipped: true };
  }

  function itineraryToHtml(data) {
    if (!data || !data.days) return '<p>Your itinerary is ready.</p>';
    return data.days.map(day => {
      const slots = [
        ['Morning', day.morning],
        ['Afternoon', day.afternoon],
        ['Evening', day.evening],
      ];
      const slotsHtml = slots.map(([label, items]) => `
        <div style="margin-bottom:12px;">
          <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#B85C38;font-weight:600;margin-bottom:6px;">${label}</div>
          <ul style="margin:0;padding-left:16px;">
            ${(items || []).map(item => `<li style="font-size:14px;color:#2C1810;line-height:1.7;margin-bottom:4px;">${item}</li>`).join('')}
          </ul>
        </div>`).join('');
      return `
        <div style="background:#fff;border-left:4px solid #B85C38;border-radius:4px;padding:16px 20px;margin-bottom:16px;">
          <div style="margin-bottom:12px;">
            <span style="font-size:11px;font-weight:600;color:#B85C38;letter-spacing:1px;">DAY ${day.day}</span>
            &nbsp;
            <span style="font-family:Georgia,serif;font-size:16px;font-weight:700;color:#1C1410;">${day.title}</span>
          </div>
          ${slotsHtml}
          ${day.why ? `<div style="font-size:11px;color:#7A6355;font-style:italic;margin-top:10px;padding-top:10px;border-top:1px solid #EDE6DA;">${day.why}</div>` : ''}
        </div>`;
    }).join('');
  }

  const monthName = travelMonth ? MONTH_NAMES[travelMonth] : '';
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle || '';
  const itineraryHtml = itineraryToHtml(itinerary);
  const tripTitle = itinerary?.title || `Your ${city} itinerary`;
  const tripMeta = itinerary?.meta || '';

  const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:Georgia,serif;color:#2C1810;">
  <div style="max-width:620px;margin:0 auto;background:#FAF7F2;">
    <div style="background:#1C1410;padding:28px 24px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:white;letter-spacing:3px;">ROME CURATOR</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-top:4px;">YOUR PERSONAL ITINERARY</div>
    </div>
    <div style="background:#B85C38;padding:20px 24px;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:white;margin-bottom:4px;">${tripTitle}</div>
      ${tripMeta ? `<div style="font-size:12px;color:rgba(255,255,255,0.65);">${tripMeta}</div>` : ''}
    </div>
    <div style="background:#EDE6DA;padding:12px 24px;border-bottom:1px solid #D4C9B8;font-size:12px;color:#4A3728;">
      <strong>Traveller:</strong> ${firstName} &nbsp;·&nbsp;
      <strong>Destination:</strong> ${city}
      ${monthName ? ` &nbsp;·&nbsp; <strong>Month:</strong> ${monthName}` : ''}
      ${styleLabel ? ` &nbsp;·&nbsp; <strong>Party:</strong> ${styleLabel}` : ''}
      ${budget ? ` &nbsp;·&nbsp; <strong>Budget:</strong> ${budget}` : ''}
    </div>
    <div style="padding:24px 24px 8px;">
      <p style="font-size:15px;line-height:1.7;color:#2C1810;margin:0;">Hi ${firstName}, here's your curated itinerary for <strong>${city}</strong>. Every recommendation has been chosen to match your travel style — local-first, food-forward, and built around walkable neighbourhoods.</p>
    </div>
    <div style="padding:8px 24px 24px;">
      ${itineraryHtml}
    </div>
    <div style="padding:0 24px 32px;text-align:center;">
      <a href="https://rome-curator-frontend.vercel.app" style="display:inline-block;background:#B85C38;color:white;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:14px;font-weight:500;letter-spacing:1px;">Plan another trip →</a>
    </div>
    <div style="background:#1C1410;padding:20px 24px;text-align:center;">
      <p style="color:#7A6355;font-size:11px;margin:0 0 6px;line-height:1.6;">This itinerary was AI-generated and is a starting point. Always verify opening hours, prices, and bookings before your trip.</p>
      <p style="color:#4A3728;font-size:11px;margin:0;">© 2025 Rome Curator · <a href="https://rome-curator-frontend.vercel.app" style="color:#D4845A;text-decoration:none;">Visit the app</a></p>
    </div>
  </div>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Rome Curator <onboarding@resend.dev>',
        to: [toEmail],
        subject: `Your ${city} itinerary is here, ${firstName} ✈️`,
        html: emailHtml,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('[resend] Error:', result);
      return { error: result };
    }
    console.log(`[resend] Email sent to ${toEmail} | ID: ${result.id}`);
    return { success: true, id: result.id };
  } catch (err) {
    console.error('[resend] Fetch failed:', err.message);
    return { error: err.message };
  }
}

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Rome Curator backend running" }));

// ── Save email (post-itinerary capture) ──────────────────────────
app.post("/save-email", limiter, async (req, res) => {
  try {
    const { firstName, lastName, email, country, source, city, itinerary, travelMonth, travelStyle, budget } = req.body;
    if (!firstName || !email || !country) {
      return res.status(400).json({ error: "Missing required fields: firstName, email, country." });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    console.log(`[email] Saving: ${email} | Source: ${source} | Country: ${country}`);
    const ok = await saveEmailToSheet(firstName, lastName, email, country, source);

    // Send itinerary email if itinerary data is provided
    let emailResult = null;
    if (itinerary && city) {
      emailResult = await sendItineraryEmail({ toEmail: email, firstName, city, itinerary, travelMonth, travelStyle, budget });
    }

    if (ok) return res.json({ success: true, emailSent: emailResult?.success || false });
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

    // Robustly extract JSON — find first { and last } to handle any extra text Claude adds
    let itinerary;
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found');
      const clean = raw.slice(start, end + 1);
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

    let refined;
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found');
      const clean = raw.slice(start, end + 1);
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
