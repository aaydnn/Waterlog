# WaterLog

Personal fishing analytics PWA. pnpm monorepo:

| Path | What |
| --- | --- |
| `apps/web` | React + Vite PWA (the product) |
| `apps/waitlist` | Pre-launch waitlist site (see `docs/adr/0002`) |
| `workers/api` | Hono API on Cloudflare Workers (D1, R2, Queues) |
| `workers/enrich` | Queue consumer — condition enrichment |
| `workers/cron` | Scheduled worker — nightly pattern recompute |
| `packages/schema` | Zod schemas mirroring the D1 tables — the single source of truth for payload shapes |
| `packages/patterns` | Pattern math (Epic 4) |
| `migrations/` | Append-only D1 migrations (`NNNN_description.sql`) + dev seed |
| `docs/adr/` | Architecture decision records |

## Develop

```bash
pnpm install
pnpm -r test          # all packages
pnpm -r typecheck
pnpm -r lint
pnpm --filter web dev # PWA dev server
```

API worker locally (serves `GET /api/health`):

```bash
cd workers/api
pnpm dev              # wrangler dev
```

Enrichment uses modern USGS Water Data APIs. Configure `USGS_API_KEY` as a
server-side secret before production deployment; see
[USGS setup and migration validation](docs/usgs-migration.md).

## Database (local D1)

```bash
cd workers/api
pnpm migrate          # wrangler d1 migrations apply DB --local
pnpm seed             # dev-only seed; NEVER run against production
```

Migrations are append-only and numbered. The seed is not a migration.

## Deploy

Everything deploys from CI (`.github/workflows/ci.yml`) via `wrangler`.
Requires the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

- **Web (Cloudflare Pages)**: `wrangler pages deploy` runs on every PR (preview
  URL, one per branch) and on push to `main` (production).
- **Workers (api/enrich/cron) and the waitlist worker**: `wrangler deploy` on
  merge to `main` only — PR runs never deploy them.
