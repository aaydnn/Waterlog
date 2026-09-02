# WaterLog Startup Packet & Master Build Specification

> Transcribed verbatim from `WaterLog_Startup_Packet.pdf` (source file, not committed to the repo).
> This is the single source of truth for product, architecture, data model, and build-order decisions.
> **Any deviation from this packet requires an ADR in `docs/adr/`.**

| | |
| --- | --- |
| **Version** | 1.0 |
| **Date** | July 9, 2026 |
| **Owner** | Ayden |
| **Category** | Consumer mobile-first PWA · hobby analytics |
| **Audience** | Humans and AI coding agents — single source of truth |

Tagline: *Fish your data.*

---

## 01 · Executive Summary

**One-liner.** WaterLog is a personal fishing analytics app. Anglers log catches in under 10 seconds; WaterLog auto-captures the conditions and mines the angler's own history for personal patterns — *"You catch 3.2× more on chartreuse spinnerbaits when pressure is falling."*

**Core thesis.** Every existing fishing app is a map/social app (Fishbrain, ANGLR), a gear inventory tracker, or a generic rules engine ("cloudy day = dark lure"). None mine the **individual angler's own historical data**. Serious anglers already believe they have patterns — notebooks, superstitions, moon-phase arguments. WaterLog replaces belief with evidence, using data the angler generates naturally.

**Positioning: the anti-social fishing app.** Private by default. No feed. No followers. Nobody sees your spots. Your data works for you, not for an audience.

**Business model**

| Tier | Price | Included |
| --- | --- | --- |
| Free | $0 | Unlimited logging, journal, basic stats, 1 water-body dossier |
| Pro | $4.99/mo · $39/yr | Pattern Engine, Pre-Trip Briefings, Lure ROI, unlimited dossiers, full export, priority enrichment |

**Why this founder.** Solo developer with an existing Cloudflare-native stack (Workers, D1, R2, Queues, Pages), a SQL/data background, and domain credibility as an active TN/SC angler. The moat — the Pattern Engine — is fundamentally SQL analytics: the founder's core skillset. Year-1 conservative model: 5,000 downloads → 2,500 activated → ~200 Pro subs ≈ $650 MRR against $20–50/mo infrastructure cost. Side-project economics by design.

---

## 02 · Product Principles

These are constraints, not aspirations. **Any feature that violates one is rejected by default.**

| # | Principle | What it means in practice |
| --- | --- | --- |
| 1 | Ten-second capture or it doesn't ship | Every input field must justify its existence; auto-capture everything auto-capturable. |
| 2 | Negative data is first-class | Skunked (zero-catch) trips are logged with full conditions. All analytics are rate-based (catches/hour under condition X), never raw counts. Raw counts lie. |
| 3 | Honest statistics | Every pattern shows sample size + confidence tier. Nothing under 5 observations ships without an "early signal" label. Overclaiming destroys trust with exactly the users who matter most. |
| 4 | Private by default | No public feed, no location sharing. Sharing is opt-in per-item; location is stripped unless explicitly included. |
| 5 | Offline-tolerant | Anglers are out of cell range constantly. Capture works offline, syncs later; condition enrichment happens server-side after sync. |
| 6 | The angler owns the data | One-tap full export (CSV + JSON). Ethical stance and retention feature: exportability increases trust, which increases retention. |

---

## 03 · Target Users & Personas

| Persona | Profile | Role & needs |
| --- | --- | --- |
| "Tournament Todd" | 28–55 · fishes 40+ days/yr · bass-focused · owns a boat · $1–3k/yr on gear · already logs in a notebook/spreadsheet | **Primary revenue persona.** Believes in patterns; pays immediately if the analytics are real. Needs: pattern engine, pre-trip briefing, per-lake history, water temp. |
| "Weekend Wade" | 18–45 · 8–20 days/yr · bank/kayak · budget-conscious · logs nothing today, loses all learning between trips | **Primary volume persona.** Free-tier for months; converts when the app tells him something surprising about himself. Needs: dead-simple capture, photo gallery, "what should I throw today." |
| "Fly-curious Fiona" | Trout/fly anglers · different vocabulary: flies not lures, hatches, stream flow vs. lake temp | **Expansion persona (post-MVP).** Build nothing fly-specific in MVP — but the data model must not hard-code bass assumptions: the lure table is a generic "offering" capable of representing a fly. |

---

## 04 · Feature Specification

### Phase 1 — MVP: "Log & Learn"

