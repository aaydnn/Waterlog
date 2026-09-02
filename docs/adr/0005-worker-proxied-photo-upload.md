# ADR-0005: Worker-proxied photo upload instead of presigned R2 URLs

Status: accepted
Date: 2026-09-02

## Context

`docs/waterlog-startup-packet.md`'s system flow diagram (§05) shows the API worker issuing "R2
presigned photo upload" URLs, so the client uploads bytes directly to R2 and the Worker never
touches the image payload.

Cloudflare's `R2Bucket` binding (the one already configured as `PHOTOS` in `wrangler.toml`) has no
built-in presign capability. Generating a real presigned URL means signing an S3-compatible
request (SigV4, e.g. via `aws4fetch`) against R2's S3 API endpoint, which requires an R2 API token
(Access Key ID + Secret Access Key) created in the Cloudflare dashboard and stored as a Worker
secret — a manual, account-holder-only step, plus a new credential pair to manage and rotate.

At current scale (solo founder dogfooding, side-project infra budget) that setup cost buys
nothing yet: photo volume is low, and the existing `PHOTOS` binding already does authenticated,
scoped writes with zero additional credentials.

## Decision

`POST /api/photos` accepts the raw image bytes directly (behind `requireAuth`) and writes them to
R2 via the existing binding: `c.env.PHOTOS.put(key, bytes, ...)`. The client uploads to the API
worker, not directly to R2. The object key is scoped under the authenticated user
(`photos/<user_id>/<ulid>.<ext>`) so one user can never read or overwrite another's key by
guessing it.

Accepted content types: `image/jpeg`, `image/png`, `image/webp`. Requests are capped at 10MB as a
defensive limit — the packet's client-side capture flow resizes to a 1600px max edge before
upload, so a well-behaved client's photos are far smaller than this ceiling.

## Consequences

- Photo bytes transit the Worker's CPU/bandwidth budget instead of going straight to R2. At MVP
  scale this is well within Workers' free/paid limits; if upload volume later makes this a real
  cost or latency problem, switch to presigned URLs then — the client-facing contract
  (`POST /api/photos` → `{ photo_key }`) does not need to change to make that swap, only the
  route's internals.
- No R2 API token to provision, store as a secret, or rotate. One fewer manual, human-only setup
  step blocking Epic 1 from being fully agent-buildable.
- Revisit this ADR once photo upload volume or Worker CPU cost is actually measured, not before.
