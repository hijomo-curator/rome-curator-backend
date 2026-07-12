import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import https from "https";

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

// The SDK's default HTTP agent reuses (keep-alive) TCP/TLS connections across
// requests for speed. Across our back-to-back chunk calls — fired seconds
// apart from a long-lived Render instance to api.anthropic.com — a pooled
// connection can go stale (closed server/network-side without the client
// agent noticing) and the next request on it fails as a generic
// ERR_STREAM_PREMATURE_CLOSE / AnthropicError with no HTTP status at all,
// which matches exactly what we were seeing in Render logs. Disabling
// keep-alive forces a fresh connection per request — costs a small amount
// of extra TLS handshake time (tens of ms), which is negligible against our
// 15-30+ second generation calls, in exchange for eliminating this failure
// class entirely.
const anthropicAgent = new https.Agent({ keepAlive: false });
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  httpAgent: anthropicAgent,
  timeout: 120000, // 2 min per request — generous for a single chunk call, fails fast if something's truly stuck
  maxRetries: 1,   // SDK-level retry as a second layer under our own application-level retry
});

// ── Supabase helpers ──────────────────────────────────────────────
function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const CACHE_MONTHS = 6;

async function findCachedItinerary(city, days, pace, month, travelStyle, budget, foodPreference, interests) {
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
      .eq('food_preference', foodPreference)
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

async function saveItinerary(slug, city, days, pace, month, travelStyle, budget, foodPreference, interests, data) {
  try {
    const { data: result, error } = await supabase.from('itineraries').insert({
      slug, city, days, pace, month, travel_style: travelStyle,
      budget, food_preference: foodPreference, interests, data
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

// ── In-progress generation tracking (for resumability) ─────────────
// Keyed by client-generated requestId. Stored in-memory (Render single
// instance, no horizontal scaling) — survives tab-switch/reconnect within
// the same server process lifetime, which covers the actual failure case.
const progressByRequestId = {};
const PROGRESS_TTL_MS = 15 * 60 * 1000; // 15 min — plenty for any generation

function initProgress(requestId, totalDays) {
  progressByRequestId[requestId] = {
    days: [],          // completed day objects, in order
    title: null,
    meta: null,
    dayAllocation: null,
    totalDays,
    status: 'in_progress', // 'in_progress' | 'done' | 'error'
    slug: null,
    error: null,
    createdAt: Date.now(),
  };
}

function appendProgress(requestId, newDays, { title, meta, dayAllocation } = {}) {
  const p = progressByRequestId[requestId];
  if (!p) return;
  p.days.push(...newDays);
  if (title) p.title = title;
  if (meta) p.meta = meta;
  if (dayAllocation) p.dayAllocation = dayAllocation;
}

function finishProgress(requestId, slug) {
  const p = progressByRequestId[requestId];
  if (!p) return;
  p.status = 'done';
  p.slug = slug;
}

function errorProgress(requestId, message) {
  const p = progressByRequestId[requestId];
  if (!p) return;
  p.status = 'error';
  p.error = message;
}

// Periodic cleanup of stale progress entries
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(progressByRequestId)) {
    if (now - progressByRequestId[id].createdAt > PROGRESS_TTL_MS) {
      delete progressByRequestId[id];
    }
  }
}, 5 * 60 * 1000);

const MAX_GENERATIONS = 5;
const MAX_REFINEMENTS = 10;
const usageByIP = {};

// ── Trip shape limits — mirrors frontend enforceDaysCap/onCityCheckboxChange ──
const MAX_CITIES = 4;
const MAX_DAYS_SINGLE = 7;
const MAX_DAYS_MULTI = 10;
const MIN_DAYS_MULTI = 6;    // 2-3 cities
const MIN_DAYS_4_CITY = 9;   // 4 cities — 9 days / 8 nights, ~2 nights per city floor
const MAX_INTERESTS_UNIVERSAL = 5;  // "Your interests" — independent cap, mirrors frontend
const MAX_SPECIALS_PER_CITY = 2;    // each city's specials — own independent cap, additive across cities

// Returns an error string if the trip shape is invalid, otherwise null.
// NOTE: the interests array arrives as a flat list of strings with no
// tag distinguishing "universal" from "city special" or which city a
// special belongs to (the frontend doesn't send that structure). So the
// most we can validate server-side is the worst-case ceiling: 5 universal
// + 2 per selected city. This can't catch someone sending 5 universal-looking
// values that are actually all city specials for one city, but it does
// catch any genuinely excessive payload, and the real enforcement (which
// chip can be active at all) lives in the frontend's per-scope caps.
function validateTripShape({ isMultiCity, days, cities, city, interests }) {
  if (days < 1 || days > MAX_DAYS_MULTI) {
    return `Days must be between 1 and ${MAX_DAYS_MULTI}.`;
  }
  const cityCount = isMultiCity ? (cities || (city ? city.split(' and ') : [])).length : 1;
  if (Array.isArray(interests)) {
    const maxInterests = MAX_INTERESTS_UNIVERSAL + (cityCount * MAX_SPECIALS_PER_CITY);
    if (interests.length > maxInterests) {
      return `Please select at most ${maxInterests} interests for a ${cityCount}-city trip.`;
    }
  }
  if (!isMultiCity) {
    if (days > MAX_DAYS_SINGLE) return `Single city itineraries are limited to ${MAX_DAYS_SINGLE} days.`;
    return null;
  }
  if (cityCount > MAX_CITIES) return `Multi-city trips are limited to ${MAX_CITIES} cities.`;
  const minDays = cityCount >= MAX_CITIES ? MIN_DAYS_4_CITY : MIN_DAYS_MULTI;
  if (days < minDays) return `A ${cityCount}-city trip needs at least ${minDays} days.`;
  return null;
}

function getIP(req) { return req.ip || req.connection.remoteAddress || "unknown"; }
function initUsage(ip) { if (!usageByIP[ip]) usageByIP[ip] = { generations: 0, refinements: 0 }; }
function getTokenLimit(days, isMultiCity, cityCount = 1) {
  // Base token budget scales with duration
  let base;
  if (days <= 3)       base = 2500;
  else if (days <= 5)  base = 3500;
  else if (days <= 8)  base = 5500;
  else                 base = 7500; // 9-10 days
  // Multi-city: +800 tokens per extra city (routing, transitions, day splits)
  if (isMultiCity && cityCount > 1) base += (cityCount - 1) * 800;
  return base;
}

// ── Chunking: split a day count into batches of ≤4 days ───────────
// e.g. 10 -> [4, 4, 2] | 8 -> [4, 4] | 6 -> [4, 2] | 3 -> [3]
const MAX_DAYS_PER_CHUNK = 4;
function getDayChunks(totalDays) {
  const chunks = [];
  let remaining = totalDays;
  while (remaining > 0) {
    const take = Math.min(MAX_DAYS_PER_CHUNK, remaining);
    chunks.push(take);
    remaining -= take;
  }
  return chunks; // array of day-counts per chunk
}

// ── Token limit for a single chunk (not the whole trip) ───────────
function getChunkTokenLimit(chunkDays, isMultiCity, cityCount = 1) {
  // Roughly proportional to a 1-4 day single-call budget, with small overhead per day
  let base = 900 + chunkDays * 700; // ~1 day:1600, 4 days:3700
  if (isMultiCity && cityCount > 1) base += (cityCount - 1) * 400;
  return Math.min(base, 5000); // safety ceiling per chunk
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

// ── Food preference: dietary directive injected into every prompt ──
const VALID_FOOD_PREFERENCES = ['any', 'vegetarian', 'vegan', 'non_veg'];
function normalizeFoodPreference(fp) {
  return VALID_FOOD_PREFERENCES.includes(fp) ? fp : 'any';
}

const FOOD_PREFERENCE_LABELS = {
  any: 'no dietary restriction',
  vegetarian: 'vegetarian',
  vegan: 'vegan',
  non_veg: 'no restriction — especially enjoys meat and seafood',
};

function getFoodPreferenceDirective(foodPreference) {
  switch (foodPreference) {
    case 'vegetarian':
      return `\nDIETARY REQUIREMENT — VEGETARIAN: every food recommendation (restaurants, street food, dishes) must be vegetarian. No meat, poultry, or fish/seafood dishes anywhere, in any meal. If the destination's signature food culture leans heavily on meat or seafood, actively find and name the best vegetarian-friendly spots and dishes instead of skipping the food anchor for that day.`;
    case 'vegan':
      return `\nDIETARY REQUIREMENT — VEGAN: every food recommendation must be fully vegan — no meat, fish, dairy, eggs, or honey. Where a well-known local dish needs a modification to be vegan, say so explicitly (e.g. "order it without the yoghurt topping"). If the destination isn't naturally vegan-friendly, actively find the best vegan-friendly spots rather than dropping the food anchor for that day.`;
    case 'non_veg':
      return `\nDIETARY PREFERENCE — NON-VEGETARIAN FOCUS: this traveller especially enjoys meat and seafood. Prioritise the destination's best meat and seafood dishes and restaurants as the food anchor wherever it fits the local cuisine.`;
    default:
      return ''; // 'any' — no dietary constraint, existing behaviour unchanged
  }
}

// ── Traveller safety & wellbeing guardrails — GLOBAL, applies to every
// destination. These exist because "local beats touristy" curation, left
// unchecked, can push toward genuinely unsafe or unwise recommendations
// for a traveller with no local context to fall back on. This overrides
// the authenticity bias, not the other way around.
const SAFETY_GUARDRAILS = `
TRAVELLER SAFETY & WELLBEING — THESE RULES OVERRIDE "LOCAL BEATS TOURISTY":
- Never recommend independently walking, eating, or exploring inside informal settlements, slums, or comparable low-income informal urban areas (e.g. Dharavi in Mumbai, favelas in Rio de Janeiro or São Paulo) — regardless of how authentic, "real," or photogenic the experience is. If a reputable, established guided-tour operator exists for that area, you may mention it as an optional GUIDED add-on only — never as a self-guided activity, and never as the day's anchor.
- Never recommend a specific food vendor, stall, or restaurant located inside an informal settlement/slum, for the same reason — no exceptions, however famous it is locally.
- For religious or spiritual sites: only recommend major, securely managed heritage/tourist sites with established visitor infrastructure (e.g. a protected monument). Avoid recommending active community religious sites in contexts with real communal or religious tension, even if historically or architecturally significant — the risk isn't the site itself, it's a traveller unknowingly walking into local social tension they have no context to navigate.
- Only name a specific small/independent food vendor, stall, or hole-in-the-wall if you have genuine confidence it is a real, long-established, well-regarded local institution — never invent a plausible-sounding specific name just to sound authentic. If you're not confident a specific place is real and well-regarded, describe the TYPE of place and area instead of fabricating a name (e.g. "a well-known breakfast spot near the station" rather than naming one you're unsure of).
- These rules apply regardless of budget level or how highly an "authentic, local" recommendation would otherwise score — traveller safety and health always take priority over authenticity.`;

const SAFETY_GUARDRAILS_LITE = `- SAFETY OVERRIDE (non-negotiable): never recommend self-guided access to informal settlements/slums (e.g. Dharavi, favelas) — guided tours only, never the day's anchor, and never a food vendor inside one. For religious sites, only recommend securely managed heritage/tourist sites, not community sites with religious-tension risk. Only name specific small vendors you're genuinely confident are real, established, well-regarded places — otherwise describe the type of place rather than inventing a name.`;

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
  'Mumbai': 'Anchor by area: Bandra for cafes and nightlife, Colaba for history, Fort/CST for colonial architecture, Mahalaxmi for local Mumbai. Vada pav, pav bhaji, bhel puri at Chowpatty, Irani chai, keema pav — only name specific stalls/joints you are confident are genuinely well-established local institutions, never an invented-sounding street stall. Local train is essential experience but avoid rush hour (8-10am, 6-8pm). SAFETY NOTE (see global rules above): do not recommend Dharavi as a self-guided walking destination or food stop under any framing — if mentioned at all, only as an optional guided tour with a reputable operator, never the day\'s anchor. Do not recommend Haji Ali Dargah or its food stalls at all, regardless of popularity. Monsoon July-August transforms the city — dramatic but wet.',
  'Pune': 'Pune\'s old city (Sadashiv Peth, Shaniwar Wada) carries genuine Peshwa-era history, often overlooked by IT-crowd visitors sticking to Koregaon Park. Sinhagad Fort just outside the city is a popular but genuinely worthwhile morning trek with valley views. Pune\'s food scene is fiercely proud and distinct — misal pav, Bakarwadi, and Puneri-style breakfast at Bedekar or Vaishali are the anchors, not just Mumbai spillover food. October-February is the most pleasant weather; April-May gets very hot.',
  'Alibaug': 'Alibaug is Mumbai\'s weekend escape, but skip the crowded main beach in favour of Kihim, Nagaon, or Varsoli. Kolaba Fort is only accessible by foot at low tide — check timings before you go, it\'s a genuinely atmospheric walk. Farmhouse stays outside the main town offer a quieter alternative to hotels. Fresh Konkani seafood (surmai, pomfret, bombil fry) is the food anchor. November-February is ideal; monsoon (June-September) is dramatic with rough seas but many places stay open, being a monsoon-getaway spot too.',
  'Matheran': 'Matheran is one of the few genuinely vehicle-free hill stations in India — everything is on foot or horseback, and the red laterite soil trails are part of the experience. Skip the crowded main market viewpoints (Echo Point) for quieter spots like Louisa Point or Monkey Point at sunset. The narrow-gauge toy train from Neral is scenic but slow — worth it once. Simple Maharashtrian home food and Parsi-style snacks (a legacy of old colonial visitors) are available in the small market. October-June is accessible; the toy train often suspends service during peak monsoon (July-August) due to landslide risk.',
  'Lonavala': 'Lonavala is best known as a monsoon getaway — Bhushi Dam and the surrounding waterfalls come alive June-September, though they get extremely crowded on weekends. Less known: the 2,000-year-old Buddhist rock-cut caves at Bhaja and Karla, genuinely impressive and far less crowded than the town center. Tiger\'s Leap and Lion\'s Point offer valley views without the chikki-shop crowds. Chikki (a jaggery-nut brittle) is the local specialty alongside simple Maharashtrian food. Weekdays are dramatically quieter than weekends given its proximity to Mumbai and Pune.',
  'Mahabaleshwar': 'Mahabaleshwar\'s strawberry farms (best visited March-May during peak season) are worth a real farm visit, not just the roadside stalls. Pratapgad Fort, a genuine Shivaji-era hill fort with a steep climb, is a half-day trip with excellent Sahyadri views. Arthur\'s Seat and Elephant\'s Head Point are the least crowded of the main viewpoints. Strawberry-and-cream, along with simple Maharashtrian ghat-station food, are the local specialties. It\'s among the wettest places in India during monsoon (June-September) — waterfalls are spectacular but roads can be treacherous.',
  'Nashik': 'Nashik is India\'s wine capital — Sula and York are the famous names, but smaller boutique vineyards offer quieter, more personal tastings. Trimbakeshwar Temple, one of the twelve Jyotirlingas, anchors the old town, while Panchavati\'s ghats along the Godavari river carry deep Ramayana-era significance. Misal pav here rivals Pune\'s, and the surrounding grape country has excellent farm-to-table options. October-February is the most pleasant weather; April-May gets very hot for daytime sightseeing.',
  'Sindhudurg': 'Sindhudurg Fort, built by Shivaji on an island off Malvan, is reachable only by a short ferry ride and is genuinely worth the trip for its scale and sea views. Tarkarli beach nearby has some of India\'s clearest coastal water, with real scuba diving and snorkelling operators (not the Goa-style tourist-trap version). Malvani cuisine here is fiercely good — solkadhi, bombil fry, and kombdi vade (chicken with fried bread) are the anchors. November-February is ideal for calm seas and diving visibility; monsoon (June-September) is beautiful but rough seas shut down water activities.',
  'Jaisalmer': 'Jaisalmer Fort is a living fort — people still live inside its walls, unlike Amber or Mehrangarh. Anchor in the fort\'s havelis (Patwon ki Haveli, Nathmal ki Haveli) and the old city lanes. Desert safari to Sam or Khuri dunes for sunset and overnight camping — book a camp away from the loud tourist ones. Dal baati churma, ker sangri, and kalakand are the food anchors. October-March only — summers are dangerously hot (45°C+).',
  'Pushkar': 'Pushkar is entirely vegetarian and alcohol-restricted — a holy town circling a sacred lake with 52 ghats. Brahma Temple is one of the only temples to Brahma in the world. Anchor evenings on the ghats at sunset. Rooftop cafes (Sixth Sense, Honey & Spice) for laid-back meals — malpua, lassi, and Rajasthani thali are the food anchors. November brings the famous Camel Fair — spectacular but very crowded; October and December-February are quieter and equally beautiful.',
  'Alleppey': 'Alleppey is the backwater capital — but skip the big commercial houseboats docked at the jetty and anchor instead in the quieter canals around Kumarakom or the village routes near Mannarasala. A houseboat overnight is worth it, but a village canoe tour through Kainakary sees the real, lived-in backwaters. Kerala sadya (banana leaf thali), toddy shop meals (fish curry, kappa), and fresh prawns are the food anchors. November-February is the best weather; June-September is heavy monsoon but the backwaters are at their greenest.',
  'Varkala': 'Varkala is built around its dramatic red cliff overlooking the Arabian Sea — the cliff-top strip has cafes and shops, but Odayam and Edava beaches just north are quieter and better for actually swimming. Ayurvedic massage and yoga retreats are genuinely worth doing here, not just a gimmick. Fresh seafood grills along the cliff, and Kerala-style fish curry inland. November-March is the best weather; monsoon (June-September) is dramatic but many cliff businesses shut.',
  'Gokarna': 'Gokarna is a temple town first, beach town second — Mahabaleshwar Temple anchors the old town, while Om Beach, Kudle, and Half Moon are a short walk or boat ride along the coast. Half Moon and Paradise beaches are quieter and only reachable by boat or trek — worth the effort. Simple beach shack thalis, fresh fish, and coconut-based Karnataka coastal food are the anchors. October-March is best; it shuts down considerably in monsoon (June-September).',
  'Coorg': 'Coorg (Kodagu) is coffee country — stay at a working estate homestay, not a resort, for the real experience. Abbey Falls and Mandalpatti viewpoint for the misty Western Ghats views; Dubare for elephant camps. Kodava cuisine is distinct from the rest of Karnataka — pandi curry (pork), kadambuttu (rice dumplings), and akki roti are the anchors. October-March is best; June-September monsoon is spectacular but very wet and many roads get difficult.',
  'Warangal': 'Warangal is Kakatiya-dynasty country — the Thousand Pillar Temple and Warangal Fort\'s four iconic gateways (kakatiya kala thoranam) anchor the old town. Ramappa Temple, a UNESCO World Heritage site, is a worthwhile half-day trip out. Telangana home cooking here — sarva pindi, jonna rotte, and gongura-based curries — is distinct from the Hyderabadi food most tourists know. November-February is best; summers (April-June) are brutally hot.',
  'Vishakhapatnam': 'Vizag is a port city with genuinely good beaches (RK Beach, Rushikonda) and Kailasagiri hill for sunset views. The real highlight is a day trip to Araku Valley — coffee plantations, tribal museum, and the scenic toy train route through the Eastern Ghats. Andhra food is fiercely spicy here — Gongura mutton, Royyala (prawn) curry, and Pulasa fish (seasonal, expensive, worth it) are the anchors. November-February is the best weather; avoid the peak summer heat of April-June.',
  'Pondicherry': 'Pondicherry\'s French Quarter (White Town) is genuinely lovely at dawn before the day-trippers arrive — go early. Auroville is worth a real half-day, not just a Matrimandir photo stop — explore the community\'s cafes and shops beyond the viewing point. Franco-Tamil fusion (at Villa Shanti, Cafe des Arts style spots) alongside proper Tamil thalis and fresh seafood are the food anchors. November brings the northeast monsoon and occasional flooding — December-February is the best window.',
  'Ooty': 'Ooty\'s Nilgiri Mountain Railway (the "toy train") is UNESCO-listed and genuinely worth doing, but book well ahead — it sells out. Beyond the town center, walk a working tea estate (many offer tours) and go to Doddabetta Peak early morning before the crowds. Skip Ooty Lake\'s paddle boats — better views are at quieter spots like Avalanche or Emerald Lake. Homemade chocolate, Nilgiri tea, and simple Tamil hill-station food are the anchors. Bring warm layers year-round — nights are cold even in summer.',
  'Kodaikanal': 'Kodaikanal\'s star-shaped lake is the town\'s anchor, but skip the crowded boat rentals and instead walk or cycle the full perimeter early morning. Coaker\'s Walk and Pillar Rocks are best at sunrise before clouds roll in. Dolphin\'s Nose and Guna Caves are further out but worth a half-day. Homemade chocolate and plum cake are genuine local specialties (not just tourist tat) alongside simple Tamil hill food. Bring warm layers — it\'s cold year-round, and monsoon (June-September) brings heavy mist and rain.',
  'Srinagar': 'Srinagar\'s Dal Lake houseboats are genuinely worth staying in, but pick one away from the main tourist ghat for a quieter experience — a sunrise shikara ride through the floating vegetable market is unmissable. The old city (Rainawari, Nowhatta) has Mughal-era architecture most tourists skip in favour of the gardens alone. A proper Kashmiri wazwan feast (multi-course, mutton-heavy — rogan josh, gushtaba, yakhni) needs pre-booking at a local home or restaurant. April-June and September-October are ideal weather; winter (December-February) brings snow and a very different, quieter Srinagar.',
  'Khajuraho': 'Khajuraho\'s Western Group of temples (UNESCO) is the famous one, but the quieter Eastern and Southern groups have equally fine carvings with a fraction of the crowds. Go at opening time to beat both heat and tour buses. The evening light & sound show at the Western Group is worth doing once. Bundelkhandi food — bhutte ka kees, dal bafla — is distinct from typical North Indian fare. October-March is the only sensible window; summers (April-June) are extremely hot.',
  'Gangtok': 'Gangtok\'s MG Marg is pleasant but touristy — the real texture is in Buddhist monasteries like Rumtek and Enchey, and a day trip up to Tsomgo Lake and Nathula Pass (permits required, arrange in advance). Himalayan views of Kanchenjunga are best on clear mornings, especially October-November. Sikkimese-Tibetan food — thukpa, momos, gundruk — is genuinely different from mainland Indian cuisine. Avoid monsoon (June-August) for landslide risk on mountain roads; October-November and March-May are the best windows.',
  'Guwahati': 'Guwahati is usually treated as just a gateway to Kaziranga or Shillong, but it deserves its own day — Kamakhya Temple on Nilachal Hill for both the pilgrimage site and river views, and a sunset cruise on the Brahmaputra, one of the world\'s widest rivers. Assamese thalis (masor tenga, duck curry, khar) are distinct from anything else in India. October-March is the best weather; monsoon (June-September) is heavy and can disrupt travel to nearby Kaziranga.',
  'Shillong': 'Shillong is the base for the living root bridges near Cherrapunji and Mawlynnong (Asia\'s cleanest village) — both worth full day trips, with the double-decker root bridge trek being physically demanding but extraordinary. In town, Ward\'s Lake and Police Bazaar anchor the center, but the real charm is Shillong\'s genuine cafe culture and Khasi tribal heritage. Khasi food (smoked pork, jadoh rice) alongside the cafe scene\'s baked goods are the anchors. This is one of the wettest places on Earth — June-August sees relentless rain; October-April is far more manageable.',
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
  // SWEDEN
  'Stockholm': 'Anchor in Södermalm and Östermalm — not the tourist-heavy Gamla Stan (though it is worth one morning). Smörgåsbord, meatballs with lingonberry, gravlax, cinnamon buns (kanelbulle) from a local konditori, and craft beer from a Söder bar. The archipelago is 30 minutes away by ferry — essential in summer. Djurgården island has three world-class museums in one easy walk. June-August is golden and long-lit; December is dark but hygge-filled with Christmas markets. The T-bana (metro) doubles as an art gallery — buy a 24-hour pass.',
};

// ── Lite system prompt: single city ≤4 days (saves ~40% input tokens) ──
function getLiteSystemPrompt(city, month, travelStyle, budget, foodPreference) {
  const monthName = month ? MONTH_NAMES[month] : null;
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle;
  const budgetLabel = BUDGET_LABELS[budget] || budget;
  const destContext = DESTINATION_CONTEXT[city] || '';
  const soloFemaleNote = travelStyle === 'solo_female' ? 'Prioritise well-lit busy areas for evenings. Add brief safety notes for off-beat spots.' : '';
  const elderlyNote = travelStyle === 'family_elderly' ? 'Avoid excessive walking/climbing. Prefer accessible venues.' : '';
  const familyNote = travelStyle === 'family_kids' ? 'One child-friendly activity per day. Keep sights varied, restaurants relaxed.' : '';
  const specialNote = [soloFemaleNote, elderlyNote, familyNote].filter(Boolean).join(' ');
  const foodNote = getFoodPreferenceDirective(foodPreference);
  return `You are a local expert for ${city} — a well-travelled friend who hates tourist traps and eats obsessively well.

DESTINATION: ${city}
${destContext}

TRIP: ${styleLabel} · ${budgetLabel}${monthName ? ` · ${monthName}` : ''}${specialNote ? `\n${specialNote}` : ''}${foodNote}

RULES:
- Local always beats touristy. Food anchors every day. Name exact places, dishes, streets.
- Plan in walkable clusters. One iconic landmark per day max. Warn about tourist traps.
- Match budget strictly. Relaxed pace = fewer stops with more time; packed = efficient routing.
${SAFETY_GUARDRAILS_LITE}
- Return ONLY valid JSON. No markdown, no text outside the JSON.
- Every morning/afternoon/evening block: exactly 3 bullet points.
- Each bullet: name the exact place, what to do/order, and why — one specific sentence.
- "why" field: exactly 2 sentences explaining the day's curation logic.

Return this exact JSON shape:
{"title":"short evocative title","meta":"e.g. 3 days · food-first · relaxed pace · mid-range budget","days":[{"day":1,"title":"short day title","morning":["bullet","bullet","bullet"],"afternoon":["bullet","bullet","bullet"],"evening":["bullet","bullet","bullet"],"why":"2-sentence rationale"}]}`;
}

function getSystemPrompt(city, month, travelStyle, budget, foodPreference) {
  const monthName = month ? MONTH_NAMES[month] : null;
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle;
  const budgetLabel = BUDGET_LABELS[budget] || budget;
  const foodNote = getFoodPreferenceDirective(foodPreference);

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
${soloFemaleNote}${elderlyNote}${familyNote}${foodNote}
${SAFETY_GUARDRAILS}

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

MULTI-CITY DAY ALLOCATION (when applicable):
- Allocate days based on richness of each destination relative to the traveller's interests.
- Major cultural cities (Rome, Tokyo, Bangkok) warrant 3-4 days. Transit or compact cities (Pisa, Porto) warrant 1-2 days.
- Never exceed the total number of days requested.
- Prioritise cities with the most to offer for THIS specific traveller's interests.
- State day allocation clearly in the meta field e.g. "4 days Rome, 2 days Florence".

HARD RULES:
- Return ONLY valid JSON. No markdown, no explanation, no text outside the JSON object.
- Every morning, afternoon and evening block must have exactly 3 bullet points.
- Each bullet: name the exact place, what to order or do, and why — all in one specific sentence.
- The "why" field: exactly 2 sentences explaining the day's curation logic.

Return this exact JSON shape:
{"title":"short evocative title","meta":"e.g. 4 days · food-first · relaxed pace · mid-range budget","days":[{"day":1,"title":"short day title","morning":["bullet","bullet","bullet"],"afternoon":["bullet","bullet","bullet"],"evening":["bullet","bullet","bullet"],"why":"2-sentence rationale"}]}`;
}

// ── Build a short recap of prior chunks to avoid repeats ──────────
// Pulls out place names mentioned so far (rough heuristic: first few
// words of each bullet before a comma/dash) — kept compact to stay cheap.
function buildRecap(priorDays) {
  if (!priorDays || priorDays.length === 0) return '';
  const lines = priorDays.map(d => {
    const allBullets = [...(d.morning || []), ...(d.afternoon || []), ...(d.evening || [])];
    const places = allBullets.map(b => b.split(/[,–—-]/)[0].trim()).filter(Boolean);
    return `Day ${d.day} (${d.title || ''}): ${places.join('; ')}`;
  });
  return lines.join('\n');
}

// ── Build the user-turn instruction for one chunk of a longer trip ─
// chunkStartDay/chunkEndDay are 1-indexed inclusive day numbers within
// the FULL trip (not the chunk's own numbering).
function buildChunkUserMessage({
  city, cities, isMultiCity, totalDays, chunkStartDay, chunkEndDay,
  pace, month, travelStyle, budget, foodPreference, interests, priorDays, dayAllocation,
}) {
  const monthName = month ? MONTH_NAMES[month] : null;
  const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle;
  const recap = buildRecap(priorDays);
  const isFirstChunk = chunkStartDay === 1;
  const chunkDayCount = chunkEndDay - chunkStartDay + 1;
  const foodPrefLabel = FOOD_PREFERENCE_LABELS[foodPreference] || FOOD_PREFERENCE_LABELS.any;

  const baseContext = `Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
Dietary preference: ${foodPrefLabel}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`;

  if (isMultiCity) {
    const cityNames = (cities || [city]).join(', ');
    if (isFirstChunk) {
      return `Plan days ${chunkStartDay}-${chunkEndDay} of a ${totalDays}-day multi-city itinerary across ${cityNames} (in that order).
${baseContext}
This is the FIRST chunk. Before writing days, decide the full day allocation across ALL ${totalDays} days for all cities (e.g. "4 days Rome, 3 days Florence, 3 days Venice") and state it in the "meta" field — this allocation will guide later chunks, so commit to it now and do not revisit it.
Only WRITE OUT days ${chunkStartDay} to ${chunkEndDay} in the "days" array (day numbers ${chunkStartDay}-${chunkEndDay} only). Stay strictly within the correct city for each day per your allocation.`;
    }
    return `Continue the SAME ${totalDays}-day multi-city itinerary across ${cityNames}. This is a later chunk.
${baseContext}
Day allocation already decided: ${dayAllocation || '(see prior days for city boundaries)'}.
Already generated so far (do not repeat these places, dishes, or neighbourhoods):
${recap}

Write ONLY days ${chunkStartDay} to ${chunkEndDay} (day numbers ${chunkStartDay}-${chunkEndDay} only), continuing in the correct city per the allocation. Return just {"days":[...]} for this chunk — but EVERY day object must still include ALL fields from the schema: "day", "title", "morning" (3 bullets), "afternoon" (3 bullets), "evening" (3 bullets), AND "why" (2-sentence rationale). Do not omit "why" or any other field on these later days.`;
  }

  // Single-city chunked — used whenever a single-city trip exceeds
  // MAX_DAYS_PER_CHUNK (4). Single-city max is now 7 days, so 5-7 day
  // single-city trips commonly hit this path (not just multi-city).
  if (isFirstChunk) {
    return `Plan days ${chunkStartDay}-${chunkEndDay} of a ${totalDays}-day itinerary for ${city}.
${baseContext}
This is the FIRST chunk of a longer trip. The "meta" field must summarise the FULL ${totalDays}-day trip (e.g. "${totalDays} days · food-first · ${pace} pace · ${budget || 'mid-range'} budget"), NOT just the ${chunkDayCount} days in this chunk — later chunks will not repeat or override this value, so get the total day count right here.
Only write days ${chunkStartDay} to ${chunkEndDay} in the "days" array.`;
  }
  return `Continue the SAME ${totalDays}-day itinerary for ${city}. This is a later chunk.
${baseContext}
Already generated so far (do not repeat these places, dishes, or neighbourhoods):
${recap}

Write ONLY days ${chunkStartDay} to ${chunkEndDay} (day numbers ${chunkStartDay}-${chunkEndDay} only). Return just {"days":[...]} for this chunk — but EVERY day object must still include ALL fields from the schema: "day", "title", "morning" (3 bullets), "afternoon" (3 bullets), "evening" (3 bullets), AND "why" (2-sentence rationale). Do not omit "why" or any other field on these later days.`;
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
    const { city, cities, isMultiCity, days, pace, month, travelStyle, budget, foodPreference: foodPreferenceRaw, interests } = req.body;
    const foodPreference = normalizeFoodPreference(foodPreferenceRaw);
    const ip = getIP(req);
    initUsage(ip);

    if (!city || !days || !pace || !Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const tripError = validateTripShape({ isMultiCity, days, cities, city, interests });
    if (tripError) return res.status(400).json({ error: tripError });
    if (usageByIP[ip].generations >= MAX_GENERATIONS) {
      return res.status(429).json({ error: "Generation limit reached. Try again later." });
    }

    usageByIP[ip].generations += 1;
    console.log(`[generate] IP: ${ip} | City: ${city} | Days: ${days} | Style: ${travelStyle} | Budget: ${budget} | Food: ${foodPreference} | Count: ${usageByIP[ip].generations}`);

    // ── Cache check (single city only, 6 month window) ────────────
    if (!isMultiCity) {
      const cached = await findCachedItinerary(city, days, pace, month, travelStyle, budget, foodPreference, interests);
      if (cached) {
        console.log(`[generate] Cache hit | slug: ${cached.slug}`);
        return res.json({ ...cached.data, slug: cached.slug, fromCache: true });
      }
    }

    const monthName = month ? MONTH_NAMES[month] : null;
    const styleLabel = TRAVEL_STYLE_LABELS[travelStyle] || travelStyle || 'traveller';
    const foodPrefLabel = FOOD_PREFERENCE_LABELS[foodPreference] || FOOD_PREFERENCE_LABELS.any;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: getTokenLimit(days, isMultiCity, (cities || [city]).length),
      system: (!isMultiCity && days <= 4) ? getLiteSystemPrompt(city, month, travelStyle, budget, foodPreference) : getSystemPrompt(isMultiCity ? cities.join(' and ') : city, month, travelStyle, budget, foodPreference),
      messages: [{
        role: "user",
        content: isMultiCity
          ? `Plan a ${days}-day multi-city itinerary across ${cities.join(', ')} in that order.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
Dietary preference: ${foodPrefLabel}
${monthName ? `Travel month: ${monthName}` : ''}
Interests: ${interests.join(", ")}
Decide how to split the ${days} days across the cities — allocate more days to cities that warrant it.
For each city section, stay strictly within that city only. Do not mix locations between cities.
Food-first, local-first, walkable clusters. Name exact places, dishes, neighbourhoods.`
          : `Plan a ${days}-day itinerary for ${city}.
Pace: ${pace}
Travelling: ${styleLabel}
Budget: ${budget || 'mid-range'}
Dietary preference: ${foodPrefLabel}
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
    await saveItinerary(slug, city, days, pace, month, travelStyle, budget, foodPreference, interests, itinerary);
    console.log(`[generate] Saved | slug: ${slug}`);

    return res.json({ ...itinerary, slug });

  } catch (err) {
    console.error("[generate] Error:", err.message);
    return res.status(500).json({ error: "Something went wrong generating your itinerary. Please try again." });
  }
});

