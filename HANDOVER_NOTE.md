# Rome Curator — Handover Note
*Last updated: July 13, 2026*

═══════════════════════════════════════
PROJECT OVERVIEW
═══════════════════════════════════════
Project: Rome Curator — a curated travel itinerary web app
Part of "The Curator" mother brand (future: OTT Curator, etc.)
Owner: Ashwin, based in Mumbai, India
Non-coder — needs step by step guidance at every stage
Business goal: monetisable side hustle, global product
Transitioning primary development from Claude.ai chat to **Claude Code**
starting after this handover — see CLAUDE CODE SETUP section at the end.

═══════════════════════════════════════
LIVE URLS
═══════════════════════════════════════
Frontend: https://romecurator.com (PRIMARY ✅)
Frontend: https://www.romecurator.com (redirects to above ✅)
Frontend: https://rome-curator-frontend.vercel.app (still works)
Backend:  https://rome-curator-backend.onrender.com

═══════════════════════════════════════
GITHUB
═══════════════════════════════════════
Frontend repo: hijomo-curator/rome-curator-frontend → index.html + vercel.json
Backend repo:  hijomo-curator/rome-curator-backend  → index.js
Both repos are public.
Vercel auto-deploys when frontend repo changes.
Render auto-deploys when backend repo changes.
⚠️ A stray index.html was accidentally uploaded to the BACKEND repo at one
point. Confirmed harmless (Node ignores it), but should be deleted from
rome-curator-backend for cleanliness whenever convenient.

═══════════════════════════════════════
INFRASTRUCTURE
═══════════════════════════════════════
Frontend hosting : Vercel (free tier)
Backend hosting  : Render ($7/month Starter plan — no cold starts)
AI model         : claude-sonnet-4-6
Email sending    : Resend — from hello@romecurator.com
Email collection : Sheetdb → Google Sheet (hello.romecurator@gmail.com)
Domain           : romecurator.com (Hostinger) → pointed to Vercel ✅
Database         : Supabase (Mumbai region, free tier) ✅
Analytics        : PostHog (EU region, free tier) ✅
Payments (India) : Razorpay — domestic payments activated ✅
Payments (Intl)  : PayPal — LIVE ✅ via three dedicated PayPal Payment Links
                   (not PayPal.me). See DONATION SYSTEM section.
PDF export       : browser-native window.print() + @media print CSS

⚠️ SUPABASE TABLE EDITOR DISPLAY QUIRK (cosmetic only, confirmed harmless):
Table Editor UI may show "no tables" even though data is present and
working (confirmed via SQL Editor). Backend uses service_role key which
bypasses RLS. Don't panic if this recurs — check via SQL Editor first.

═══════════════════════════════════════
RENDER ENVIRONMENT VARIABLES
═══════════════════════════════════════
ANTHROPIC_API_KEY, FRONTEND_URL, SHEETDB_URL, RESEND_API_KEY,
SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (LEGACY
service_role JWT — eyJ... format, NOT the new sb_secret_... format),
RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (rotated twice after accidental
screenshot exposure), PORT (auto-assigned).
No new env vars this session — all changes were prompt/logic/UI, no new
integrations.

═══════════════════════════════════════
SUPABASE SETUP
═══════════════════════════════════════
Project: rome-curator (free tier, Mumbai ap-south-1)
Table: itineraries (slug, city, days, pace, month, travel_style, budget,
food_preference, interests, data, created_at)
Cache: 6 months — same combo = instant return, zero tokens
RLS: enabled, service_role has full access
⚠️ `food_preference TEXT DEFAULT 'any'` column was added this session via
SQL Editor — already applied, no action needed.

═══════════════════════════════════════
POSTHOG ANALYTICS
═══════════════════════════════════════
Region: EU (eu.posthog.com) · Internal user filter ON (excludes Ashwin's
own email) · Project token: phc_xnjui3Jyc9qMHWQhzbscm8uKogbzuEPbLBbNJ9XVc5Kd

Custom events tracked:
- city_selected, itinerary_generated (now includes food_preference),
  share_clicked, email_saved, donation_initiated, donation_completed,
  pdf_downloaded