| ID | Feature | Specification highlights |
| --- | --- | --- |
| F1 | One-Photo Catch Capture | FAB → camera → species picker (recents) → lure picker → Save. ≤10s, ≤4 taps after photo. Auto: GPS, timestamp. Server enriches async: weather, pressure + 6h trend, moon, sunrise offsets, USGS water temp/flow, season. Offline: IndexedDB queue. |
| F2 | Trip Sessions (incl. skunks) | Start/stop wrapper; auto-detects water body from GPS. Zero-catch trips are the point: they generate the denominator (hours fished) for every rate. Orphan catch auto-creates a 1h trip; auto-end after 6h idle or >20km GPS drift. |
| F3 | Catch Journal | Reverse-chron photo grid + list; filter by species, water, lure, date; detail view with full enriched conditions. |
| F4 | Basic Stats (free) | Totals + simple breakdowns by species/month/water. No condition correlations in free tier. |
| F5 | Water Body Management | Auto-created from GPS on first trip (reverse geocode); rename, merge, set home water. |

### Phase 2 — "The Pattern Engine" (Pro launch)

| ID | Feature | Specification highlights |
| --- | --- | --- |
| F6 | Pattern Engine | Nightly + on-demand catches-per-hour across condition dimensions. Each card: plain-English statement, multiplier vs. personal baseline, sample size, confidence tier. "Chartreuse spinnerbaits, falling pressure → 3.2× baseline (11 catches / 14 hrs / 6 trips). Confidence: Solid." |
| F7 | Pre-Trip Briefing | Pick water + date → forecast matched against personal pattern cards (per-water, falling back to all-waters) → best lures, time blocks, closest past trips. Push the evening before. |
| F8 | Lure ROI | Optional lure cost → cost-per-catch report. Shareable card with location stripped by construction — the viral screenshot feature. |
| F9 | Water Body Dossiers | Per-lake monthly catch-rate heatmap, best lures, water temp at best trips, records. |

### Phase 3 — Later (listed only to protect the data model)

- Vision-model species suggestion + length estimation from photo.
- Crew Mode: share pattern cards (never locations) with up to 3 buddies.
- Tournament mode · fly-fishing vocabulary pack · Apple Watch quick-capture.

### Explicit non-goals

No public social feed. No global heatmaps of user spots. No selling data. No ads. No gear marketplace. No regulations database (link out instead — a liability and maintenance trap).

---

## 05 · Technical Architecture

The stack mirrors the founder's existing PopFeed infrastructure — same deploy pipeline, same operational knowledge, near-zero marginal learning cost. Everything runs Cloudflare-native, which keeps fixed costs in the $20–50/mo range at launch scale.

| Layer | Choice | Rationale |
| --- | --- | --- |
| Client | React + Vite PWA, installable, offline-first | One codebase, no app-store gatekeeping at MVP. Wrap with Capacitor at Phase 2 if retention proves out. |
| Hosting | Cloudflare Pages | Existing deploy pipeline. |
| API | Cloudflare Workers + Hono router | Founder-proven. |
| Database | Cloudflare D1 (SQLite) | Relational analytics = SQL. Read replicas fine at this scale. |
| Photos | R2 + Cloudflare Images (resize variants) | Cheap egress, existing pattern. |
| Async jobs | Queues + Cron Triggers | Enrichment pipeline + nightly pattern compute. |
| Local store | IndexedDB via Dexie.js | Offline capture queue. |
| Auth | Magic link + Apple/Google OAuth | Anglers hate passwords with wet hands. |
| Payments | Stripe subscriptions | Standard. |
| Push | Web Push (VAPID); FCM/APNs later via Capacitor | Briefing notifications. |

### System flow

```
PWA CLIENT (offline-first)                 API WORKER (Hono)                    D1 (SQLite)
  camera capture ≤ 10s                       POST /api/sync (idempotent)          trips · catches · lures
  Dexie / IndexedDB queue      --sync batch-->  dedupe on client_id      --insert-->  conditions (catch + trip-hour)
  client_id ULID per catch                    R2 presigned photo upload            pattern_cache
        ^                                          |  queue: enrich(catch_id)
        |                                          v
ENRICH WORKER (Queue)                       CRON WORKER (nightly)                PUSH (Web Push / VAPID)
  Open-Meteo wx + pressure                    recompute pattern_cache              "first pattern found"
  USGS gauge 00010/00060      <--------       50ms CPU budget / user               pre-trip briefing 7pm
  moon + solar: computed        UPDATE conditions          T-1 briefing pushes --> season-opener reactivation
                                 · enrich_status                    notifications out
```

