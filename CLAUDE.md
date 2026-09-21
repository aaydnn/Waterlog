# WaterLog

Personal fishing analytics PWA. Full product/architecture spec:
**`docs/waterlog-startup-packet.md`** — read it before any feature work. It is the single source of
truth for product principles, data model, pattern-engine math, and build order. This file only
pulls out the rules that must never be silently violated.

## Non-negotiable build rules

- **Work epic-by-epic.** Don't start the next epic until the current one's acceptance criteria
  (see packet §10) pass. Current epic: **4 — Pattern Engine**. All four of its criteria pass —
  see `docs/epic-4-acceptance.md` for the evidence, the four ADRs it required, and the gaps it
  carries into Epic 5. Epics 1–3 are done and deployed; their evidence is in
  `docs/epic-2-acceptance.md` and `docs/epic-3-acceptance.md`. Real-water validation — one real
  catch, one real skunked trip — is still open for all of them.
- **Never invent payload shapes.** All client/server payload shapes live in `packages/schema`
  (Zod), imported by both `apps/web` and every `workers/*`. Extend it first; never redefine a
  shape locally.
- **Migrations are append-only**, numbered `NNNN_description.sql` in `migrations/`. Never edit a
  committed migration — add a new one.
- **`packages/patterns` requires 100% branch coverage** and zero I/O (pure TS) — the cron worker
  feeds it rows, it never fetches anything itself.
- **Any deviation from the packet requires an ADR** in `docs/adr/`, committed in the same PR as
  the deviating code.
- **Sync idempotency is load-bearing**: replaying a sync batch twice must create zero duplicates.
  Dedupe on `client_id` (client-generated ULID) via `INSERT ... ON CONFLICT(client_id) DO NOTHING`,
  then `SELECT` the canonical row — server always assigns `id`.
- **Analytics are rate-based, never raw counts.** Every hour of every trip (skunked or not) needs
  a `conditions` row so the pattern engine has an exposure denominator.

## Repo map

| Path | What |
| --- | --- |
| `apps/web` | React + Vite PWA (offline-first, Dexie/IndexedDB) |
| `workers/api` | Hono API on Cloudflare Workers (D1, R2, Queues) — auth, CRUD, sync, Stripe webhooks |
| `workers/enrich` | Queue consumer — condition enrichment (Open-Meteo, USGS, moon/solar) |
| `workers/cron` | Nightly pattern recompute (producer + consumer of `waterlog-patterns`) + Web Push |
| `packages/schema` | Zod schemas mirroring the D1 tables — single source of truth for payload shapes |
| `packages/patterns` | Pure-TS pattern math, zero I/O, 100% branch coverage enforced by `pnpm test` |
| `migrations/` | Append-only D1 migrations + dev seed (seed is not a migration) |
| `docs/adr/` | Architecture decision records — required for any packet deviation |
| `docs/waterlog-startup-packet.md` | The master spec (see above) |

## Develop

```bash
pnpm install
pnpm -r test          # all packages
pnpm -r typecheck
pnpm -r lint
pnpm --filter web dev # PWA dev server
```

API worker locally:

```bash
cd workers/api
pnpm dev              # wrangler dev — serves GET /api/health
pnpm migrate          # wrangler d1 migrations apply DB --local
pnpm seed             # dev-only seed; NEVER run against production
```

Vite proxies `/api/*` to `127.0.0.1:8787`, so run both. Everything but `/api/health` needs a
session — without one the app shows the sign-in screen and every request 401s.

**Running the pattern engine locally.** Two things bite here. The main dev seed writes no
`conditions` rows at all (its catches are still `enrich_status = 'pending'`), and the engine
divides by exposure hours, so against that seed it correctly computes nothing. And each worker
keeps its own local D1 under its own `.wrangler/`, so the cron worker cannot see what you seeded
through the API worker. Both are solved by `--persist-to` and a second seed:

```bash
# One shared local database for every worker.
cd workers/api
pnpm exec wrangler d1 migrations apply DB --local --persist-to ../../.wrangler-local
pnpm exec wrangler d1 execute DB --local --persist-to ../../.wrangler-local \
  --file=../../migrations/seed/patterns-seed.sql

# Recompute: the scheduled handler enqueues, the queue consumer in the same worker computes.
cd ../cron
pnpm exec wrangler dev --test-scheduled --persist-to ../../.wrangler-local --port 8799
curl "http://127.0.0.1:8799/__scheduled?cron=0+8+*+*+*"
```

`patterns-seed.sql` writes the trip-hour rows directly, so no network and no enrich worker are
needed, and its header lists the exact cards it should produce. Sign in as
`patterns@waterlog.app` (tier `pro`, full cards) or `demo@waterlog.app` (tier `free`, the
redacted teaser view). Start the API worker with the same `--persist-to` to read the feed back.

**Signing in locally.** Google OAuth won't work against localhost (placeholder client secret,
unregistered redirect), so use the magic link, which the `ConsoleMailer` prints in the
`wrangler dev` console. That mailer is **opt-in**: it logs a working sign-in credential, so an
absent `RESEND_API_KEY` no longer falls back to it — without the flag the route answers 503 and
mints no token (ADR-0011). Create `workers/api/.dev.vars` (gitignored, see `.dev.vars.example`)
with `ALLOW_CONSOLE_MAIL = "true"` and `APP_URL = "http://localhost:5173"`, then restart
`wrangler dev`. `APP_URL` matters because `wrangler.toml` points it at the production Pages site;
without the override you must hand-edit the host when you paste the link. Never set
`ALLOW_CONSOLE_MAIL` in `wrangler.toml`. Sign in as **`demo@waterlog.app`** to see the seeded
trips and catches; any other address creates a fresh, empty user. The endpoint is rate-limited
(5 per address / 20 per IP per 15 min), so a scripted loop will start getting 429s.

## Deploy

Everything deploys from CI (`.github/workflows/ci.yml`) via `wrangler`. Web (Cloudflare Pages)
deploys on every PR (preview) and on push to `main` (production). Workers (api/enrich/cron) and
the waitlist worker deploy via `wrangler deploy` on merge to `main` only.

**One-time setup CI cannot do for you.** `wrangler deploy` will not create a queue, so the cron
worker needs `wrangler queues create waterlog-patterns` once before its first deploy. Web Push
needs a VAPID keypair: set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` as secrets
on `waterlog-cron`, and the same public key as `VAPID_PUBLIC_KEY` on `waterlog-api` (that is what
`GET /api/push/key` hands to browsers). Without them the nightly recompute still runs, the
first-pattern push is skipped, and the once-ever flag stays unclaimed so the announcement survives
until the keys are set. Never put the private key in `wrangler.toml`.