// Pulls out the useful diagnostic fields from an Anthropic SDK error,
// regardless of whether it's an APIStatusError, APIConnectionError, or a
// generic Node stream error (e.g. ERR_STREAM_PREMATURE_CLOSE). Logged on
// every chunk failure so a real cause is visible in Render logs instead
// of just the generic "Premature close" message.
function describeAnthropicError(err) {
  const parts = [`name=${err?.constructor?.name || typeof err}`, `message=${err?.message}`];
  if (err?.status) parts.push(`status=${err.status}`);
  if (err?.error) parts.push(`apiError=${JSON.stringify(err.error)}`);
  if (err?.code) parts.push(`code=${err.code}`);
  const requestId = err?.headers?.['request-id'] || err?.requestID;
  if (requestId) parts.push(`requestId=${requestId}`);
  return parts.join(' | ');
}

// ── Call Claude for one chunk, with retry on transient stream failures ──
// .stream() must NOT be awaited — it returns the MessageStream object
// synchronously and the request starts immediately, so listeners need to
// attach in the same tick (see describeAnthropicError comment above for why
// this matters for error visibility).
async function streamChunkWithRetry({ systemPromptText, userMessage, maxTokens, chunkLabel, onText, maxAttempts = 2 }) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let rawText = '';
    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: [{ type: "text", text: systemPromptText, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
      }).on('text', (text) => {
        rawText += text;
        onText(text);
      }).on('error', (err) => {
        console.error(`[generate-stream] ${chunkLabel} stream error event (attempt ${attempt}):`, describeAnthropicError(err));
      });

      const finalMessage = await stream.finalMessage();
      return { finalMessage, rawText };
    } catch (err) {
      lastErr = err;
      console.error(`[generate-stream] ${chunkLabel} attempt ${attempt}/${maxAttempts} failed:`, describeAnthropicError(err));
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 800 * attempt)); // small backoff: 800ms, 1600ms...
      }
    }
  }
  throw lastErr;
}