- `day_refined` no longer fires — the Refine UI was removed in a prior
  session (backend endpoint /refine-day still exists, just unreachable
  from the UI — paused, not deleted).

═══════════════════════════════════════
DONATION SYSTEM (settled this session, no further changes needed)
═══════════════════════════════════════
- India (IP detected via ipapi.co) → Razorpay ₹99 / ₹249 / open
- International (or detection fails/times out) → PayPal $1 / $3 / open
- PayPal uses three FIXED PayPal Payment Links (not PayPal.me):
  Tier 1 (coffee, $1):  https://www.paypal.com/ncp/payment/7ED8SDUWJVU32
  Tier 2 (meal, $3):    https://www.paypal.com/ncp/payment/68FMAKLGGTENY
  Tier 3 (open amount): https://www.paypal.com/ncp/payment/VENSF7MNAJXW4
- Razorpay's own "PayPal in checkout" was investigated and deliberately
  NOT used — it only works for non-INR currency with a separately
  approved "International Payments" feature (KYC + business review
  required). Not worth pursuing given Ashwin currently takes this as
  personal income without formal business registration.
- Race-condition bug (gateway defaulted to India/Razorpay before IP
  detection resolved, worse on slow/VPN connections) — FIXED: default
  is now 'USD' (safe fallback) and detection kicks off on page load,
  not just when the donation section renders.
- Open-amount input only shows for the India/Razorpay path — interna-
  tional tier-3 already collects a custom amount on PayPal's own page.

═══════════════════════════════════════
BACKEND ARCHITECTURE (index.js)
═══════════════════════════════════════
ES module syntax. Dependencies: express, cors, dotenv, @anthropic-ai/sdk,
express-rate-limit, @supabase/supabase-js, crypto, https (Node built-ins).

Endpoints:
  GET  /                            → health check / wake-up ping
  GET  /itinerary/:slug             → fetch saved itinerary by slug
  GET  /itinerary-progress/:requestId → resume/check in-flight generation
  POST /generate-itinerary          → non-streaming (kept, unused by frontend)
  POST /generate-itinerary-stream   → PRIMARY streaming endpoint (SSE)
  POST /refine-day                  → still works, but UNREACHABLE from
                                       the UI (feature paused, not deleted)
  POST /save-email                  → Sheetdb + Resend
  POST /create-razorpay-order       → Razorpay order + keyId
  POST /verify-razorpay-payment     → Razorpay HMAC-SHA256 verification

ANTHROPIC CLIENT CONFIG [critical, do not remove]:
  const anthropicAgent = new https.Agent({ keepAlive: false });
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    httpAgent: anthropicAgent, timeout: 120000, maxRetries: 1,
  });
  WHY: default keep-alive HTTP agent exposed stale pooled connections,
  causing repeated real production errors ("Premature close", no HTTP
  status — meaning the request never got a real response at the
  connection level). Disabling keep-alive forces a fresh connection per
  request. DO NOT remove this or revert to a bare `new Anthropic({...})`
  — this exact regression already happened once and took three rounds
  of investigation to root-cause.
  Also: `anthropic.messages.stream(...)` must NEVER be awaited — it
  returns synchronously and starts the request immediately; chain
  `.on('text', ...)` etc. directly onto it. (`.finalMessage()` IS meant
  to be awaited.)

DAY LIMITS [CHANGED THIS SESSION]:
  - Single city: 1-7 days (was 1-4 — raised this session)
  - Multi-city: 2-4 cities, min 6 days (2-3 cities) / 9 days (4 cities),
    max 10 days
  - `MAX_DAYS_SINGLE = 7` in both index.js and index.html — change both
    if this is ever adjusted again.
  - Single-city trips of 5-7 days now automatically use the SAME chunked-
    generation system multi-city trips already used (the backend had a
    "kept for safety" comment anticipating exactly this before it was
    ever exercised in practice — see CHUNKED GENERATION below).