Capture is client-side and instant; everything expensive (weather lookups, gauge matching, pattern math) is async and server-side. The catch is valid the moment it's saved — enrichment is best-effort and idempotent.

### Repo structure (agents: scaffold exactly this)

```
waterlog/
├── apps/
│   └── web/                # React + Vite PWA
│       └── src/
│           ├── features/   # capture/ trips/ journal/ patterns/ briefing/ settings/
│           ├── lib/        # api client, dexie db, sync engine, geo utils
│           └── ui/         # shared components, design tokens
├── workers/
│   ├── api/                # Hono app: auth, crud, sync, stripe webhooks
│   ├── enrich/              # queue consumer: condition enrichment
│   └── cron/                # nightly pattern engine + briefing scheduler
├── packages/
│   ├── schema/               # zod schemas shared client/server (single source of truth)
│   └── patterns/             # pure-TS pattern math (unit-testable, zero I/O)
├── migrations/               # D1 SQL migrations, numbered NNNN_description.sql
└── docs/                     # this packet + ADRs
```

> **Agent rule: one source of truth for payload shapes.** Shared validation lives in `packages/schema` (Zod). Client and Workers both import it. Never define a payload shape twice — divergence between client and server validation is where sync bugs are born.

---

## 06 · External Data Sources

Every enrichment source is keyless and free — no API-cost scaling risk, no vendor account to lose. Two values (moon phase, sun times) are computed locally rather than fetched, on principle:

| Data | Source | Notes |
| --- | --- | --- |
| Weather: current, forecast, historical | Open-Meteo (no key, free) | Hourly temp, precip, cloud, wind, surface pressure. Historical endpoint backfills pressure trend for offline-synced catches. |
| Barometric pressure trend | Derived from Open-Meteo hourly | `trend = pressure(t) − pressure(t−6h)`. Falling < −1.5 hPa · rising > +1.5 hPa · else stable. |
| Water temp & streamflow | USGS Water Services (no key) | Param codes 00010 (temp °C), 00060 (discharge). Nearest gauge ≤15 km, cached on water_body. Coverage imperfect → nullable; analytics tolerate nulls. |
| Moon phase | Computed locally | Pure function of date (synodic month = 29.53059 d from a known new-moon epoch). |
| Sunrise / sunset | Computed locally (NOAA algorithms or suncalc) | Powers "time relative to sunrise" — far more predictive than clock time. |
| Reverse geocoding / waterbody names | Nominatim (OSM), cached in D1 | Aggressive caching; naming a lake is a one-time event. |

**Engineering lesson baked into the spec.** Never pay latency and dependency cost for deterministic, computable values. Moon phase is arithmetic; an API for it would add a failure mode and buy nothing.

**Failure policy.** Enrichment is best-effort and idempotent. A catch with null conditions is still a valid catch. Retry with exponential backoff, max 5 attempts, then `enrich_status='partial'`.

---

## 07 · Data Model (D1 / SQLite)

**Conventions.** TEXT ULIDs as PKs; `created_at` / `updated_at` as epoch-ms integers; soft deletes via `deleted_at`. Every user-data row carries `user_id` and every query is scoped by it — single-tenant-per-row.

> **Known deviation to track:** the current implementation (`workers/api/src/lib/users.ts`) generates server-assigned primary keys with `crypto.randomUUID()`, not ULIDs. This has not yet been reconciled with an ADR — see the note in `CLAUDE.md`.

### `catches` — the atomic event

```sql
CREATE TABLE catches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lure_id TEXT REFERENCES lures(id),
  species TEXT NOT NULL,                        -- slug from species reference list
  caught_at INTEGER NOT NULL,
  lat REAL, lng REAL,
  photo_key TEXT,                                -- R2 object key
  length_mm INTEGER, weight_g INTEGER,           -- store metric, render per user.units
  released INTEGER, notes TEXT,
  client_id TEXT UNIQUE,                         -- client ULID: offline dedupe, idempotent sync
  enrich_status TEXT NOT NULL DEFAULT 'pending', -- pending | done | partial | failed
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_catches_user_time ON catches(user_id, caught_at);
```

### `conditions` — the table that makes the analytics honest

