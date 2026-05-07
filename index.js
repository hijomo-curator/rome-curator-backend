import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// ── Supabase client (backend only, uses secret key) ───────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
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
  "https://romecurator.com",
  "https://www.romecurator.com",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "100kb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Supabase helpers ──────────────────────────────────────────────
function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const CACHE_MONTHS = 6;

async function findCachedItinerary(city, days, pace, month, travelStyle, budget, interests) {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - CACHE_MONTHS);
    const { data } = await supabase
      .from('itineraries')
      .select('slug, data')
      .eq('city', city)
      .eq('days', days)
      .eq('pace', pace)
      .eq('month', month)
      .eq('travel_style', travelStyle)
      .eq('budget', budget)
      .contains('interests', interests)
      .gte('created_at', cutoff.toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data || null;
  } catch {
    return null;
  }
}

async function saveItinerary(slug, city, days, pace, month, travelStyle, budget, interests, data) {
  try {
    const { data: result, error } = await supabase.from('itineraries').insert({
      slug, city, days, pace, month, travel_style: travelStyle,
      budget, interests, data
    });
    if (error) {
      console.error('[supabase] Insert error:', JSON.stringify(error));
    } else {
      console.log('[supabase] Insert success:', slug);
    }
  } catch (err) {
    console.error('[supabase] Save exception:', err.message);
  }
}

async function getItineraryBySlug(slug) {
  try {
    const { data } = await supabase
      .from('itineraries')
      .select('*')
      .eq('slug', slug)
      .single();
    return data || null;
  } catch {
    return null;
  }
}

const MAX_GENERATIONS = 5;
const MAX_REFINEMENTS = 10;
const usageByIP = {};

