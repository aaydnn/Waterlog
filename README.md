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

## Database (local D1)

```bash
cd workers/api
pnpm migrate          # wrangler d1 migrations apply DB --local
pnpm seed             # dev-only seed; NEVER run against production
```

Migrations are append-only and numbered. The seed is not a migration.

## Deploy

- **Web (Cloudflare Pages)**: connected via the Pages GitHub integration.
  Build command `pnpm --filter web build`, output directory `apps/web/dist`.
  Pages posts a preview URL on every PR.
- **Workers**: deployed by CI (`.github/workflows/ci.yml`) via
  `wrangler deploy` on merge to `main` only. Requires the
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.