```sql
CREATE TABLE conditions (                       -- one row per catch AND one per trip-hour
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  catch_id TEXT REFERENCES catches(id),          -- exactly one of catch_id / trip_id+hour set
  trip_id TEXT REFERENCES trips(id),
  hour_bucket INTEGER,                           -- epoch hour, for trip-hour rows
  air_temp_c REAL, cloud_pct REAL, wind_kph REAL, precip_mm REAL,
  pressure_hpa REAL, pressure_trend TEXT,        -- falling | stable | rising
  moon_phase REAL,                               -- 0..1 (0 = new)
  minutes_from_sunrise INTEGER,                  -- signed; negative = before sunrise
  water_temp_c REAL, discharge_cms REAL,         -- nullable (gauge coverage)
  season TEXT,                                   -- hemisphere-aware
  source_meta TEXT,                              -- JSON: which APIs answered
  created_at INTEGER NOT NULL
);
```

> **The key modeling decision: trip-hour rows as denominators.** Patterns are rates, and rates need denominators. "Chartreuse in falling pressure = 11 catches" is meaningless without knowing you fished 14 hours of falling pressure vs. 90 hours of stable. So every hour of every trip — skunked or not — gets a conditions row enriched from historical weather. The pattern engine joins catches to exposure. This one design choice is what separates WaterLog's analytics from every "insights" feature competitors bolt on.

### `pattern_cache` — precomputed nightly, read instantly

```sql
CREATE TABLE pattern_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,       -- 'all' | water_body_id
  dimension TEXT NOT NULL,   -- 'lure_color', 'pressure_trend', 'lure_family+pressure_trend'
  bucket TEXT NOT NULL,      -- 'chartreuse', 'falling', 'spinnerbait|falling'
  catches INTEGER NOT NULL,
  hours REAL NOT NULL,       -- exposure hours under this condition
  rate REAL NOT NULL,        -- catches / hours
  baseline_rate REAL NOT NULL, -- user's overall rate in same scope
  multiplier REAL NOT NULL,  -- rate / baseline_rate
  confidence TEXT NOT NULL,  -- early | promising | solid
  computed_at INTEGER NOT NULL
);
```

Supporting tables (full DDL in migration 0001): `users` (units, tier, Stripe id), `water_bodies` (centroid, cached USGS gauge id, home flag), `lures` (generic "offering" — family, normalized color slug, optional `cost_cents` for ROI; represents a fly without schema change), `trips` (started/ended, auto_created, planned flag for briefing targets).

---

## 08 · Pattern Engine Specification

Lives in `packages/patterns`: pure TypeScript, fully unit-tested, **zero I/O**. The cron worker feeds it rows and writes back results. Purity is the point — 100% branch coverage is required, and a property test asserts that shuffling input rows never changes output.

### Dimensions (MVP set)

| Dimension | Buckets |
| --- | --- |
| lure_family / lure_color | From the lure table's normalized slugs |
| pressure_trend | falling · stable · rising (±1.5 hPa over 6h) |
| sky | clear / partly / overcast, banded from cloud_pct |
| wind | calm <8 · light 8–20 · strong >20 kph |
| water_temp | 5°C-wide bands (nullable-tolerant) |
| moon | phase quartiles |
| time block | relative to sunrise: dawn ±90min · morning · midday · evening · dusk ±90min · night |
| season | hemisphere-aware spring/summer/fall/winter |
| pairwise combos | of the top single dimensions only |

### Computation, per user per scope

```
1. baseline_rate = total_catches / total_trip_hours     (min 10 hours or skip user)
2. bucket_rate   = catches_in_bucket / exposure_hours_in_bucket
3. multiplier    = bucket_rate / baseline_rate
4. SURFACE ONLY IF:
     exposure_hours >= 3
     AND catches >= 3
     AND (multiplier >= 1.5 OR multiplier <= 0.5)
   -- negative patterns ("you rarely catch on bluebird midday") surface too;
   -- they are equally actionable.
```

### Confidence tiers — heuristic, honest, explainable

| Tier | Threshold | Why |
| --- | --- | --- |
| early | 3–4 catches, or <6 exposure hours | Labeled "Early signal" in the UI — shown, never oversold. |
| promising | 5–9 catches · ≥6 hours · ≥3 distinct trips | Enough replication to be interesting. |
| solid | ≥10 catches · ≥10 hours · ≥5 distinct trips | The tier that triggers the first-pattern push notification. |

**Why distinct-trip minimums (and no p-values).** One lucky evening can fake a pattern — pseudo-replication, the classic amateur analytics failure. Requiring distinct trips guards against it. Tiers are deliberately heuristic rather than p-values: anglers can understand "10+ catches across 5+ trips," and honesty they can verify beats rigor they can't. If a Wilson score interval upgrade is wanted later, it slots into `packages/patterns` without schema change.