function getIP(req) { return req.ip || req.connection.remoteAddress || "unknown"; }
function initUsage(ip) { if (!usageByIP[ip]) usageByIP[ip] = { generations: 0, refinements: 0 }; }
function getTokenLimit(days, isMultiCity) {
  const base = isMultiCity ? 1500 : 0; // multi-city needs extra tokens for complexity
  if (days <= 3) return 2000 + base;
  if (days <= 5) return 3000 + base;
  if (days <= 7) return 4500 + base;
  return 6000 + base;
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

// ── Destination-specific context injected into system prompt ─────
const DESTINATION_CONTEXT = {
  // ITALY
  'Rome': 'Anchor days in Trastevere, Testaccio, Pigneto, Prati — not the tourist triangle. Warn about tourist traps near Trevi and Colosseum. Cacio e pepe, supplì, carbonara, artichokes alla giudia are the food anchors. August means locals flee — adjust accordingly.',
  'Florence': 'Anchor in Oltrarno and San Frediano — not around the Duomo. Lampredotto, bistecca Fiorentina, schiacciata, Chianti. Warn about tourist-trap restaurants on Piazza della Repubblica. June-August is brutally hot and crowded — mornings only for outdoor sights.',
  'Amalfi Coast': 'Base in Positano, Ravello, or Praiano — never Amalfi town itself which is too crowded. Limoncello, fresh pasta, grilled fish, local lemons. Ferries beat roads. July-August: arrive before 9am or after 5pm to avoid gridlock. Focus on one area per day — the coast is not a quick drive.',
  'Sicily': 'Base in Palermo or Catania depending on focus. Arancini, granita, cannoli, pasta alla Norma, street food at Ballarò market. Greek temples in Agrigento, baroque Noto, salt pans near Marsala. Never rush Sicily — distances are deceptive. Avoid August heat in the interior.',
  // PORTUGAL
  'Lisbon': 'Anchor in Mouraria, Intendente, LX Factory area — not Bairro Alto which is touristy now. Pastéis de nata at Manteigaria (not Belém), bifanas, ginjinha. Tram 28 is a tourist trap — walk the hills instead. Avoid Belem on weekends.',
  'Porto': 'Anchor in Bonfim, Cedofeita, Foz do Douro — not Ribeira which is overpriced. Francesinha, tripas à moda do Porto, Super Bock on the go. Wine caves in Vila Nova de Gaia are worth it. Walk the Douro riverbank at sunset. June-July is peak and busy.',
  // JAPAN
  'Tokyo': 'Anchor by neighbourhood: Shimokitazawa for vintage/music, Yanaka for old Tokyo, Koenji for subculture, Shinjuku Golden Gai for tiny bars. Ramen, yakitori, tempura, tsukemen, tonkatsu. Avoid Shibuya crossing at peak hours — go at 7am instead. IC card for all transport.',
  'Kyoto': 'Go to temples at 7am before tour buses. Fushimi Inari at dawn only. Anchor in Higashiyama and Gion for walking. Kaiseki, yudofu, matcha everything, obanzai. October-November and March-April are peak — book 3 months ahead. Avoid Arashiyama on weekends.',
  'Osaka': 'Dotonbori is for one evening only — rest of the time anchor in Shinsekai, Tenma, Nakazakicho. Takoyaki, okonomiyaki, kushikatsu, negiyaki. Osaka is for eating — budget accordingly. Never double-dip the kushikatsu. Day trip to Nara for deer park.',
  'Mount Fuji & Hakone': 'Base in Hakone — not at Fuji Five Lakes which is overrun. Ryokan stay with onsen is non-negotiable. Views of Fuji are weather-dependent — have a backup plan. Hakone Open Air Museum is genuinely excellent. Ropeway, Lake Ashi boat, Owakudani in one loop. September-October best for clear Fuji views.',
  // THAILAND
  'Bangkok': 'Anchor in Ari, Thonglor, Ekkamai for local life — not Khao San Road. Boat noodles, pad see ew, mango sticky rice, som tam. Tuk tuks are for tourists — use BTS Skytrain and boats. Temple visits require covered shoulders/knees. April is brutally hot (Songkran festival though).',
  'Chiang Mai': 'Anchor outside the Old City moat — Nimman Road area for cafes, Santitham for local food. Khao soi is non-negotiable. Sunday Walking Street at Wualai is the best market. Doi Suthep at 6am before tour groups. November-February is perfect weather. Avoid burning season March-April.',
  'Phuket': 'Base in Kata, Kamala, or Surin — never Patong which is pure chaos. Fresh seafood, pad thai, green curry, roti. Sunset at Phromthep Cape. Hire a scooter to escape the crowds. May-October is monsoon but half the price and far fewer tourists.',
  // INDIA
  'North Goa': 'STRICT RULE: Stay within North Goa only. Do NOT mix in South Goa or Panjim locations. Anchor in Anjuna, Vagator, Assagao, Morjim, Siolim. Beach shacks for kingfish, pork vindaloo at local joints, bebinca for dessert, feni cocktails. Flea markets at Anjuna Wednesday, Arpora Saturday night. Avoid Calangute and Baga — tourist traps. November-February is peak season.',
  'South Goa': 'STRICT RULE: Stay within South Goa only. Do NOT mix in North Goa or Panjim locations. Anchor in Palolem, Agonda, Colva, Benaulim. Far quieter and more laid-back than North Goa. Fresh catch at beach shacks, Goan fish curry rice, prawn balchão. Cotigao Wildlife Sanctuary for nature. May-September is monsoon — many places shut.',
  'Mumbai': 'Anchor by area: Bandra for cafes and nightlife, Colaba for history, Dharavi for reality, Mahalaxmi for local Mumbai. Vada pav, pav bhaji, bhel puri at Chowpatty, Irani chai, keema pav. Local train is essential experience but avoid rush hour (8-10am, 6-8pm). Monsoon July-August transforms the city — dramatic but wet.',
  // SRI LANKA
  'Colombo': 'Anchor in Colombo 7 (Cinnamon Gardens), Pettah for chaos and street food, Galle Face for sunsets. Kottu roti, hoppers, string hoppers, lamprais, pol sambol. Tuk tuks negotiate hard — agree price first. June-October is southwest monsoon — wet but manageable.',
  'Galle': 'The Fort is the anchor — colonial Dutch architecture, boutique stays, excellent restaurants. Stick to the Fort and nearby beaches (Unawatuna, Jungle Beach). Crab curry, fresh tuna, wood apple juice. Walk the Fort ramparts at sunset. December-April is peak and beautiful.',
  'Kandy': 'Temple of the Tooth is the centrepiece — go for evening puja ceremony. Anchor in the lake area. Kandyan cuisine: mild curries, woodapple, buffalo curd with treacle. Day trip to Pinnawala Elephant Orphanage or Peradeniya Botanical Gardens. August Esala Perahera festival is extraordinary but crowded.',
  // VIETNAM
  'Hanoi': 'Anchor in the Old Quarter but sleep on its edges — Hoan Kiem lake area. Bun cha, pho bo, banh mi, egg coffee, bun rieu. Traffic is organised chaos — walk confidently and steadily. Weekend nights: Hoan Kiem pedestrian zone comes alive. October-April is best weather.',
  'Hoi An': 'The Ancient Town is a UNESCO site — beautiful but heavily touristed. Go at 6am for empty streets. Anchor outside the centre: An Bang Beach area. White rose dumplings, cao lau (only authentic in Hoi An), banh mi Phuong. Hire a bicycle — town is perfectly sized for it. February-July best weather.',
  'Ho Chi Minh City': 'Anchor in District 1 and District 3 — not District 10 which is residential. Banh mi, hu tieu, broken rice (com tam), fresh spring rolls, ca phe sua da. War Remnants Museum is essential but heavy. Cu Chi Tunnels as a day trip. Grab bikes beat taxis. November-April is dry season.',
  // KENYA
  'Nairobi': 'Anchor in Westlands and Karen — not the CBD which feels unsafe for tourists. Nyama choma, ugali, sukuma wiki, Kenyan chai. Giraffe Centre and David Sheldrick Elephant Orphanage are genuinely excellent. Nairobi National Park is 20 minutes from the city centre — unique. Use Bolt/Uber only.',
  'Maasai Mara': 'July-October for the Great Migration — wildebeest crossing the Mara River. Base at a camp inside or adjacent to the reserve. Bush breakfasts, sundowner drinks, night game drives. Big Five likely in any season. Hot air balloon at dawn is worth the cost. Fly from Nairobi — road is brutal.',
  'Diani Beach': 'South Coast beach anchored at Diani — white sand, palm trees, reef snorkelling. Fresh grilled fish, coconut rice, Swahili biryani. Shimba Hills day trip for elephant and sable antelope. Colobus monkeys in the trees above the beach. January-March and July-October are best weather.',
  // SPAIN
  'Madrid': 'Anchor in Malasaña, Lavapiés, and Chueca — not Gran Via. Bocadillo de calamares, cocido Madrileño, patatas bravas, churros con chocolate at San Ginés. Lunch is at 2-3pm, dinner at 9-10pm — adjust your schedule. El Rastro flea market Sunday mornings. August: half of Madrid leaves — quieter but some places shut.',
  'Barcelona': 'Anchor in Gràcia, El Born, Poblenou — avoid Las Ramblas completely. Pa amb tomàquet, fideuà, croquetes, vermouth at noon. Sagrada Familia requires advance booking only. Barceloneta beach is mediocre — locals go to Bogatell or Mar Bella. June-August: hot, crowded, and expensive.',
  'Seville': 'Anchor in Triana and El Arenal — not Santa Cruz which is beautiful but touristy. Pescaíto frito, pringá montadito, gazpacho, manzanilla sherry. Flamenco at Casa de la Memoria (book ahead). Cathedral and Alcázar at opening time only. April (Feria) and May are extraordinary. July-August is brutally hot (45°C+).',
  // GREECE
  'Athens': 'Anchor in Monastiraki, Psiri, Exarcheia — not Plaka which is a tourist trap. Souvlaki, spanakopita, loukoumades, fresh seafood in Piraeus. Acropolis at 8am opening — never midday. Sunset from Filopappou Hill beats the expensive rooftop bars. April-June and September-October are perfect.',
  'Santorini': 'Oia sunset is overhyped and overcrowded — watch from Imerovigli instead. Base in Firostefani or Akrotiri — not Oia which is overpriced. Fresh tomato fritters, fava dip, grilled octopus, Assyrtiko wine. Caldera boat trip to hot springs and volcano. April-May and September-October are ideal — avoid July-August.',
  'Mykonos': 'Go for beaches and nightlife — not culture (there is very little). Psarou and Elia beaches for daytime. Little Venice for sunset drinks. Hora for evening wandering. Fresh seafood, loukoumades, Greek salad. Nightlife starts at midnight. June-September only — it shuts down in winter. Book everything 3 months ahead in July-August.',
};

function getSystemPrompt(city, month, travelStyle, budget) {
  const monthName = month ? MONTH_NAMES[month] : null;
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle;
  const budgetLabel = BUDGET_LABELS[budget] || budget;

  // Build destination context — handles both single city and "City A and City B and City C"
  const cityList = city.split(' and ').map(c => c.trim());
  const destinationContext = cityList
    .map(c => DESTINATION_CONTEXT[c] ? `${c.toUpperCase()}: ${DESTINATION_CONTEXT[c]}` : '')
    .filter(Boolean)
    .join('\n\n')
    || DESTINATION_CONTEXT[city] || '';

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

  return `You are Rome Curator's local expert for ${city} — a deeply knowledgeable friend who has lived in ${city} for years, eats obsessively well, and hates tourist traps.

DESTINATION KNOWLEDGE:
${destinationContext}

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
      <a href="https://romecurator.com" style="display:inline-block;background:#B85C38;color:white;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:14px;font-weight:500;letter-spacing:1px;">Plan another trip →</a>
    </div>
    <div style="background:#1C1410;padding:20px 24px;text-align:center;">
      <p style="color:#7A6355;font-size:11px;margin:0 0 6px;line-height:1.6;">This itinerary was AI-generated and is a starting point. Always verify opening hours, prices, and bookings before your trip.</p>
      <p style="color:#4A3728;font-size:11px;margin:0;">© 2025 Rome Curator · <a href="https://romecurator.com" style="color:#D4845A;text-decoration:none;">Visit the app</a></p>
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
        from: 'Rome Curator <hello@romecurator.com>',
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
    const { city, cities, isMultiCity, days, pace, month, travelStyle, budget, interests } = req.body;
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

    // ── Cache check (single city only, 6 month window) ────────────
    if (!isMultiCity) {
      const cached = await findCachedItinerary(city, days, pace, month, travelStyle, budget, interests);
      if (cached) {
        console.log(`[generate] Cache hit | slug: ${cached.slug}`);
        return res.json({ ...cached.data, slug: cached.slug, fromCache: true });
      }
    }

    const monthName = month ? MONTH_NAMES[month] : null;
    const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle || 'traveller';

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: getTokenLimit(days, isMultiCity),
      system: getSystemPrompt(isMultiCity ? cities.join(' and ') : city, month, travelStyle, budget),
      messages: [{
        role: "user",
        content: isMultiCity
          ? `Plan a ${days}-day multi-city itinerary across ${cities.join(', ')} in that order.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Decide how to split the ${days} days across the cities — allocate more days to cities that warrant it.
For each city section, stay strictly within that city only. Do not mix locations between cities.
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`
          : `Plan a ${days}-day itinerary for ${city}.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`,
      }],
    });

    const raw = message.content.find(b => b.type === "text")?.text || "";

    // Robustly extract JSON — strip markdown fences, then find first { and last }
    let itinerary;
    try {
      const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found');
      const clean = stripped.slice(start, end + 1);
      itinerary = JSON.parse(clean);
    } catch {
      console.error("[generate] JSON parse failed:", raw.slice(0, 300));
      return res.status(500).json({ error: "Failed to parse itinerary. Please try again." });
    }

    console.log(`[generate] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);

    // ── Save to Supabase ──────────────────────────────────────────
    const slug = generateSlug();
    await saveItinerary(slug, city, days, pace, month, travelStyle, budget, interests, itinerary);
    console.log(`[generate] Saved | slug: ${slug}`);

    return res.json({ ...itinerary, slug });

  } catch (err) {
    console.error("[generate] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong generating your itinerary. Please try again." });
  }
});

