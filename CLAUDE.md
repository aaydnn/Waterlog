# WaterLog

Personal fishing analytics PWA. Full product/architecture spec:
**`docs/waterlog-startup-packet.md`** — read it before any feature work. It is the single source of
truth for product principles, data model, pattern-engine math, and build order. This file only
pulls out the rules that must never be silently violated.

## Non-negotiable build rules

- **Work epic-by-epic.** Don't start the next epic until the current one's acceptance criteria
  (see packet §10) pass. Current epic: **3 — Journal & Stats**. Its acceptance criterion
  (numbers reconcile with raw SQL) passes — see `docs/epic-3-acceptance.md` for the spot-check
  and the gaps it carries into Epic 4. Epics 1 (Capture & Sync) and 2 (Enrichment) are done and
  deployed; Epic 2's evidence is in `docs/epic-2-acceptance.md`. Real-water validation — one
  real catch, one real skunked trip — is still open for both.
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
| `workers/cron` | Nightly pattern recompute + briefing pushes |
| `packages/schema` | Zod schemas mirroring the D1 tables — single source of truth for payload shapes |
| `packages/patterns` | Pure-TS pattern math (Epic 4), zero I/O, 100% branch coverage required |
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

**Signing in locally.** Google OAuth won't work against localhost (placeholder client secret,
unregistered redirect), so use the magic link: `RESEND_API_KEY` is unset in dev, so the
`ConsoleMailer` prints the link in the `wrangler dev` console. The link is built from `APP_URL`,
which in `wrangler.toml` is the production Pages site — create `workers/api/.dev.vars` (gitignored)
with `APP_URL = "http://localhost:5173"` and restart `wrangler dev`, or hand-edit the host when
you paste it. Sign in as **`demo@waterlog.app`** to see the seeded trips and catches; any other
address creates a fresh, empty user.

## Deploy

Everything deploys from CI (`.github/workflows/ci.yml`) via `wrangler`. Web (Cloudflare Pages)
deploys on every PR (preview) and on push to `main` (production). Workers (api/enrich/cron) and
the waitlist worker deploy via `wrangler deploy` on merge to `main` only.
