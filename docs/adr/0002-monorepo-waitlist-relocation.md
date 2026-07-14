# ADR-0002: Relocate the waitlist site to `apps/waitlist`

Status: accepted
Date: 2026-07-14

(Numbering note: ADR-0001 — App Store launch via Capacitor — lives in the
WaterLog Startup Packet v1.0 and is referenced throughout the Epic 0 brief;
repo-local ADRs start at 0002.)

## Context

The Epic 0 scaffold brief specifies an exact monorepo tree with `apps/web`
as the only app. Before Epic 0 started, this repository already contained a
deployed single-page waitlist site (React + Vite) at the repo root, live on
Cloudflare as the `waterlog` Worker.

Scaffolding the monorepo at the root conflicts with the waitlist's root-level
`package.json`, `src/`, `index.html`, and `vite.config.js`.

## Decision

Move the waitlist site wholesale to `apps/waitlist` as a workspace package,
unchanged except for its location. It keeps its own `wrangler.jsonc`, deploy
flow, and code style, and is excluded from the shared ESLint config. Its
`package-lock.json` was dropped; the pnpm workspace lockfile covers it now.

## Consequences

- The Epic 0 tree gains one directory (`apps/waitlist`) not present in the
  brief; everything else matches the brief exactly.
- The Cloudflare dashboard settings for the waitlist Worker must be updated:
  root directory `apps/waitlist` (or build command
  `pnpm --filter waterlog-waitlist build` and deploy command
  `npx wrangler deploy --config apps/waitlist/wrangler.jsonc` from the repo
  root). Until then, waitlist deploys from git pushes will fail; the already
  deployed site stays up.
- The waitlist can be retired or folded into `apps/web` when the product
  launches; deleting `apps/waitlist` is self-contained.