// ── Generate itinerary (streaming) ───────────────────────────────
app.post("/generate-itinerary-stream", limiter, async (req, res) => {
  try {
    const { city, cities, isMultiCity, days, pace, month, travelStyle, budget, interests } = req.body;
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
    console.log(`[generate-stream] IP: ${ip} | City: ${city} | Days: ${days} | Style: ${travelStyle} | Budget: ${budget} | Count: ${usageByIP[ip].generations}`);

    // ── Cache check (single city only, 6 month window) ────────────
    if (!isMultiCity) {
      const cached = await findCachedItinerary(city, days, pace, month, travelStyle, budget, interests);
      if (cached) {
        console.log(`[generate-stream] Cache hit | slug: ${cached.slug}`);
        // For cache hits, stream is unnecessary — send as SSE done event immediately
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'done', itinerary: { ...cached.data, slug: cached.slug, fromCache: true } })}\n\n`);
        return res.end();
      }
    }

    const monthName = month ? MONTH_NAMES[month] : null;
    const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle || 'traveller';

    // ── Set SSE headers ───────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // ── Stream from Claude ────────────────────────────────────────
    let rawText = '';
    const stream = await anthropic.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: getTokenLimit(days, isMultiCity),
      system: getSystemPrompt(isMultiCity ? (cities || [city]).join(' and ') : city, month, travelStyle, budget),
      messages: [{
        role: "user",
        content: isMultiCity
          ? `Plan a ${days}-day multi-city itinerary across ${(cities || [city]).join(', ')} in that order.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Decide how to split the ${days} days across the cities — allocate more days to cities that warrant it.
For each city section, stay strictly within that city only. Do not mix locations between cities.
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`
          : `Plan a ${days}-day itinerary for ${city}.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`,
      }],
    });

    // Stream each text chunk to client
    stream.on('text', (text) => {
      rawText += text;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
    });

    // When stream ends, parse JSON and save
    stream.on('finalMessage', async (message) => {
      let itinerary;
      try {
        const stripped = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        const start = stripped.indexOf('{');
        const end = stripped.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON found');
        const clean = stripped.slice(start, end + 1);
        itinerary = JSON.parse(clean);
      } catch {
        console.error("[generate-stream] JSON parse failed:", rawText.slice(0, 300));
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to parse itinerary. Please try again.' })}\n\n`);
        return res.end();
      }

      console.log(`[generate-stream] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);

      // Save to Supabase
      const slug = generateSlug();
      await saveItinerary(slug, city, days, pace, month, travelStyle, budget, interests, itinerary);
      console.log(`[generate-stream] Saved | slug: ${slug}`);

      // Send final parsed itinerary
      res.write(`data: ${JSON.stringify({ type: 'done', itinerary: { ...itinerary, slug } })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error("[generate-stream] Stream error:", err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong. Please try again.' })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log('[generate-stream] Client disconnected');
      stream.abort?.();
    });

  } catch (err) {
    console.error("[generate-stream] Error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Something went wrong generating your itinerary. Please try again." });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong. Please try again.' })}\n\n`);
    res.end();
  }
});

// ── Get itinerary by slug (shareable links) ───────────────────────
app.get("/itinerary/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug || slug.length > 20) return res.status(400).json({ error: "Invalid slug." });
    const record = await getItineraryBySlug(slug);
    if (!record) return res.status(404).json({ error: "Itinerary not found." });
    return res.json({ ...record.data, slug: record.slug, city: record.city });
  } catch (err) {
    console.error('[slug] Error:', err.message);
    return res.status(500).json({ error: "Something went wrong." });
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
      const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found');
      const clean = stripped.slice(start, end + 1);
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
