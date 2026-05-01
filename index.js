const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

const app = express();
app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || "https://rome-curator-frontend.vercel.app",
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please try again in 15 minutes." },
});
app.use(generalLimiter);

// Hard caps per IP
const generationCounts = {};
const refinementCounts = {};
const MAX_GENERATIONS = 5;
const MAX_REFINEMENTS = 10;

// ─── ANTHROPIC CLIENT ────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── RESEND EMAIL HELPER ─────────────────────────────────────────────────────
async function sendItineraryEmail({ toEmail, firstName, city, itineraryHtml, travelMonth, travellers, budget }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set — skipping email send");
    return { skipped: true };
  }

  const subject = `Your ${city} itinerary is here, ${firstName} ✈️`;

  const emailBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your Rome Curator Itinerary</title>
  <style>
    body { margin: 0; padding: 0; background: #FAF7F2; font-family: Georgia, serif; color: #2C1810; }
    .wrapper { max-width: 620px; margin: 0 auto; background: #FAF7F2; }
    .header { background: #B85C38; padding: 32px 24px; text-align: center; }
    .header h1 { margin: 0; color: #FAF7F2; font-size: 28px; letter-spacing: 2px; font-family: Georgia, serif; }
    .header p { margin: 6px 0 0; color: #F5D9C8; font-size: 14px; letter-spacing: 1px; }
    .meta { background: #F5D9C8; padding: 16px 24px; border-bottom: 1px solid #D4956A; }
    .meta p { margin: 4px 0; font-size: 14px; color: #5C2E1A; }
    .meta strong { color: #B85C38; }
    .content { padding: 24px; }
    .content h2 { color: #B85C38; font-size: 18px; border-bottom: 1px solid #D4956A; padding-bottom: 8px; margin-top: 28px; }
    .content p { line-height: 1.7; font-size: 15px; color: #2C1810; }
    .itinerary-block { background: #fff; border-left: 4px solid #B85C38; border-radius: 4px; padding: 16px 20px; margin: 16px 0; }
    .footer { background: #2C1810; padding: 20px 24px; text-align: center; }
    .footer p { color: #D4956A; font-size: 12px; margin: 4px 0; line-height: 1.6; }
    .footer a { color: #F5D9C8; text-decoration: none; }
    .cta { display: block; margin: 24px auto; background: #B85C38; color: #FAF7F2 !important; text-decoration: none; padding: 14px 32px; border-radius: 4px; font-size: 16px; text-align: center; width: fit-content; letter-spacing: 1px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>ROME CURATOR</h1>
      <p>Your personal ${city} itinerary</p>
    </div>

    <div class="meta">
      <p><strong>Traveller:</strong> ${firstName}</p>
      <p><strong>Destination:</strong> ${city}</p>
      <p><strong>Travel month:</strong> ${travelMonth}</p>
      <p><strong>Party:</strong> ${travellers} &nbsp;|&nbsp; <strong>Budget:</strong> ${budget}</p>
    </div>

    <div class="content">
      <p>Hi ${firstName},</p>
      <p>Here's the curated itinerary we built for your trip to <strong>${city}</strong>. It's been tailored to your travel style, travel month, and budget — so every recommendation actually fits your trip.</p>

      <div class="itinerary-block">
        ${itineraryHtml}
      </div>

      <a class="cta" href="https://rome-curator-frontend.vercel.app">Plan another trip →</a>

      <h2>A few travel tips</h2>
      <p>🗓 Save this email — you'll want it when you're offline.<br/>
      📍 Screenshot your daily plans before heading out.<br/>
      🔁 You can always go back and generate another itinerary anytime.</p>
    </div>

    <div class="footer">
      <p>Curated with care by <strong>Rome Curator</strong></p>
      <p>This itinerary was AI-generated and is meant as a starting point. Always verify opening hours, prices, and bookings before your trip.</p>
      <p style="margin-top:12px; color:#8B6B55;">© 2025 Rome Curator · <a href="https://rome-curator-frontend.vercel.app">Visit the app</a></p>
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Rome Curator <onboarding@resend.dev>",
        to: [toEmail],
        subject,
        html: emailBody,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Resend error:", result);
      return { error: result };
    }
    console.log("Email sent via Resend:", result.id);
    return { success: true, id: result.id };
  } catch (err) {
    console.error("Resend fetch failed:", err.message);
    return { error: err.message };
  }
}

// ─── HELPER: convert plain itinerary text to simple HTML ─────────────────────
function textToEmailHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n")
    .map((line) => {
      line = line.trim();
      if (!line) return "";
      if (/^(##\s*)?day\s*\d+/i.test(line)) {
        return `<h2 style="color:#B85C38;font-size:17px;margin:20px 0 8px;border-bottom:1px solid #D4956A;padding-bottom:6px;">${line.replace(/^##\s*/, "")}</h2>`;
      }
      if (/^(morning|afternoon|evening|lunch|dinner|breakfast|note|tip):/i.test(line)) {
        return `<p style="margin:10px 0 4px;"><strong style="color:#B85C38;">${line.split(":")[0]}:</strong>${line.slice(line.indexOf(":") + 1)}</p>`;
      }
      return `<p style="margin:6px 0;line-height:1.7;">${line}</p>`;
    })
    .join("");
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
function buildSystemPrompt(city, interests, month, travellers, budget) {
  const safetyNote =
    travellers === "solo_female"
      ? "This traveller is a solo woman. Prioritise well-lit, busy areas. Flag any location that is better avoided at night. Suggest female-friendly accommodation zones."
      : "";

  const elderlyNote =
    travellers === "family_elderly"
      ? "The group includes elderly members. Avoid steep climbs, long walks, or physically demanding activities. Prefer comfortable transport, accessible venues, and shorter days."
      : "";

  const kidsNote =
    travellers === "family_kids"
      ? "The group includes young children. Include child-friendly activities, gelato stops, parks, and interactive museums. Keep daily walks manageable. Avoid late-night recommendations."
      : "";

  const budgetNote = {
    backpacker:
      "Budget is backpacker. Prioritise free sights, street food, hostels, public transport, and low-cost hidden gems.",
    mid_range:
      "Mix of affordable restaurants, 3-star hotels, and occasional splurges on key experiences.",
    luxury:
      "Budget is luxury. Recommend fine dining, 5-star hotels, private tours, skip-the-line experiences, and premium options.",
  }[budget] || "";

  const monthNote = month
    ? `The traveller is visiting in ${month}. Factor in seasonal weather, crowd levels, and any local festivals or events that month.`
    : "";

  return `You are Rome Curator — an expert, opinionated travel curator for ${city}.
You create personalised, day-by-day itineraries that feel like advice from a well-travelled friend, not a generic travel blog.

Travel context:
- City: ${city}
- Interests: ${interests.join(", ")}
- Travellers: ${travellers}
- Budget: ${budget}
${monthNote}
${safetyNote}
${elderlyNote}
${kidsNote}
${budgetNote}

Rules:
- Structure each day clearly: Day 1, Day 2, etc. with Morning / Afternoon / Evening sections
- Be specific: name actual restaurants, museums, neighbourhoods, viewpoints
- Be opinionated: say why each pick matters, don't just list
- End with a short "Local Tips" section (3–5 bullets)
- Keep a warm, confident, first-person curatorial tone
- Never use filler phrases like "of course" or "certainly"
- Do not add a preamble or sign-off — start directly with Day 1`;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Rome Curator backend is running" });
});

// Generate itinerary
app.post("/generate", async (req, res) => {
  const ip = req.ip;
  generationCounts[ip] = (generationCounts[ip] || 0) + 1;
  if (generationCounts[ip] > MAX_GENERATIONS) {
    return res.status(429).json({
      error: "You've reached the maximum of 5 itineraries. Come back tomorrow!",
    });
  }

  const { city, interests, month, travellers, budget, firstName, email, country } = req.body;

  if (!city || !interests || !month || !travellers || !budget) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  // Save to Google Sheet
  if (email && firstName) {
    try {
      await fetch(process.env.SHEETDB_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [{ firstName, email, country: country || "", source: "landing_form", city, timestamp: new Date().toISOString() }],
        }),
      });
    } catch (e) {
      console.error("SheetDB error:", e.message);
    }
  }

  const systemPrompt = buildSystemPrompt(city, interests, month, travellers, budget);

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Create a 5-day itinerary for ${city} based on my preferences.`,
        },
      ],
      system: systemPrompt,
    });

    const itineraryText = message.content[0].text;

    // Send email if we have the user's details
    let emailResult = null;
    if (email && firstName) {
      const itineraryHtml = textToEmailHtml(itineraryText);
      emailResult = await sendItineraryEmail({
        toEmail: email,
        firstName,
        city,
        itineraryHtml,
        travelMonth: month,
        travellers,
        budget,
      });
    }

    res.json({
      itinerary: itineraryText,
      emailSent: emailResult?.success || false,
    });
  } catch (err) {
    console.error("Generation error:", err.message);
    res.status(500).json({ error: "Failed to generate itinerary. Please try again." });
  }
});

// Refine a single day
app.post("/refine", async (req, res) => {
  const ip = req.ip;
  refinementCounts[ip] = (refinementCounts[ip] || 0) + 1;
  if (refinementCounts[ip] > MAX_REFINEMENTS) {
    return res.status(429).json({
      error: "You've reached the maximum of 10 refinements.",
    });
  }

  const { city, day, currentContent, interests, travellers, budget, refinementRequest } = req.body;

  if (!city || !day || !currentContent) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Here is the current ${day} itinerary for ${city}:\n\n${currentContent}\n\n${
            refinementRequest
              ? `Please refine it with this request: ${refinementRequest}`
              : "Please refine this day with fresh alternatives while keeping the same structure."
          }`,
        },
      ],
      system: buildSystemPrompt(city, interests || [], null, travellers || "couple", budget || "mid_range"),
    });

    res.json({ itinerary: message.content[0].text });
  } catch (err) {
    console.error("Refinement error:", err.message);
    res.status(500).json({ error: "Failed to refine. Please try again." });
  }
});

// Save to inbox (post-itinerary email capture)
app.post("/save-email", async (req, res) => {
  const { email, firstName, country, city, itinerary, month, travellers, budget } = req.body;

  if (!email || !firstName) {
    return res.status(400).json({ error: "Name and email are required." });
  }

  // Save to Sheet
  try {
    await fetch(process.env.SHEETDB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{ firstName, email, country: country || "", source: "save_to_inbox", city: city || "", timestamp: new Date().toISOString() }],
      }),
    });
  } catch (e) {
    console.error("SheetDB error:", e.message);
  }

  // Send email with itinerary
  let emailResult = null;
  if (itinerary) {
    const itineraryHtml = textToEmailHtml(itinerary);
    emailResult = await sendItineraryEmail({
      toEmail: email,
      firstName,
      city: city || "your destination",
      itineraryHtml,
      travelMonth: month || "",
      travellers: travellers || "",
      budget: budget || "",
    });
  }

  res.json({ success: true, emailSent: emailResult?.success || false });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rome Curator backend running on port ${PORT}`);
});
