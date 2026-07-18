# Rome Curator — Backend (rome-curator-backend)

Node.js/Express API for the Rome Curator itinerary app. One file,
`index.js`, ES modules. Deployed on Render (Starter plan, $7/mo). Talks
to Anthropic (generation), Supabase (cache/storage), Razorpay (India
payments), Resend (email), Sheetdb (email capture list).

**For full project context, decisions, and history, read `HANDOVER_NOTE.md`
in this repo's root before starting non-trivial work.** This file only
covers what's true every session.

## Owner context
Ashwin is non-technical — always explain a change in plain language
before making it, and confirm before anything destructive or ambiguous.
He uploads files to GitHub manually, so prefer complete file
replacements over git-CLI-dependent instructions unless he's specifically
working in git directly.

## Deploy
Render auto-deploys on push to `main`. **This repo deploys BEFORE the
frontend** whenever a change spans both — never the reverse, since the
frontend depends on this API's shape.

## Critical don'ts
- Never remove or weaken the Anthropic client config:
  `httpAgent: new https.Agent({ keepAlive: false })`, `timeout: 120000`,
  `maxRetries: 1`. This fixed a real, repeated production bug ("Premature
  close" errors from stale pooled connections) that took three rounds of
  investigation to root-cause. See HANDOVER_NOTE.md for the full story
  before touching this.
- Never `await anthropic.messages.stream(...)` — it returns synchronously
  and starts the request immediately; chain `.on('text', ...)` etc.
  directly onto the return value. `.finalMessage()` IS meant to be awaited.
- `MAX_DAYS_SINGLE` here must always match the same constant in the
  frontend's `index.html` — duplicated, not shared, so changing one
  without the other silently desyncs the two.
- Never commit secrets to this repo. All credentials live in Render's
  environment variables — see HANDOVER_NOTE.md for the full list.
- `SUPABASE_SECRET_KEY` must be the LEGACY service_role JWT (`eyJ...`
  format), not the newer `sb_secret_...` format — the latter doesn't
  work with the `supabase-js` v2 client version this project uses.

## Traveller safety (applies to any prompt/content work)
`SAFETY_GUARDRAILS` / `SAFETY_GUARDRAILS_LITE` in `index.js` are
injected into every system prompt and are a deliberate override of the
"local beats touristy" curation philosophy — not just another rule in
the list. If editing prompts, don't let content-quality goals erode
these: no self-guided informal-settlement recommendations, no vendors
inside them, no religious/community sites with real social tension
presented as casual sightseeing, no invented-sounding specific vendor
names when uncertain. Full reasoning in HANDOVER_NOTE.md under
"TRAVELLER SAFETY GUARDRAILS." When adding a new destination with a
known informal-settlement or comparable-risk area, add a
`DESTINATION_CONTEXT` reinforcement note the same way Mumbai's was done.

## Chunked generation (read before touching prompt/generation logic)
Trips over 4 days (`MAX_DAYS_PER_CHUNK`) — both multi-city AND
single-city 5-7 day trips — use chunked generation: multiple Claude
calls of ≤4 days each, stitched together, with a recap sent to later
chunks to avoid repeated recommendations. `buildChunkUserMessage()` is
shared between multi-city and single-city chunked paths. The first
chunk's prompt must explicitly state the FULL trip length in the `meta`
field (not just its own chunk's days) — this was a real bug once, fixed,
with a safety-net warning log now in place if it regresses.

## Error logging convention
Every integration logs both success and failure with a bracketed prefix:
`[supabase] [resend] [generate] [generate-stream] [refine] [email]
[slug] [payment]`. Keep new integrations consistent with this.
