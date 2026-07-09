# waterlog — waitlist

A single-page waitlist site. React + Vite, one stylesheet, deploys to
Cloudflare Pages.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm run preview  # serve the built dist/
```

## Deploy (Cloudflare Pages)

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