CHUNKED GENERATION:
  - MAX_DAYS_PER_CHUNK = 4. getDayChunks(totalDays) splits into batches
    of ≤4 (e.g. 7 days → [4,3]; 10 days → [4,4,2]).
  - Chunking is triggered by `getDayChunks(days).length > 1` — this is
    generic, NOT limited to multi-city. As of this session, it commonly
    fires for single-city 5-7 day trips too, not just multi-city.
  - Each chunk after the first includes a compact recap of places/dishes
    already used, to avoid repeats. Later-chunk prompts re-state the
    full required JSON schema per day rather than relying on the system
    prompt's one-time definition.
  - Day numbers are FORCIBLY re-sequenced server-side after each chunk.
  - ⚠️ BUG FIXED THIS SESSION: the single-city first-chunk prompt never
    told the model to describe the FULL trip length in the "meta" field
    — it only saw its own chunk's day range, so a 5-day trip's header
    showed "4 of 5 days" instead of "5 days". Fixed by adding an
    explicit instruction to the single-city first-chunk prompt (mirrors
    what the multi-city path already did correctly). A safety-net log
    (`[generate-stream] meta field may not reflect full trip length...`)
    now also fires if this ever regresses — check Render logs if a
    similar "X of Y days" bug reappears.
  - Multi-city vs single-city chunked paths share `buildChunkUserMessage()`
    — the multi-city branch instructs day-allocation across cities; the
    single-city branch is simpler (no allocation needed).

SYSTEM PROMPTS:
  getLiteSystemPrompt() → single city ≤4 days (~50% fewer input tokens)
  getSystemPrompt()     → multi-city, or single-city 5-7 days (full prompt)
  Auto-selected: (!isMultiCity && days <= 4) ? lite : full

FOOD PREFERENCE [NEW THIS SESSION]:
  - Values: 'any' (default) / 'vegetarian' / 'vegan' / 'non_veg'
  - `normalizeFoodPreference()` defends against bad/missing input.
  - `getFoodPreferenceDirective(foodPreference)` returns dietary
    instructions injected into both system prompts and every chunk's
    user message. Vegetarian/vegan directives explicitly tell the model
    to actively find alternatives rather than dropping the food anchor
    for a day if the destination is meat/seafood-heavy.
  - Threaded through: request payload → both endpoints → both system
    prompts → buildChunkUserMessage → Supabase cache key (findCached-
    Itinerary/saveItinerary) → PostHog itinerary_generated event.
  - Supabase `food_preference` column added (default 'any') — done.

