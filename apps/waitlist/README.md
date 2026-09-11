# waterlog — waitlist

A single-page waitlist site. React + Vite, one stylesheet. Deploys to
Cloudflare either as a **Worker** (static assets + API, the current default in
the dashboard) or as a **Pages** project. The API logic is shared between the
two, so both behave identically.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm run preview  # serve the built dist/
```

## Deploy A — Cloudflare Worker (recommended, matches the dashboard "Create a Worker" flow)

Config lives in `wrangler.jsonc`; the Worker entry is `worker/index.js`, which
serves the built `dist/` via the `ASSETS` binding and handles
`POST /api/waitlist`.

Git-connected build settings (Workers Builds wizard):

- **Project name:** `waterlog` (keep it matching `name` in `wrangler.jsonc`)
- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`

Or deploy from your machine:

```bash
npm run build
npx wrangler deploy      # same as: npm run deploy
```

Run it locally with the Worker runtime:

```bash
npm run build
npx wrangler dev         # serves dist/ + /api/waitlist
```

### Waitlist storage (KV) for the Worker

The endpoint writes to a KV namespace bound as `WAITLIST`. Until it's bound,
signups return HTTP 500 ("storage is not configured") and the rest of the site
works.

```bash
npx wrangler kv namespace create WAITLIST   # copy the printed id
```

Then uncomment the `kv_namespaces` block in `wrangler.jsonc`, paste the id, and
redeploy (or push, if git-connected).

## Deploy B — Cloudflare Pages

- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Functions:** `functions/api/waitlist.js` is picked up automatically and
  serves `POST /api/waitlist`.

### Waitlist storage (KV)

The signup endpoint writes to a KV namespace bound as `WAITLIST`.

Dashboard → Workers & Pages → this project → Settings → Functions →
**KV namespace bindings** → add:

- Variable name: `WAITLIST`
- KV namespace: create one (e.g. `waterlog-waitlist`)

Add the binding for both Production and Preview.

To run the Function locally with Wrangler:

```bash
npx wrangler kv namespace create WAITLIST
npx wrangler kv namespace create WAITLIST --preview
npm run build
npx wrangler pages dev dist
```

See the comment header in `functions/api/waitlist.js` for the matching
`wrangler.toml` snippet.

### Keys in the namespace

Two prefixes share the namespace, so an export has to filter:

- `email:<address>` — a signup record, `{ email, phone, created_at }`. This is the list.
- `ip:<address>` — the per-IP submission counter, 10 per rolling hour, self-expiring via
  `expirationTtl`. Not data; ignore it when exporting.

The endpoint answers `200 {"ok":true}` whether the address is new or already stored, so it
cannot be used to test who has signed up. A duplicate keeps the original record's timestamp.