// ── Generate itinerary (streaming, chunked for >4 days) ────────────
app.post("/generate-itinerary-stream", limiter, async (req, res) => {
  let requestId; // declared outside try so the catch-all can reference it safely
  try {
    const { city, cities, isMultiCity, days, pace, month, travelStyle, budget, foodPreference: foodPreferenceRaw, interests } = req.body;
    const foodPreference = normalizeFoodPreference(foodPreferenceRaw);
    requestId = req.body.requestId; // client-generated, used for resumability lookups
    const ip = getIP(req);
    initUsage(ip);

    if (!city || !days || !pace || !Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const tripError = validateTripShape({ isMultiCity, days, cities, city, interests });
    if (tripError) return res.status(400).json({ error: tripError });
    if (usageByIP[ip].generations >= MAX_GENERATIONS) {
      return res.status(429).json({ error: "Generation limit reached. Try again later." });
    }

    usageByIP[ip].generations += 1;
    console.log(`[generate-stream] IP: ${ip} | City: ${city} | Days: ${days} | Style: ${travelStyle} | Budget: ${budget} | Food: ${foodPreference} | Count: ${usageByIP[ip].generations} | requestId: ${requestId || 'none'}`);

    // ── Cache check (single city only, 6 month window) ────────────
    if (!isMultiCity) {
      const cached = await findCachedItinerary(city, days, pace, month, travelStyle, budget, foodPreference, interests);
      if (cached) {
        console.log(`[generate-stream] Cache hit | slug: ${cached.slug}`);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'done', itinerary: { ...cached.data, slug: cached.slug, fromCache: true } })}\n\n`);
        return res.end();
      }
    }

    const cityNamesArr = cities || [city];
    const dayChunks = getDayChunks(days); // e.g. [4,4,2] for 10 days; [3] for 3 days
    const useChunking = dayChunks.length > 1;

    if (requestId) initProgress(requestId, days);

    // ── Set SSE headers ───────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    // ── Non-chunked path (≤4 days, the common case) ─────────────────
    if (!useChunking) {
      const systemPromptText = (!isMultiCity && days <= 4)
        ? getLiteSystemPrompt(city, month, travelStyle, budget, foodPreference)
        : getSystemPrompt(isMultiCity ? cityNamesArr.join(' and ') : city, month, travelStyle, budget, foodPreference);
      const userMessage = buildChunkUserMessage({
        city, cities: cityNamesArr, isMultiCity, totalDays: days,
        chunkStartDay: 1, chunkEndDay: days,
        pace, month, travelStyle, budget, foodPreference, interests, priorDays: [], dayAllocation: null,
      });

      try {
        const { finalMessage: message, rawText } = await streamChunkWithRetry({
          systemPromptText,
          userMessage,
          maxTokens: getTokenLimit(days, isMultiCity, cityNamesArr.length),
          chunkLabel: 'Single-call',
          onText: (text) => { if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
        });

        let itinerary;
        try {
          const stripped = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
          const start = stripped.indexOf('{');
          const end = stripped.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('No JSON found');
          itinerary = JSON.parse(stripped.slice(start, end + 1));
        } catch {
          console.error("[generate-stream] JSON parse failed:", rawText.slice(0, 300));
          if (requestId) errorProgress(requestId, 'Failed to parse itinerary.');
          if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to parse itinerary. Please try again.' })}\n\n`);
          if (!res.writableEnded) res.end();
          return;
        }

        console.log(`[generate-stream] Success | Tokens: ${message.usage.input_tokens + message.usage.output_tokens}`);
        const slug = generateSlug();
        await saveItinerary(slug, city, days, pace, month, travelStyle, budget, foodPreference, interests, itinerary);
        console.log(`[generate-stream] Saved | slug: ${slug}`);
        if (requestId) {
          appendProgress(requestId, itinerary.days || [], { title: itinerary.title, meta: itinerary.meta });
          finishProgress(requestId, slug);
        }
        if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'done', itinerary: { ...itinerary, slug } })}\n\n`);
        if (!res.writableEnded) res.end();
      } catch (err) {
        // streamChunkWithRetry already retried once and logged full detail —
        // this is the final failure after retries are exhausted.
        console.error("[generate-stream] Single-call generation failed after retries:", describeAnthropicError(err));
        if (requestId) errorProgress(requestId, err.message);
        if (!res.writableEnded) {
          if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong. Please try again.' })}\n\n`);
          res.end();
        }
      }

      // NOTE: deliberately NOT aborting the Claude stream on client disconnect.
      // The generation keeps running server-side so progress is saved and the
      // frontend can recover it via /itinerary-progress/:requestId on reconnect
      // (covers the tab-switch case for short trips too, not just chunked ones).
      return;
    }

    // ── Chunked path (>4 days — multi-city, or single-city 5-7 days) ──
    let allDays = [];
    let finalTitle = null;
    let finalMeta = null;
    let dayAllocation = null;
    let dayCursor = 0; // days completed so far across chunks
    let totalTokensUsed = 0;

    try {
      for (let i = 0; i < dayChunks.length; i++) {
        const chunkDayCount = dayChunks[i];
        const chunkStartDay = dayCursor + 1;
        const chunkEndDay = dayCursor + chunkDayCount;
        const isFirstChunk = i === 0;

        const systemPromptText = getSystemPrompt(cityNamesArr.join(' and '), month, travelStyle, budget, foodPreference);
        const userMessage = buildChunkUserMessage({
          city, cities: cityNamesArr, isMultiCity, totalDays: days,
          chunkStartDay, chunkEndDay, pace, month, travelStyle, budget, foodPreference, interests,
          priorDays: allDays, dayAllocation,
        });

        const { finalMessage, rawText } = await streamChunkWithRetry({
          systemPromptText,
          userMessage,
          maxTokens: getChunkTokenLimit(chunkDayCount, isMultiCity, cityNamesArr.length),
          chunkLabel: `Chunk ${i + 1}/${dayChunks.length}`,
          onText: (text) => { if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
        });

        totalTokensUsed += finalMessage.usage.input_tokens + finalMessage.usage.output_tokens;
        if (finalMessage.usage.cache_read_input_tokens) {
          console.log(`[generate-stream] Chunk ${i + 1}/${dayChunks.length} cache hit | cached tokens: ${finalMessage.usage.cache_read_input_tokens}`);
        }

        let parsedChunk;
        try {
          const stripped = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
          const start = stripped.indexOf('{');
          const end = stripped.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('No JSON found');
          parsedChunk = JSON.parse(stripped.slice(start, end + 1));
        } catch {
          console.error(`[generate-stream] Chunk ${i + 1} JSON parse failed:`, rawText.slice(0, 300));
          throw new Error('Failed to parse part of the itinerary.');
        }

        const chunkDays = (parsedChunk.days || []).map((d, idx) => {
          if (!d.why) console.warn(`[generate-stream] Chunk ${i + 1} day ${chunkStartDay + idx} missing "why" field`);
          return {
            ...d,
            day: chunkStartDay + idx,
            title: d.title || `Day ${chunkStartDay + idx}`,
            why: d.why || '',
            morning: d.morning || [],
            afternoon: d.afternoon || [],
            evening: d.evening || [],
          };
        });
        if (chunkDays.length !== chunkDayCount) {
          console.warn(`[generate-stream] Chunk ${i + 1} expected ${chunkDayCount} days, got ${chunkDays.length}`);
        }
        allDays = allDays.concat(chunkDays);
        if (isFirstChunk) {
          finalTitle = parsedChunk.title || finalTitle;
          finalMeta = parsedChunk.meta || finalMeta;
          dayAllocation = parsedChunk.meta || null; // meta carries the day-allocation statement
          if (finalMeta && !isMultiCity && !finalMeta.includes(String(days))) {
            console.warn(`[generate-stream] meta field may not reflect full trip length — expected "${days}" somewhere in meta, got: "${finalMeta}"`);
          }
        }

        if (requestId) appendProgress(requestId, chunkDays, { title: finalTitle, meta: finalMeta, dayAllocation });

        // Let the frontend render this chunk's days immediately
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({
            type: 'chunk_done',
            days: chunkDays,
            chunkIndex: i,
            totalChunks: dayChunks.length,
            daysCompleted: chunkEndDay,
            totalDays: days,
          })}\n\n`);
        }

        dayCursor = chunkEndDay;
      }

      console.log(`[generate-stream] Chunked success | Total tokens across ${dayChunks.length} chunks: ${totalTokensUsed}`);

      const itinerary = { title: finalTitle, meta: finalMeta, days: allDays };
      const slug = generateSlug();
      await saveItinerary(slug, city, days, pace, month, travelStyle, budget, foodPreference, interests, itinerary);
      console.log(`[generate-stream] Saved | slug: ${slug}`);

      if (requestId) finishProgress(requestId, slug);
      if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'done', itinerary: { ...itinerary, slug } })}\n\n`);
      res.end();

    } catch (err) {
      console.error("[generate-stream] Chunked generation failed after retries:", describeAnthropicError(err));
      if (requestId) errorProgress(requestId, err.message);
      if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong generating part of your itinerary. Please try again.' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error("[generate-stream] Error:", err.message);
    if (requestId) errorProgress(requestId, err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Something went wrong generating your itinerary. Please try again." });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong. Please try again.' })}\n\n`);
    res.end();
  }
});