TRAVELLER SAFETY GUARDRAILS [NEW THIS SESSION — READ THIS IN FULL]:
  Prompted by real tester feedback (Ashwin, as a Mumbai resident, flagged
  the model recommending Dharavi as a self-guided "authentic" anchor and
  Haji Ali Dargah as a casual food/sightseeing stop). The concern: "local
  beats touristy" curation, left unchecked, can push toward genuinely
  unsafe or unwise recommendations for a traveller with no local context.

  Two new constants in index.js, injected into BOTH system prompts:
  - `SAFETY_GUARDRAILS` (full version, in getSystemPrompt) — placed
    directly BEFORE "CURATION PHILOSOPHY" (which opens with "local
    beats touristy"), deliberately positioned as an override, not just
    another bullet buried in a list.
  - `SAFETY_GUARDRAILS_LITE` (condensed, in getLiteSystemPrompt's RULES
    section) — same substance, shorter.

  The four rules, globally applied to every destination (not just
  Mumbai — this matters for future destinations like Rio de Janeiro or
  São Paulo, which have favelas Ashwin has no personal context on):
  1. Never recommend self-guided walking/eating/exploring inside informal
     settlements/slums (Dharavi, favelas, etc.) regardless of how
     "authentic" it sounds. A reputable GUIDED tour (e.g. Reality Tours in
     Dharavi) can be mentioned as an optional add-on only — never the
     day's anchor, never self-guided.
  2. Never recommend a specific food vendor located inside such an area,
     for the same reason — no exceptions.
  3. Religious/spiritual sites: only recommend major, securely managed
     heritage/tourist sites with established visitor infrastructure.
     Avoid active community religious sites in contexts with real
     communal/religious tension, even if historically significant — the
     risk is a traveller unknowingly walking into local social tension
     with no context to navigate it (Haji Ali Dargah vs. Taj Mahal is
     the reference example: same "religious site" category, very
     different risk profile).
  4. Only name a specific small/independent vendor if genuinely confident
     it's a real, established, well-regarded place — never invent a
     plausible-sounding name to sound authentic. If unsure, describe the
     TYPE of place instead of fabricating a name.
  These override budget level and "authenticity" scoring — safety and
  health always take priority.

  Mumbai's DESTINATION_CONTEXT was also rewritten as reinforcement:
  removed "Dharavi for reality" (which literally told the model to
  anchor a day there), added explicit notes that Dharavi is guided-tour-
  only and Haji Ali Dargah should not be recommended at all.

  VERIFIED WORKING: a real 5-day Mumbai itinerary generated after this
  fix correctly gated Dharavi as guided-only, omitted Haji Ali entirely,
  and hedged to categories ("any of the thali joints around Mahalaxmi
  station") rather than inventing unverifiable specific vendor names
  where it wasn't confident.

  If adding a new destination with a known informal-settlement or
  comparable-risk area, add a DESTINATION_CONTEXT reinforcement note
  the same way Mumbai's was done — the global rule is the baseline,
  but explicit reinforcement helps for well-known specific spots.

RATE LIMITING: 20 req/15min per IP · 5 generations per IP · 10
refinements per IP (still enforced even though /refine-day is unreachable
from the UI).

CORS: romecurator.com + www + Vercel subdomain + FRONTEND_URL env var.

ERROR LOG PREFIXES: [supabase][resend][generate][generate-stream][refine]
[email][slug][payment]

═══════════════════════════════════════
FRONTEND ARCHITECTURE (index.html)
═══════════════════════════════════════
Single HTML file, no framework. PostHog script in <head>.

CITY/DAY LIMITS: MAX_DAYS_SINGLE = 7 (was 4), MAX_CITIES = 4,
MIN_DAYS_MULTI (6 for 2-3 cities), MIN_DAYS_4_CITY (9), MAX_DAYS_MULTI (10).

PACE: Two options only — Relaxed, Balanced. "Packed" was removed in a
prior session (frontend-only change; backend never validated pace
against a fixed enum, so no backend change was needed).

FOOD PREFERENCE DROPDOWN [NEW THIS SESSION]: Any (default) / Vegetarian /
Vegan / Non-vegetarian — sits in its own row under Month/Travel Style/
Budget. Threaded through generate(), callGenerate(), retryGenerate(), and
both itinerary_generated PostHog captures.

REFINE-DAY FEATURE: removed from UI in a prior session (paused, not
deleted) — backend endpoint still works but has no UI entry point.

INDIA DESTINATIONS EXPANDED [NEW THIS SESSION — 3 → 26 cities]:
  Added 23 new cities, mapped to their states/UTs:
  Maharashtra: Mumbai, Pune, Alibaug, Matheran, Lonavala, Mahabaleshwar,
    Nashik, Sindhudurg
  Goa: North Goa, South Goa
  Rajasthan: Jaisalmer, Pushkar
  Kerala: Alleppey, Varkala
  Karnataka: Gokarna, Coorg
  Tamil Nadu: Ooty, Kodaikanal
  Telangana: Warangal · Andhra Pradesh: Vishakhapatnam
  Puducherry: Pondicherry · Jammu & Kashmir: Srinagar
  Madhya Pradesh: Khajuraho · Sikkim: Gangtok
  Assam: Guwahati · Meghalaya: Shillong

  Every one of the 26 cities has complete data across FOUR frontend maps
  (CITY_TAGLINES, CITY_WEATHER — 12 months each, CITY_SPECIALS — 3 chips
  each, LOADING_MSGS — 3 each) AND a DESTINATION_CONTEXT entry in
  index.js. This was cross-checked programmatically — no gaps.

  New `COUNTRY_CITY_GROUPS` map (frontend) groups India's cities by
  state for the dropdown UI (see below). Currently India-only — other
  countries don't have enough cities to need grouping, but the pattern
  extends the same way if any other country grows large (e.g. if the US,
  Brazil, or China were ever added).

CITY/REGION DROPDOWN REDESIGN [NEW THIS SESSION]:
  Replaced the old always-visible checkbox list with a collapsible,
  searchable dropdown — needed because India alone went from 3 to 26
  cities, and a flat always-open checkbox list doesn't scale.
  - Closed state: a select-styled trigger button showing either a
    placeholder or the selected cities (e.g. "Mumbai, Pune +1").
  - Click opens a floating panel with a search input + the checkbox
    list (multi-select logic UNCHANGED — same 4-city max as before).
  - India's cities render grouped under state headers (via
    COUNTRY_CITY_GROUPS); every other country renders as a flat list.
  - Closes on outside click or Escape.
  - Key functions: `buildCityCheckboxHTML()`, `toggleCityDropdown()`,
    `closeCityDropdown()`, `filterCityOptions()`, `updateCityDropdown-
    Label()`. `getSelectedCities()` and `onCityCheckboxChange()` are
    UNCHANGED in behaviour — they still just query
    `#cityCheckboxes input:checked`, so nothing downstream
    (resetHeader, refreshCityGrid, generate()) needed to change.
  - Hit and fixed one real bug while building this: a missing closing
    brace on COUNTRY_CITY_GROUPS silently broke the entire inline
    script. Caught via a syntax check before it shipped — worth running
    a quick `node -e "new Function(...)"` syntax check on the inline
    `<script>` block after any edit near this area, since a single
    broken brace here disables the ENTIRE page's JS, not just the city
    picker.

PDF EXPORT: unchanged — browser-native `window.print()` +
`@media print` stylesheet. NEVER reintroduce html2canvas/html2pdf.js
(see Ground Rules).

═══════════════════════════════════════
PHASES STATUS
═══════════════════════════════════════
✅ Phase 1 — Core product (form, generation, email)
✅ Phase 2 — Infrastructure (Render, Vercel, domain, Resend)
✅ Phase 3 — Database + Shareable links (Supabase, slugs, vercel.json)
✅ Phase 4 — Analytics + Streaming + Bug fixes
✅ Phase 5 — Payments: BOTH gateways fully live (Razorpay India + PayPal
   international via dedicated Payment Links)
✅ Phase 5.5 — Reliability rebuild: chunked generation, resumability,
   "Premature close" root-cause fix, interest/city-specials caps, PDF
   export rebuild
✅ Phase 5.6 — UI cleanup: pace simplified, refine-day paused, donation
   gateway race-condition fixed, PayPal fully wired
✅ Phase 5.7 (THIS SESSION) — Tester feedback round 1: food preference
   end-to-end, 23 new India destinations + grouped searchable city
   dropdown, single-city day limit 4→7, traveller safety guardrails
   (global + Mumbai reinforcement), chunked single-city meta-field bug
   fix
⏳ Phase 6 — Growth (landing page optimisation, SEO, social) — not started
⏳ Phase 6b (moving to CLAUDE CODE from here) — remaining tester feedback
   backlog, in agreed priority order:
   1. #4 Text density — 3-bullet-per-period structure is dense; needs a
      concision pass. No new API/infra needed, prompt + maybe frontend
      display tweak.
   2. #7 Google Maps links per recommended place — likely just a
      constructed search URL (`https://www.google.com/maps/search/?api=
      1&query=<place>+<city>`), no API key needed. Frontend-only,
      probably a template around each place mention.
   3. #8 Best areas to stay (safety/access/convenience) — new content
      section, needs prompt + a new UI block per day/city.
   4. #9 Local transport methods (city passes, bike-share e.g. Stockholm's
      city pass, Lime/Voi bikes) — new content section, prompt-driven.
   5. #10 SIM/currency/convenience store info — new content section,
      prompt-driven.
   6. #6 Images — BIGGEST LIFT. Unsplash API was the agreed direction
      (free tier generous, commercial-use license, no attribution
      required, cache alongside itinerary in Supabase). Self-hosted
      image repository was explicitly ruled out. Needs real cost/rate-
      limit consideration before building.