**Anti-confounding rule for combos.** Do not surface combo patterns their single-dimension parents fully explain. If chartreuse is 3× everywhere, "chartreuse + falling" at 3.1× is not a separate insight. Rule: a combo must beat its best parent's multiplier by ≥25% to surface.

---

## 09 · UX Specification

| Direction | Detail |
| --- | --- |
| Dark-first | Anglers use this at 5:30am and at dusk. Dark mode is the primary theme, not an option. |
| One-thumb reachable | FAB bottom-right; bottom nav: Journal · Patterns · [+] · Briefing · Profile. |
| Photography-forward | The catch photo is the hero of every card. |
| Brand | Deep water navy `#0B1D2A` · chartreuse accent `#DFFF00` (the brand in-joke) · bone white text · sturdy grotesque (Inter/Geist) · tabular numerals for stats. |

### Critical flows — build in this order

| Flow | Spec |
| --- | --- |
| 1 · Capture (the whole product) | FAB → camera → photo → species sheet (6 recents + search) → lure sheet (6 recents + search + "+ new lure") → toast "Logged. Enriching conditions…" 2–4 taps after photo. Offline: "Logged offline — will sync." |
| 2 · Trip start/end | Open app ≤300m from a known water body → banner "Fishing [Lake Name]? Start trip." One tap. Auto-close prompts per F2. |
| 3 · Pattern reveal (the retention moment) | First promising+ pattern → push: "WaterLog found your first pattern." Cards sorted by |multiplier|: plain-English statement, multiplier chip, sparkline, sample-size footer, confidence badge. |
| 4 · Pre-trip briefing | Pick water + date → forecast strip, matched historical patterns, 3 closest past trips with outcomes, suggested lure shortlist. Save → push at 7pm the evening before. |

**Empty states carry the free→Pro narrative — do not skip them.**
- Journal empty: "Your first catch starts your dataset. Everything else is automatic."
- Patterns locked (free): real blurred cards computed from the user's own data, with the true count — "3 patterns found in your fishing. Unlock Pro." Compute for everyone; reveal behind the paywall. **The tease must be true.**
- Patterns empty (Pro, thin data): progress meter — "7 of ~20 catches until patterns emerge" — plus current best early signals.

---

## 10 · AI Worker Build Plan

**Ground rules for agents.** Work epic-by-epic; do not start an epic until the prior epic's acceptance tests pass. Every task lands as a PR with tests. `packages/patterns` requires 100% branch coverage. Never invent payload shapes — extend `packages/schema` first. Migrations are append-only. Any deviation from this packet requires an ADR in `docs/adr/`.

| Epic | Scope | Key acceptance criteria |
| --- | --- | --- |
| 0 · Scaffold (1 wk) | pnpm monorepo, CI, Pages+Workers deploy; migration 0001 (full schema) + seed; auth (magic link + Google OAuth) | `pnpm test` green in CI; preview deploy on PR; clean migration on fresh DB; protected route 401/200. |
| 1 · Capture & Sync (2 wk) | PWA shell, Dexie mirror of schema, camera flow with client resize (max 1600px), idempotent sync, trip lifecycle | 10-second capture verified by scripted UI test; **replaying a sync batch twice creates zero duplicates**; orphan catch auto-creates a 1h trip. |
| 2 · Enrichment (1.5 wk) | Open-Meteo consumer + pressure classifier; USGS gauge matcher; local moon/solar calc; trip-hour backfill on trip end | Classifier boundary tests at ±1.5 hPa; astro matches published ephemeris for 20 test dates; a 4.5h trip yields 5 hour-bucket rows; missing gauge → partial, never blocking. |
| 3 · Journal & Stats (1 wk) | Journal grid/list + filters + detail; free-tier stats | Numbers reconcile with raw SQL spot-checks. |
| 4 · Pattern Engine (2 wk) — the moat | `packages/patterns` core per §08; nightly cron chunked to Worker CPU limits; pattern feed + blurred paywall + first-pattern push | 100% branch coverage; shuffle-invariance property test; 50ms budget per user or re-queue; free user sees true count, blurred cards. |
| 5 · Briefing & Monetization (2 wk) | Forecast matcher + briefing UI + T−1 19:00 push; Stripe checkout/webhooks/portal; full export; Lure ROI shareable card | Webhook replay-safe; downgrade preserves data, re-locks features; ROI card template has no location field — stripped by construction. |
| 6 · Polish & Launch (1 wk) | Onboarding (≤3 screens), error states, landing page, privacy-respecting analytics | Closed beta of 15–25 anglers before public launch. |