// ── Resume/check progress for an in-flight or completed generation ─
// Frontend polls this if the SSE stream connection breaks (tab-switch,
// network blip) so it can recover already-generated days instead of
// restarting the whole itinerary from scratch.
app.get("/itinerary-progress/:requestId", (req, res) => {
  const { requestId } = req.params;
  if (!requestId || requestId.length > 100) {
    return res.status(400).json({ error: "Invalid request ID." });
  }
  const progress = progressByRequestId[requestId];
  if (!progress) {
    return res.status(404).json({ error: "No progress found for this request." });
  }
  return res.json({
    status: progress.status,
    days: progress.days,
    title: progress.title,
    meta: progress.meta,
    totalDays: progress.totalDays,
    daysCompleted: progress.days.length,
    slug: progress.slug,
    error: progress.error,
  });
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
      model: "claude-sonnet-4-6",
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

// ── Razorpay: create order ────────────────────────────────────────
app.post("/create-razorpay-order", limiter, async (req, res) => {
  try {
    const { amount, currency = "INR", notes = {} } = req.body;
    if (!amount || typeof amount !== "number" || amount < 1) {
      return res.status(400).json({ error: "Invalid amount." });
    }
    if (amount > 10000) {
      return res.status(400).json({ error: "Amount exceeds maximum allowed." });
    }
    const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
    const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      console.error("[payment] Razorpay keys not configured.");
      return res.status(503).json({ error: "Payment not configured. Please try again later." });
    }
    const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${credentials}` },
      body: JSON.stringify({
        amount: amount * 100,
        currency,
        receipt: `rc_donation_${Date.now()}`,
        notes: { source: "rome_curator_donation", ...notes },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("[payment] Razorpay order creation failed:", JSON.stringify(data));
      return res.status(500).json({ error: "Could not create payment order. Please try again." });
    }
    console.log(`[payment] Razorpay order created | ID: ${data.id} | Amount: ₹${amount}`);
    return res.json({ orderId: data.id, amount: data.amount, currency: data.currency, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error("[payment] create-razorpay-order error:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Razorpay: verify payment signature ───────────────────────────
app.post("/verify-razorpay-payment", limiter, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields." });
    }
    const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    if (!RAZORPAY_KEY_SECRET) {
      console.error("[payment] Razorpay secret not configured for verification.");
      return res.status(503).json({ error: "Payment verification unavailable." });
    }
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expectedSignature !== razorpay_signature) {
      console.error(`[payment] Signature mismatch | Order: ${razorpay_order_id}`);
      return res.status(400).json({ error: "Payment verification failed. Signature mismatch." });
    }
    console.log(`[payment] Payment verified ✓ | Order: ${razorpay_order_id} | Payment: ${razorpay_payment_id}`);
    return res.json({ success: true, paymentId: razorpay_payment_id });
  } catch (err) {
    console.error("[payment] verify-razorpay-payment error:", err.message);
    return res.status(500).json({ error: "Something went wrong during verification." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Rome Curator backend running on port ${PORT}`));