═══════════════════════════════════════
GROUND RULES — MUST FOLLOW ALWAYS
═══════════════════════════════════════
1. SECRETS ON BACKEND ONLY — never in index.html. (PayPal Payment Link
   URLs are an exception — public-facing by design, not secrets.)
2. NEVER COMMIT SECRETS TO GITHUB
3. ALWAYS EXPLAIN BEFORE BUILDING — Ashwin is non-technical
4. ONE FILE UPDATE = ONE GITHUB UPLOAD. Backend → index.js →
   rome-curator-backend → Render. Frontend → index.html →
   rome-curator-frontend → Vercel. UPLOAD ORDER: backend first, wait for
   Render deploy, then frontend.
5. SECURITY FIRST — validate trip-shape rules (days/cities/interests) on
   BOTH frontend AND backend.
6. COST AWARENESS — monitor Anthropic, Supabase, PostHog free tiers.
7. BRAND: Terracotta #B85C38, "Rome Curator" app, "The Curator" mother
   brand.
8. MOBILE FIRST — test at 375px, iPhone 17 Pro Max + Samsung S20 FE 5G.
9. BUILD ORDER: Product → Tech → Business.
10. ALWAYS PRESENT FILES FOR DOWNLOAD — Ashwin uploads to GitHub manually.
11. ROBUST ERROR LOGGING — prefixed log lines for every integration,
    success AND error states.