---

## 11 · Monetization & Go-To-Market

**Conversion mechanic.** Patterns are computed for everyone but revealed only to Pro — the true-tease paywall. The user's own data sells the upgrade; no marketing copy competes with "3 patterns found in YOUR fishing."

**Pricing rationale.** Anchor against gear spend, not app-store norms: anglers routinely spend $8 on a single lure they'll lose in a tree. $39/yr is one lost crankbait.

### 90-day post-launch GTM

| Channel | Play |
| --- | --- |
| Content wedge | Short-form video of the Lure ROI screenshot: "my app told me I waste money on crankbaits." Fishing TikTok/Shorts is huge and under-served on analytics content. |
| Community seeding | r/bassfishing, r/Fishing_Gear, regional TN/SC FB groups (founder credibility — fish where you post). Rule: share findings, never pitch. "6 months of my data says moon phase doesn't matter for me — AMA." |
| Creator kit | 5 mid-size fishing YouTubers get free Pro + a personal "Year in Fishing" data story from their logs. |
| App Store SEO | Target "fishing log," "fishing journal," "catch log" — lower competition than "fishing app." |

### Pre-launch execution calendar (90 days)

| Days | Milestone |
| --- | --- |
| 1–7 | Epic 0 · register domain · Stripe + dev accounts · USPTO trademark knockout on "WaterLog" (class 9/42) before spending on brand. |
| 8–21 | Epic 1 · founder dogfoods capture on ≥2 real fishing trips; friction notes become fixes. |
| 22–32 | Epic 2 · backfill enrichment for dogfood catches; sanity-check USGS coverage on founder's TN/SC waters specifically. |
| 33–39 | Epic 3. |
| 40–53 | Epic 4 · validate first real pattern cards against founder intuition (face-validity check with 3 angler friends). |
| 54–67 | Epic 5. |
| 68–74 | Epic 6 · closed beta: 15–25 anglers, TestFlight/PWA link. |
| 75–89 | Beta loop; fix top-5 friction items only (scope discipline). |
| 90 | Public launch: Product Hunt + Reddit + first TikTok. |

---

## 12 · Risks, Mitigations & Success Metrics

| Risk | L | Mitigation |
| --- | --- | --- |
| Log abandonment — the existential risk | High | 10-second capture, trip auto-detection, streak-free design (no guilt mechanics; lapsed anglers return in spring — send a "season opener" reactivation push instead). |
| Sparse data → no patterns → churn before value | High | Early-signal cards from catch #3; progress meter; briefing falls back to species-level heuristics clearly labeled "general knowledge, not yet your pattern." |
| USGS gauge coverage gaps | Med | Water temp is one nullable dimension among nine; never a hard dependency. |
| Pattern engine surfaces garbage (confounds) | Med | §08 thresholds, distinct-trip minimums, combo suppression; founder reviews own cards weekly during beta. |
| Name conflicts | Low–Med | "WaterLog" appears clear in-category per July 2026 search; proper USPTO knockout + App Store search is a Day-1 task. |
| Apple/Play review friction | Low | Launch as PWA; wrap with Capacitor only once retention is proven. |

### Success metrics

| Metric | Definition | Target |
| --- | --- | --- |
| Activation | % of signups logging ≥1 catch in 7 days | 40% |
| **Aha-moment gate** | % of active users reaching 20 catches (pattern threshold) within 60 days — the metric that matters | 25% |
| Retention | 8-week logging retention among activated users (fishing is weekly-seasonal — compare same-season cohorts only) | 35% |
| Conversion | Free→Pro within 14 days of first pattern reveal | 10% |
| North star | Patterns revealed per week (composite of logging volume, data quality, Pro reach) | — |

**Brand snapshot.** Wordmark: lowercase "waterlog" with the "o" as a bobber. Taglines: "Fish your data." · "Your patterns. Proven." · "Stop guessing. Start patterning." Voice: knowledgeable fishing buddy, not a stats professor — every number gets a plain-English sentence. The anti-social stance is marketing copy, verbatim: "No feed. No followers. Nobody sees your spots. WaterLog works for you, not an audience."

---

*End of packet v1.0 · Agents: report deviations as ADRs · Humans: revisit pricing and targets after beta.*