12. HANDOVER PROTOCOL — restate changed sections IN FULL when updating,
    never compress to "unchanged, see prior note."
13. NEVER reintroduce html2canvas/html2pdf.js for PDF export. Tried
    three times, failed every time for three different reasons.
14. NEVER remove or simplify the Anthropic client's httpAgent/timeout/
    maxRetries config in index.js.
15. SCREENSHOT HYGIENE — hide/crop secret values before sharing any
    dashboard screenshot. Has happened twice already with Razorpay keys.
16. WHEN TESTING A LAYOUT/CSS FIX, replicate the REAL file's exact
    container classes in any isolated test.
17. NEVER assume a payment gateway's marketing claim ("PayPal inside
    Razorpay checkout") applies without verifying against the gateway's
    own docs and a real test.
18. WATCH FOR ASYNC-DETECTION RACE CONDITIONS — any variable with a
    "temporary" default before an async lookup resolves should default
    to the SAFER option, and detection should start as early as possible
    (page load, not "when the relevant section becomes visible").
19. TRAVELLER SAFETY OVERRIDES AUTHENTICITY — when curating "local,
    off-the-beaten-path" content, always check it against the four
    safety guardrails above before treating a recommendation as good
    just because it's non-touristy. This applies to ANY future
    destination, not just ones Ashwin has personal context on.
20. AFTER ANY EDIT TO INLINE <script> BLOCKS IN index.html, run a syntax
    check before shipping — a single missing brace disables the ENTIRE
    page's JS silently, not just the section being edited. This exact
    bug happened once already this session (COUNTRY_CITY_GROUPS missing
    closing brace) and was caught by this check before it went out.

═══════════════════════════════════════
CLAUDE CODE SETUP (new — see also CLAUDE.md in each repo)
═══════════════════════════════════════
Starting after this handover, day-to-day work moves from Claude.ai chat
to Claude Code. A CLAUDE.md file has been added to the root of BOTH
repos — Claude Code reads this automatically at the start of every
session in that repo, so most of the ground rules above are already
"pre-loaded" going forward without needing to paste this whole note in
every time.

This HANDOVER_NOTE.md should also be placed at the root of both repos
(or at least kept somewhere both repos' CLAUDE.md files can point Claude
Code to) as the deeper reference the lean CLAUDE.md files link out to.

Recommended workflow going forward:
1. Clone both repos locally (GitHub Desktop is the easiest non-terminal
   way to do this).
2. Open the frontend repo folder in Claude Code (Desktop app's "Code"
   tab, or CLI) for frontend work; open the backend repo folder
   separately for backend work.
3. Claude Code will read that repo's CLAUDE.md automatically, and can be
   pointed to HANDOVER_NOTE.md for full context when a task needs it.
4. Ground rule #4 (backend deploys before frontend) still applies —
   Claude Code doesn't change the deploy process, just where the coding
   conversation happens.
