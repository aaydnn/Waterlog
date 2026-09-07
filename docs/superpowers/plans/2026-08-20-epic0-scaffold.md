# WaterLog Epic 0 Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the empty-but-working WaterLog monorepo skeleton (repo/CI/deploy, DB schema + seed, auth) that Epics 1-6 will build feature code on top of.

**Architecture:** pnpm workspace monorepo with `apps/web` (React+Vite PWA), three Cloudflare Workers (`workers/api` on Hono, `workers/enrich`, `workers/cron`), and two shared packages (`packages/schema` Zod types, `packages/patterns` empty). D1 is the database, migrations are hand-written SQL applied via `wrangler d1 migrations apply`. Auth is custom session-cookie based (no JWT), following the Lucia-project session pattern, with email magic links and Google OAuth as the two sign-in methods.

**Tech Stack:** TypeScript 5 (strict), pnpm workspaces, Vite 5 + React 18 + vite-plugin-pwa, Hono 4 on Cloudflare Workers, D1, Zod 3, Vitest 2 (+ `@cloudflare/vitest-pool-workers` for DB-backed worker tests), ESLint 9 flat config + Prettier, GitHub Actions CI, Cloudflare Pages (web) + `wrangler deploy` (workers).

## Global Constraints

- TypeScript `strict: true` everywhere. No `any` without an inline justification comment.
- Never invent payload shapes — all shared shapes live in `packages/schema` (Zod), imported by both client and workers.
- Migrations are append-only, numbered `NNNN_description.sql`. Migration 0001 is transcribed verbatim from the spec — do not "improve" it.
- Any deviation from the spec requires a written ADR committed to `docs/adr/` in the same PR.
- Every task lands as a separate PR with tests (this plan assumes a human/agent opens one PR per task against `main`).
- `.gitignore` (`node_modules/`, `dist/`, `.wrangler/`, `.env*`) must be committed before anything else — never commit `node_modules`.
- All filenames/import paths are lowercase-kebab or exact-case-matched (Cloudflare's Linux build environment is case-sensitive even though local dev may not be).
- `vite.config.ts` `base` stays `'/'`.
- Out of scope for Epic 0: camera/capture UI, Dexie schema beyond an empty shell, Open-Meteo/USGS code, pattern math, Stripe/RevenueCat, push delivery, Capacitor wrap, onboarding screens.
- Package names in this plan are unscoped (`web`, `api`, `enrich`, `cron`, `schema`, `patterns`) so that `pnpm --filter web build` etc. (as CI requires) resolve directly.

---

## Task 1: Repo Skeleton and Shared Tooling Config

**Files:**
- Create: `.gitignore`
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `docs/adr/.gitkeep`

**Interfaces:**
- Produces: root `pnpm` scripts (`typecheck`, `lint`, `test`, `build`, `seed`) that every later task's package-level scripts are invoked through via `pnpm -r` or `pnpm --filter <pkg>`.
- Produces: `tsconfig.base.json` compiler options that every package's `tsconfig.json` extends.

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
dist/
.wrangler/
.env
.env.*
*.log
.DS_Store
coverage/
.superpowers/
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "waterlog",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "seed": "pnpm --filter api seed"
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "eslint": "^9.13.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.3",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.11.0",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "workers/*"
  - "packages/*"
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": false
  }
}
```

- [ ] **Step 5: Create `eslint.config.js` (flat config, shared across workspace)**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.wrangler/**", "**/node_modules/**", "**/.vite/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
```

- [ ] **Step 6: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
```

- [ ] **Step 7: Create `docs/adr/.gitkeep`**

Empty file — keeps the directory tracked by git before any ADR exists.

- [ ] **Step 8: Initialize git and make the first commit**

Run:
```bash
git init
git add .gitignore package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.js .prettierrc docs/adr/.gitkeep
git commit -m "chore: scaffold repo tooling config"
```
Expected: commit succeeds, `git status` shows a clean tree with no `node_modules` tracked.

- [ ] **Step 9: Verify**

Run: `pnpm install`
Expected: lockfile `pnpm-lock.yaml` is created, no errors (no packages to build yet, this just installs root devDependencies).

---

## Task 2: `packages/schema` and `packages/patterns` Scaffolds

**Files:**
- Create: `packages/schema/package.json`
- Create: `packages/schema/tsconfig.json`
- Create: `packages/schema/vitest.config.ts`
- Create: `packages/schema/src/index.ts`
- Create: `packages/schema/src/index.test.ts`
- Create: `packages/patterns/package.json`
- Create: `packages/patterns/tsconfig.json`
- Create: `packages/patterns/vitest.config.ts`
- Create: `packages/patterns/src/index.ts`
- Create: `packages/patterns/src/index.test.ts`

**Interfaces:**
- Produces: `schema` package importable as `"schema"` from any workspace package via `"schema": "workspace:*"`. Task 9 fills in the real Zod exports; this task only proves the package boundary (build/lint/test) works.
- Produces: `patterns` package importable as `"patterns"`, left empty for Epic 4.

- [ ] **Step 1: Create `packages/schema/package.json`**

```json
{
  "name": "schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 2: Create `packages/schema/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/schema/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 4: Create placeholder `packages/schema/src/index.ts`**

```ts
export const SCHEMA_PACKAGE_VERSION = "0.0.0";
```

- [ ] **Step 5: Create `packages/schema/src/index.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { SCHEMA_PACKAGE_VERSION } from "./index";

describe("schema package", () => {
  it("exposes a version marker", () => {
    expect(SCHEMA_PACKAGE_VERSION).toBe("0.0.0");
  });
});
```

- [ ] **Step 6: Create `packages/patterns/package.json`**

```json
{
  "name": "patterns",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 7: Create `packages/patterns/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 8: Create `packages/patterns/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 9: Create placeholder `packages/patterns/src/index.ts`**

```ts
// Filled in by Epic 4 (pattern math). Epic 0 only proves the package boundary works.
export const PATTERNS_PACKAGE_VERSION = "0.0.0";
```

- [ ] **Step 10: Create `packages/patterns/src/index.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { PATTERNS_PACKAGE_VERSION } from "./index";

describe("patterns package", () => {
  it("exposes a version marker", () => {
    expect(PATTERNS_PACKAGE_VERSION).toBe("0.0.0");
  });
});
```

- [ ] **Step 11: Install and verify**

Run: `pnpm install && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green for the two new packages.

- [ ] **Step 12: Commit**

```bash
git add packages
git commit -m "chore: scaffold schema and patterns packages"
```

---

## Task 3: `apps/web` Scaffold (Vite + React PWA + Seam Interfaces)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/app.test.tsx`
- Create: `apps/web/src/test-setup.ts`
- Create: `apps/web/src/ui/tokens.css`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/db.ts`
- Create: `apps/web/src/lib/sync/sync-engine.ts`
- Create: `apps/web/src/lib/push/push-registrar.ts`
- Create: `apps/web/src/lib/auth/auth-provider.ts`
- Create: `apps/web/src/features/capture/.gitkeep`
- Create: `apps/web/src/features/trips/.gitkeep`
- Create: `apps/web/src/features/journal/.gitkeep`
- Create: `apps/web/src/features/patterns/.gitkeep`
- Create: `apps/web/src/features/briefing/.gitkeep`
- Create: `apps/web/src/features/settings/.gitkeep`

**Interfaces:**
- Produces: `SyncEngine` interface (`enqueue(record: unknown): Promise<void>`, `flush(): Promise<SyncResult>`) — feature code in Epics 1+ imports this interface, never `WebSyncEngine` directly.
- Produces: `PushRegistrar` interface (`register(): Promise<PushToken | null>`).
- Produces: `AuthProvider` interface (`signIn(method: AuthMethod): Promise<Session>`, `signOut(): Promise<void>`), with `AuthMethod = "magic_link" | "google" | "apple"` so the Apple method (Epic 5.5) is accommodated without a later interface change.
- Consumes: nothing yet from other packages (schema wiring happens when feature code lands in Epic 1+).

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "dexie": "^4.0.8",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.9",
    "vite-plugin-pwa": "^0.20.5",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "WaterLog",
        short_name: "WaterLog",
        start_url: "/",
        display: "standalone",
        background_color: "#0b1220",
        theme_color: "#0b1220",
        icons: []
      }
    })
  ]
});
```

- [ ] **Step 4: Create `apps/web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"]
  }
});
```

- [ ] **Step 5: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WaterLog</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/src/ui/tokens.css`**

```css
:root {
  --wl-color-bg: #0b1220;
  --wl-color-surface: #131b2e;
  --wl-color-text: #e7edf7;
  --wl-color-primary: #2f8fef;
  --wl-color-accent: #33c2a0;
  --wl-font-sans: system-ui, -apple-system, sans-serif;
  --wl-space-1: 4px;
  --wl-space-2: 8px;
  --wl-space-3: 16px;
  --wl-space-4: 24px;
}
```

- [ ] **Step 7: Create `apps/web/src/app.tsx`**

```tsx
export default function App() {
  return (
    <main>
      <h1>WaterLog</h1>
    </main>
  );
}
```

- [ ] **Step 8: Create `apps/web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import "./ui/tokens.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 9: Create `apps/web/src/test-setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 10: Create `apps/web/src/app.test.tsx`**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./app";

describe("App", () => {
  it("renders the WaterLog heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "WaterLog" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 11: Create `apps/web/src/lib/api-client.ts`**

```ts
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init
  });
}
```

- [ ] **Step 12: Create `apps/web/src/lib/db.ts`**

```ts
import Dexie from "dexie";

export class WaterLogDb extends Dexie {
  constructor() {
    super("waterlog");
    // Epic 1+ adds object stores here. Epic 0 only proves the shell boots.
    this.version(1).stores({});
  }
}

export const db = new WaterLogDb();
```

- [ ] **Step 13: Create `apps/web/src/lib/sync/sync-engine.ts`**

```ts
export interface SyncResult {
  pushed: number;
  failed: number;
}

export interface SyncEngine {
  enqueue(record: unknown): Promise<void>;
  flush(): Promise<SyncResult>;
}

export class WebSyncEngine implements SyncEngine {
  async enqueue(_record: unknown): Promise<void> {
    throw new Error("NotImplementedError: WebSyncEngine.enqueue is not implemented in Epic 0");
  }

  async flush(): Promise<SyncResult> {
    throw new Error("NotImplementedError: WebSyncEngine.flush is not implemented in Epic 0");
  }
}
```

- [ ] **Step 14: Create `apps/web/src/lib/push/push-registrar.ts`**

```ts
export interface PushToken {
  token: string;
  platform: "web" | "ios" | "android";
}

export interface PushRegistrar {
  register(): Promise<PushToken | null>;
}

export class WebPushRegistrar implements PushRegistrar {
  async register(): Promise<PushToken | null> {
    throw new Error("NotImplementedError: WebPushRegistrar.register is not implemented in Epic 0");
  }
}
```

- [ ] **Step 15: Create `apps/web/src/lib/auth/auth-provider.ts`**

```ts
export type AuthMethod = "magic_link" | "google" | "apple";

export interface Session {
  userId: string;
  expiresAt: number;
}

export interface AuthProvider {
  signIn(method: AuthMethod): Promise<Session>;
  signOut(): Promise<void>;
}

export class WebAuthProvider implements AuthProvider {
  async signIn(_method: AuthMethod): Promise<Session> {
    throw new Error("NotImplementedError: WebAuthProvider.signIn is not implemented in Epic 0");
  }

  async signOut(): Promise<void> {
    throw new Error("NotImplementedError: WebAuthProvider.signOut is not implemented in Epic 0");
  }
}
```

- [ ] **Step 16: Create empty feature directories**

Create these six empty marker files (one per feature area — later epics fill the directories in):
`apps/web/src/features/capture/.gitkeep`, `apps/web/src/features/trips/.gitkeep`, `apps/web/src/features/journal/.gitkeep`, `apps/web/src/features/patterns/.gitkeep`, `apps/web/src/features/briefing/.gitkeep`, `apps/web/src/features/settings/.gitkeep`

- [ ] **Step 17: Install and verify**

Run: `pnpm install && pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test && pnpm --filter web build`
Expected: all green, `apps/web/dist/` produced by the build.

- [ ] **Step 18: Commit**

```bash
git add apps/web
git commit -m "chore: scaffold web PWA shell with sync/push/auth seams"
```

---

## Task 4: `workers/api` Scaffold (Hono Health Route)

**Files:**
- Create: `workers/api/package.json`
- Create: `workers/api/tsconfig.json`
- Create: `workers/api/wrangler.toml`
- Create: `workers/api/vitest.config.ts`
- Create: `workers/api/src/env.ts`
- Create: `workers/api/src/index.ts`
- Create: `workers/api/src/index.test.ts`

**Interfaces:**
- Produces: `Env` type (`DB: D1Database`, `PHOTOS: R2Bucket`, `ENRICH_QUEUE: Queue`, `GOOGLE_CLIENT_ID: string`, `GOOGLE_CLIENT_SECRET: string`, `GOOGLE_REDIRECT_URI: string`) that Task 12-15 middleware and routes import from `./env`.
- Produces: default-exported Hono `app` from `src/index.ts` that Task 15 adds routes to.
- Produces: `GET /api/health` → `{ ok: true, version: string }`, `GET /api/me` → `501` stub (Task 15 replaces this with the authed version).

- [ ] **Step 1: Create `workers/api/package.json`**

```json
{
  "name": "api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "deploy": "wrangler deploy",
    "db:migrate": "wrangler d1 migrations apply waterlog-db --local",
    "seed": "wrangler d1 execute waterlog-db --local --file=../../migrations/seed/seed.sql"
  },
  "dependencies": {
    "hono": "^4.6.6",
    "schema": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241004.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3",
    "wrangler": "^3.83.0"
  }
}
```

- [ ] **Step 2: Create `workers/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `workers/api/wrangler.toml`**

```toml
name = "waterlog-api"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "waterlog-db"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
migrations_dir = "../../migrations"

[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "waterlog-photos"

[[queues.producers]]
binding = "ENRICH_QUEUE"
queue = "waterlog-enrich"

[vars]
GOOGLE_CLIENT_ID = ""
GOOGLE_REDIRECT_URI = "http://localhost:8787/api/auth/google/callback"

# Secret, set via `wrangler secret put GOOGLE_CLIENT_SECRET` — never commit its value:
# GOOGLE_CLIENT_SECRET
```

- [ ] **Step 4: Create `workers/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 5: Create `workers/api/src/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ENRICH_QUEUE: Queue;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
}
```

- [ ] **Step 6: Create `workers/api/src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

const VERSION = "0.0.0";

app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));

app.get("/api/me", (c) => c.json({ error: "not_implemented" }, 501));

export default app;
```

- [ ] **Step 7: Create `workers/api/src/index.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import app from "./index";

describe("GET /api/health", () => {
  it("returns ok and a version", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; version: string }>();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });
});
```

- [ ] **Step 8: Install and verify**

Run: `pnpm install && pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test`
Expected: all green. (`wrangler dev` verification happens after Task 8's migration exists — D1 binding requires a migration to be meaningful, but the health route works even before that; you may optionally run `pnpm --filter api dev` now and confirm `curl http://localhost:8787/api/health` returns `{"ok":true,"version":"0.0.0"}`.)

- [ ] **Step 9: Commit**

```bash
git add workers/api
git commit -m "chore: scaffold api worker with health route"
```

---

## Task 5: `workers/enrich` Scaffold (Queue Consumer Stub)

**Files:**
- Create: `workers/enrich/package.json`
- Create: `workers/enrich/tsconfig.json`
- Create: `workers/enrich/wrangler.toml`
- Create: `workers/enrich/vitest.config.ts`
- Create: `workers/enrich/src/index.ts`
- Create: `workers/enrich/src/index.test.ts`

**Interfaces:**
- Produces: default-exported worker object with a `queue(batch, env)` handler. Epic-later enrichment logic replaces the body; the handler shape (`queue(batch: MessageBatch<EnrichMessage>, env: Env): Promise<void>`) is what later epics must match.

- [ ] **Step 1: Create `workers/enrich/package.json`**

```json
{
  "name": "enrich",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "dependencies": {},
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241004.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3",
    "wrangler": "^3.83.0"
  }
}
```

- [ ] **Step 2: Create `workers/enrich/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `workers/enrich/wrangler.toml`**

```toml
name = "waterlog-enrich"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[[queues.consumers]]
queue = "waterlog-enrich"
max_batch_size = 10
max_retries = 3

[[d1_databases]]
binding = "DB"
database_name = "waterlog-db"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

- [ ] **Step 4: Create `workers/enrich/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 5: Create `workers/enrich/src/index.ts`**

```ts
export interface Env {
  DB: D1Database;
}

interface EnrichMessage {
  catchId: string;
}

export default {
  async queue(batch: MessageBatch<EnrichMessage>, _env: Env): Promise<void> {
    for (const message of batch.messages) {
      console.log(`[enrich] received message for catch ${message.body.catchId}`);
      message.ack();
    }
  }
};
```

- [ ] **Step 6: Create `workers/enrich/src/index.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import worker from "./index";

function fakeBatch(catchIds: string[]) {
  const acked: string[] = [];
  return {
    batch: {
      messages: catchIds.map((catchId) => ({
        body: { catchId },
        ack: vi.fn(() => acked.push(catchId))
      }))
    } as unknown as MessageBatch<{ catchId: string }>,
    acked
  };
}

describe("enrich queue handler", () => {
  it("acks every message in the batch", async () => {
    const { batch, acked } = fakeBatch(["catch_1", "catch_2"]);
    await worker.queue(batch, { DB: {} as D1Database });
    expect(acked).toEqual(["catch_1", "catch_2"]);
  });
});
```

- [ ] **Step 7: Install and verify**

Run: `pnpm install && pnpm --filter enrich typecheck && pnpm --filter enrich lint && pnpm --filter enrich test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add workers/enrich
git commit -m "chore: scaffold enrich worker queue stub"
```

---

## Task 6: `workers/cron` Scaffold (Scheduled Handler Stub)

**Files:**
- Create: `workers/cron/package.json`
- Create: `workers/cron/tsconfig.json`
- Create: `workers/cron/wrangler.toml`
- Create: `workers/cron/vitest.config.ts`
- Create: `workers/cron/src/index.ts`
- Create: `workers/cron/src/index.test.ts`

**Interfaces:**
- Produces: default-exported worker object with a `scheduled(controller, env)` handler that later epics' nightly-recompute logic replaces.

- [ ] **Step 1: Create `workers/cron/package.json`**

```json
{
  "name": "cron",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "dependencies": {},
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241004.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3",
    "wrangler": "^3.83.0"
  }
}
```

- [ ] **Step 2: Create `workers/cron/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `workers/cron/wrangler.toml`**

```toml
name = "waterlog-cron"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["0 8 * * *"]

[[d1_databases]]
binding = "DB"
database_name = "waterlog-db"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

- [ ] **Step 4: Create `workers/cron/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 5: Create `workers/cron/src/index.ts`**

```ts
export interface Env {
  DB: D1Database;
}

export default {
  async scheduled(controller: ScheduledController, _env: Env): Promise<void> {
    console.log(`[cron] nightly recompute triggered at ${new Date(controller.scheduledTime).toISOString()}`);
  }
};
```

- [ ] **Step 6: Create `workers/cron/src/index.test.ts`**

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "./index";

describe("cron scheduled handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the nightly invocation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = { scheduledTime: Date.UTC(2026, 0, 1, 8, 0, 0) } as ScheduledController;

    await worker.scheduled(controller, { DB: {} as D1Database });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[cron] nightly recompute triggered"));
  });
});
```

- [ ] **Step 7: Install and verify**

Run: `pnpm install && pnpm --filter cron typecheck && pnpm --filter cron lint && pnpm --filter cron test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add workers/cron
git commit -m "chore: scaffold cron worker scheduled stub"
```

---

## Task 7: CI Workflow and Deploy Documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/deploy-setup.md`

**Interfaces:**
- Consumes: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm --filter web build`, and the per-worker `deploy` scripts from Tasks 1-6.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm -r lint
      - run: pnpm -r test
      - run: pnpm --filter web build

  deploy-workers:
    needs: build
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: pnpm --filter enrich deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: pnpm --filter cron deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 2: Create `docs/deploy-setup.md`**

```markdown
# Deploy Setup (one-time, manual)

CI cannot perform these steps — they require dashboard/account access.

## Cloudflare Pages (web)

1. Push this repo to GitHub.
2. In the Cloudflare dashboard, go to Workers & Pages -> Create -> Pages -> Connect to Git, and select this repo.
3. Build command: `pnpm --filter web build`
4. Build output directory: `apps/web/dist`
5. Save. Pages' own PR preview deployments satisfy the "preview deploy on PR" requirement — no custom preview pipeline is needed.

## Cloudflare Workers (api / enrich / cron)

1. Create the D1 database: `wrangler d1 create waterlog-db`, then paste the returned `database_id` into the `[[d1_databases]]` block of `workers/api/wrangler.toml`, `workers/enrich/wrangler.toml`, and `workers/cron/wrangler.toml`.
2. Create the R2 bucket: `wrangler r2 bucket create waterlog-photos`.
3. Create the queue: `wrangler queues create waterlog-enrich`.
4. Set the Google OAuth client secret: `wrangler secret put GOOGLE_CLIENT_SECRET --name waterlog-api` (value from the Google Cloud Console OAuth client).
5. In GitHub repo Settings -> Secrets and variables -> Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` so the `deploy-workers` CI job can run `wrangler deploy` on merges to `main`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml docs/deploy-setup.md
git commit -m "chore: add CI workflow and manual deploy setup docs"
```

- [ ] **Step 4: Verify (after pushing to GitHub — see manual step below)**

Open a PR against `main` and confirm the `build` job runs `typecheck`, `lint`, `test`, and `pnpm --filter web build` successfully. This requires the repo to exist on GitHub first — pushing to a remote is a manual, user-approved step, not something this plan automates. See `docs/deploy-setup.md` for the Cloudflare Pages connection that turns that PR into a live preview URL.

---

## Task 8: Migration 0001 (Initial Schema)

**Files:**
- Create: `migrations/0001_initial_schema.sql`

**Interfaces:**
- Produces: the seven D1 tables (`users`, `water_bodies`, `lures`, `trips`, `catches`, `conditions`, `pattern_cache`) that Task 9's Zod schemas mirror and Task 10's seed data populates.

- [ ] **Step 1: Create `migrations/0001_initial_schema.sql` (transcribed verbatim from the spec — do not modify)**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  home_lat REAL, home_lng REAL,
  units TEXT NOT NULL DEFAULT 'imperial',      -- imperial | metric
  tier TEXT NOT NULL DEFAULT 'free',           -- free | pro
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE water_bodies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT,                                    -- lake | river | pond | reservoir | saltwater
  centroid_lat REAL, centroid_lng REAL,
  usgs_gauge_id TEXT,
  is_home INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE lures (                            -- generic "offering": lure, bait, or fly
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  family TEXT,                                  -- spinnerbait | crankbait | soft_plastic | jig | topwater | live_bait | fly | other
  color TEXT,                                   -- normalized color slug
  cost_cents INTEGER,
  retired_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  water_body_id TEXT REFERENCES water_bodies(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                             -- null = active
  auto_created INTEGER NOT NULL DEFAULT 0,
  planned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_trips_user_time ON trips(user_id, started_at);

CREATE TABLE catches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lure_id TEXT REFERENCES lures(id),
  species TEXT NOT NULL,
  caught_at INTEGER NOT NULL,
  lat REAL, lng REAL,
  photo_key TEXT,
  length_mm INTEGER, weight_g INTEGER,
  depth_m REAL,
  released INTEGER,
  notes TEXT,
  client_id TEXT UNIQUE,                        -- client ULID: offline dedupe, idempotent sync
  enrich_status TEXT NOT NULL DEFAULT 'pending',-- pending | done | partial | failed
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_catches_user_time ON catches(user_id, caught_at);
CREATE INDEX idx_catches_trip ON catches(trip_id);

CREATE TABLE conditions (                       -- one row per catch AND one per trip-hour
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  catch_id TEXT REFERENCES catches(id),
  trip_id TEXT REFERENCES trips(id),
  hour_bucket INTEGER,
  air_temp_c REAL, cloud_pct REAL, wind_kph REAL, precip_mm REAL,
  pressure_hpa REAL, pressure_trend TEXT,       -- falling | stable | rising
  moon_phase REAL,                              -- 0..1 (0 = new)
  minutes_from_sunrise INTEGER,
  water_temp_c REAL, discharge_cms REAL,
  season TEXT,
  source_meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_conditions_catch ON conditions(catch_id);
CREATE INDEX idx_conditions_trip_hour ON conditions(trip_id, hour_bucket);

CREATE TABLE pattern_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,                          -- 'all' | water_body_id
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL,
  catches INTEGER NOT NULL,
  hours REAL NOT NULL,
  rate REAL NOT NULL,
  baseline_rate REAL NOT NULL,
  multiplier REAL NOT NULL,
  confidence TEXT NOT NULL,                     -- early | promising | solid
  computed_at INTEGER NOT NULL
);
CREATE INDEX idx_pattern_user_scope ON pattern_cache(user_id, scope, multiplier);
```

- [ ] **Step 2: Apply and verify locally**

Run (from `workers/api/`): `pnpm db:migrate`
Expected: `wrangler d1 migrations apply waterlog-db --local` reports migration `0001_initial_schema.sql` applied cleanly against a fresh local D1 (a `.wrangler/state` local DB file is created; this is gitignored).

- [ ] **Step 3: Commit**

```bash
git add migrations/0001_initial_schema.sql
git commit -m "feat: add initial D1 schema migration"
```

---

## Task 9: Zod Schemas in `packages/schema`

**Files:**
- Modify: `packages/schema/src/index.ts`
- Create: `packages/schema/src/index.test.ts` (replaces the placeholder test from Task 2)

**Interfaces:**
- Consumes: the table shapes from `migrations/0001_initial_schema.sql` (Task 8).
- Produces: `userSchema`/`User`, `waterBodySchema`/`WaterBody`, `lureSchema`/`Lure`, `tripSchema`/`Trip`, `catchSchema`/`Catch`, `conditionsSchema`/`Conditions`, `patternCacheRowSchema`/`PatternCacheRow` — the only vocabulary later epics may use for these payload shapes.

- [ ] **Step 1: Replace `packages/schema/src/index.ts` with real schemas**

```ts
import { z } from "zod";

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  home_lat: z.number().nullable(),
  home_lng: z.number().nullable(),
  units: z.enum(["imperial", "metric"]),
  tier: z.enum(["free", "pro"]),
  stripe_customer_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
});
export type User = z.infer<typeof userSchema>;

export const waterBodySchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  kind: z.enum(["lake", "river", "pond", "reservoir", "saltwater"]).nullable(),
  centroid_lat: z.number().nullable(),
  centroid_lng: z.number().nullable(),
  usgs_gauge_id: z.string().nullable(),
  is_home: z.number().int().min(0).max(1),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
});
export type WaterBody = z.infer<typeof waterBodySchema>;

export const lureSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  family: z
    .enum(["spinnerbait", "crankbait", "soft_plastic", "jig", "topwater", "live_bait", "fly", "other"])
    .nullable(),
  color: z.string().nullable(),
  cost_cents: z.number().int().nullable(),
  retired_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
});
export type Lure = z.infer<typeof lureSchema>;

export const tripSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  water_body_id: z.string().nullable(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  auto_created: z.number().int().min(0).max(1),
  planned: z.number().int().min(0).max(1),
  notes: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
});
export type Trip = z.infer<typeof tripSchema>;

export const catchSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  trip_id: z.string(),
  lure_id: z.string().nullable(),
  species: z.string(),
  caught_at: z.number(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  photo_key: z.string().nullable(),
  length_mm: z.number().int().nullable(),
  weight_g: z.number().int().nullable(),
  depth_m: z.number().nullable(),
  released: z.number().int().min(0).max(1).nullable(),
  notes: z.string().nullable(),
  client_id: z.string().nullable(),
  enrich_status: z.enum(["pending", "done", "partial", "failed"]),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
});
export type Catch = z.infer<typeof catchSchema>;

export const conditionsSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  catch_id: z.string().nullable(),
  trip_id: z.string().nullable(),
  hour_bucket: z.number().int().nullable(),
  air_temp_c: z.number().nullable(),
  cloud_pct: z.number().nullable(),
  wind_kph: z.number().nullable(),
  precip_mm: z.number().nullable(),
  pressure_hpa: z.number().nullable(),
  pressure_trend: z.enum(["falling", "stable", "rising"]).nullable(),
  moon_phase: z.number().min(0).max(1).nullable(),
  minutes_from_sunrise: z.number().int().nullable(),
  water_temp_c: z.number().nullable(),
  discharge_cms: z.number().nullable(),
  season: z.string().nullable(),
  source_meta: z.string().nullable(),
  created_at: z.number()
});
export type Conditions = z.infer<typeof conditionsSchema>;

export const patternCacheRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  scope: z.string(),
  dimension: z.string(),
  bucket: z.string(),
  catches: z.number().int(),
  hours: z.number(),
  rate: z.number(),
  baseline_rate: z.number(),
  multiplier: z.number(),
  confidence: z.enum(["early", "promising", "solid"]),
  computed_at: z.number()
});
export type PatternCacheRow = z.infer<typeof patternCacheRowSchema>;
```

- [ ] **Step 2: Replace `packages/schema/src/index.test.ts` with round-trip tests against seed-shaped objects**

```ts
import { describe, expect, it } from "vitest";
import {
  catchSchema,
  conditionsSchema,
  lureSchema,
  patternCacheRowSchema,
  tripSchema,
  userSchema,
  waterBodySchema
} from "./index";

describe("schema round trips", () => {
  it("parses a seed-shaped user row", () => {
    const row = {
      id: "usr_demo",
      email: "demo@waterlog.app",
      display_name: "Demo Angler",
      home_lat: 36.1627,
      home_lng: -86.7816,
      units: "imperial",
      tier: "free",
      stripe_customer_id: null,
      created_at: 1735689600000,
      updated_at: 1735689600000,
      deleted_at: null
    };
    expect(userSchema.parse(row)).toEqual(row);
  });

  it("parses a seed-shaped water body row", () => {
    const row = {
      id: "wb_norris_lake",
      user_id: "usr_demo",
      name: "Norris Lake",
      kind: "lake",
      centroid_lat: 36.3134,
      centroid_lng: -83.9291,
      usgs_gauge_id: null,
      is_home: 1,
      created_at: 1735689600000,
      updated_at: 1735689600000,
      deleted_at: null
    };
    expect(waterBodySchema.parse(row)).toEqual(row);
  });

  it("parses a seed-shaped lure row with a cost set", () => {
    const row = {
      id: "lure_spinnerbait_chartreuse",
      user_id: "usr_demo",
      name: "War Eagle Spinnerbait",
      family: "spinnerbait",
      color: "chartreuse",
      cost_cents: 799,
      retired_at: null,
      created_at: 1735689600000,
      updated_at: 1735689600000,
      deleted_at: null
    };
    expect(lureSchema.parse(row)).toEqual(row);
  });

  it("parses a seed-shaped trip row", () => {
    const row = {
      id: "trip_norris_1",
      user_id: "usr_demo",
      water_body_id: "wb_norris_lake",
      started_at: 1736683200000,
      ended_at: 1736695800000,
      auto_created: 0,
      planned: 1,
      notes: "Morning trip, topwater bite early.",
      created_at: 1736683200000,
      updated_at: 1736695800000,
      deleted_at: null
    };
    expect(tripSchema.parse(row)).toEqual(row);
  });

  it("parses a seed-shaped catch row", () => {
    const row = {
      id: "catch_001",
      user_id: "usr_demo",
      trip_id: "trip_norris_1",
      lure_id: "lure_spinnerbait_chartreuse",
      species: "largemouth_bass",
      caught_at: 1736683800000,
      lat: 36.314,
      lng: -83.928,
      photo_key: null,
      length_mm: 430,
      weight_g: 1800,
      depth_m: null,
      released: 1,
      notes: null,
      client_id: "seed_clt_001",
      enrich_status: "pending",
      created_at: 1736683800000,
      updated_at: 1736683800000,
      deleted_at: null
    };
    expect(catchSchema.parse(row)).toEqual(row);
  });

  it("parses a conditions row", () => {
    const row = {
      id: "cond_001",
      user_id: "usr_demo",
      catch_id: "catch_001",
      trip_id: null,
      hour_bucket: null,
      air_temp_c: 18.5,
      cloud_pct: 40,
      wind_kph: 9,
      precip_mm: 0,
      pressure_hpa: 1015,
      pressure_trend: "stable",
      moon_phase: 0.5,
      minutes_from_sunrise: 45,
      water_temp_c: 14.2,
      discharge_cms: null,
      season: "winter",
      source_meta: null,
      created_at: 1736683800000
    };
    expect(conditionsSchema.parse(row)).toEqual(row);
  });

  it("parses a pattern_cache row", () => {
    const row = {
      id: "pat_001",
      user_id: "usr_demo",
      scope: "all",
      dimension: "moon_phase",
      bucket: "new_moon",
      catches: 4,
      hours: 12.5,
      rate: 0.32,
      baseline_rate: 0.2,
      multiplier: 1.6,
      confidence: "promising",
      computed_at: 1736695800000
    };
    expect(patternCacheRowSchema.parse(row)).toEqual(row);
  });
});
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter schema typecheck && pnpm --filter schema lint && pnpm --filter schema test`
Expected: all green, 7 passing round-trip tests.

- [ ] **Step 4: Commit**

```bash
git add packages/schema
git commit -m "feat: add Zod schemas mirroring the D1 tables"
```

---

## Task 10: Seed Data

**Files:**
- Create: `migrations/seed/seed.sql`

**Interfaces:**
- Consumes: the table shapes from Task 8's migration.
- Produces: fixture data that Epic 3 (stats) and Epic 4 (pattern engine) sanity-check against — critically, one zero-catch ("skunk") trip, since the skunk trip is the denominator concept the whole product depends on.

- [ ] **Step 1: Create `migrations/seed/seed.sql`**

```sql
-- Seed data for local development. Applied via `wrangler d1 execute`, NOT a
-- numbered migration — this must never run against production.

INSERT INTO users (id, email, display_name, home_lat, home_lng, units, tier, stripe_customer_id, created_at, updated_at, deleted_at)
VALUES ('usr_demo', 'demo@waterlog.app', 'Demo Angler', 36.1627, -86.7816, 'imperial', 'free', NULL, 1735689600000, 1735689600000, NULL);

INSERT INTO water_bodies (id, user_id, name, kind, centroid_lat, centroid_lng, usgs_gauge_id, is_home, created_at, updated_at, deleted_at)
VALUES
  ('wb_norris_lake', 'usr_demo', 'Norris Lake', 'lake', 36.3134, -83.9291, NULL, 1, 1735689600000, 1735689600000, NULL),
  ('wb_caney_fork', 'usr_demo', 'Caney Fork River', 'river', 35.9503, -85.5202, '03415000', 0, 1735689600000, 1735689600000, NULL);

INSERT INTO lures (id, user_id, name, family, color, cost_cents, retired_at, created_at, updated_at, deleted_at)
VALUES
  ('lure_spinnerbait_chartreuse', 'usr_demo', 'War Eagle Spinnerbait', 'spinnerbait', 'chartreuse', 799, NULL, 1735689600000, 1735689600000, NULL),
  ('lure_crankbait_shad', 'usr_demo', 'Bandit Crankbait', 'crankbait', 'shad', 599, NULL, 1735689600000, 1735689600000, NULL),
  ('lure_softplastic_watermelon', 'usr_demo', 'Zoom Trick Worm', 'soft_plastic', 'watermelon', 399, NULL, 1735689600000, 1735689600000, NULL),
  ('lure_jig_black_blue', 'usr_demo', 'Strike King Jig', 'jig', 'black_blue', NULL, NULL, 1735689600000, 1735689600000, NULL);

-- trip_norris_1: 3.5h completed trip. trip_caney_1: 5h completed trip.
-- trip_norris_skunk: completed trip with zero catches (the skunk).
INSERT INTO trips (id, user_id, water_body_id, started_at, ended_at, auto_created, planned, notes, created_at, updated_at, deleted_at)
VALUES
  ('trip_norris_1', 'usr_demo', 'wb_norris_lake', 1736683200000, 1736695800000, 0, 1, 'Morning trip, topwater bite early.', 1736683200000, 1736695800000, NULL),
  ('trip_caney_1', 'usr_demo', 'wb_caney_fork', 1737288000000, 1737306000000, 0, 1, 'Afternoon float trip.', 1737288000000, 1737306000000, NULL),
  ('trip_norris_skunk', 'usr_demo', 'wb_norris_lake', 1737892800000, 1737905400000, 0, 1, 'Cold front moved through, tough day.', 1737892800000, 1737905400000, NULL);

-- 7 catches on trip_norris_1 (lake), 5 on trip_caney_1 (river) = 12 total.
-- trip_norris_skunk intentionally has none.
INSERT INTO catches (id, user_id, trip_id, lure_id, species, caught_at, lat, lng, photo_key, length_mm, weight_g, depth_m, released, notes, client_id, enrich_status, created_at, updated_at, deleted_at)
VALUES
  ('catch_001', 'usr_demo', 'trip_norris_1', 'lure_spinnerbait_chartreuse', 'largemouth_bass', 1736683800000, 36.3140, -83.9280, NULL, 430, 1800, NULL, 1, NULL, 'seed_clt_001', 'pending', 1736683800000, 1736683800000, NULL),
  ('catch_002', 'usr_demo', 'trip_norris_1', 'lure_softplastic_watermelon', 'bluegill', 1736685600000, 36.3125, -83.9305, NULL, 180, 250, NULL, 1, NULL, 'seed_clt_002', 'pending', 1736685600000, 1736685600000, NULL),
  ('catch_003', 'usr_demo', 'trip_norris_1', 'lure_jig_black_blue', 'spotted_bass', 1736687400000, 36.3150, -83.9260, NULL, 350, 900, NULL, 1, NULL, 'seed_clt_003', 'pending', 1736687400000, 1736687400000, NULL),
  ('catch_004', 'usr_demo', 'trip_norris_1', 'lure_crankbait_shad', 'largemouth_bass', 1736689200000, 36.3132, -83.9295, NULL, 510, 2600, NULL, 0, NULL, 'seed_clt_004', 'pending', 1736689200000, 1736689200000, NULL),
  ('catch_005', 'usr_demo', 'trip_norris_1', 'lure_softplastic_watermelon', 'crappie', 1736691000000, 36.3118, -83.9310, NULL, 250, 350, NULL, 1, NULL, 'seed_clt_005', 'pending', 1736691000000, 1736691000000, NULL),
  ('catch_006', 'usr_demo', 'trip_norris_1', 'lure_spinnerbait_chartreuse', 'largemouth_bass', 1736692800000, 36.3145, -83.9270, NULL, 390, 1500, NULL, 1, NULL, 'seed_clt_006', 'pending', 1736692800000, 1736692800000, NULL),
  ('catch_007', 'usr_demo', 'trip_norris_1', 'lure_jig_black_blue', 'spotted_bass', 1736694600000, 36.3128, -83.9288, NULL, 320, 750, NULL, 1, NULL, 'seed_clt_007', 'pending', 1736694600000, 1736694600000, NULL),
  ('catch_008', 'usr_demo', 'trip_caney_1', 'lure_crankbait_shad', 'smallmouth_bass', 1737288900000, 35.9510, -85.5195, NULL, 380, 1100, NULL, 1, NULL, 'seed_clt_008', 'pending', 1737288900000, 1737288900000, NULL),
  ('catch_009', 'usr_demo', 'trip_caney_1', 'lure_softplastic_watermelon', 'rainbow_trout', 1737292500000, 35.9498, -85.5210, NULL, 300, 500, NULL, 1, NULL, 'seed_clt_009', 'pending', 1737292500000, 1737292500000, NULL),
  ('catch_010', 'usr_demo', 'trip_caney_1', 'lure_jig_black_blue', 'smallmouth_bass', 1737296100000, 35.9505, -85.5188, NULL, 410, 1300, NULL, 0, NULL, 'seed_clt_010', 'pending', 1737296100000, 1737296100000, NULL),
  ('catch_011', 'usr_demo', 'trip_caney_1', 'lure_spinnerbait_chartreuse', 'walleye', 1737299700000, 35.9515, -85.5220, NULL, 460, 1700, NULL, 1, NULL, 'seed_clt_011', 'pending', 1737299700000, 1737299700000, NULL),
  ('catch_012', 'usr_demo', 'trip_caney_1', 'lure_crankbait_shad', 'rainbow_trout', 1737303300000, 35.9490, -85.5200, NULL, 280, 420, NULL, 1, NULL, 'seed_clt_012', 'pending', 1737303300000, 1737303300000, NULL);
```

- [ ] **Step 2: Apply and verify locally**

Run (from `workers/api/`, after `pnpm db:migrate` from Task 8):
```bash
pnpm seed
wrangler d1 execute waterlog-db --local --command "SELECT count(*) AS n FROM catches"
wrangler d1 execute waterlog-db --local --command "SELECT count(*) AS n FROM trips"
wrangler d1 execute waterlog-db --local --command "SELECT count(*) AS n FROM trips t WHERE NOT EXISTS (SELECT 1 FROM catches c WHERE c.trip_id = t.id)"
```
Expected: `catches` count = 12, `trips` count = 3, zero-catch-trip count = 1.

- [ ] **Step 3: Commit**

```bash
git add migrations/seed/seed.sql
git commit -m "feat: add local dev seed data with a skunk trip"
```

---

## Task 11: Migration 0002 (Sessions and Login Tokens)

**Files:**
- Create: `migrations/0002_sessions_and_login_tokens.sql`

**Interfaces:**
- Produces: `sessions` and `login_tokens` tables that Task 12's session/magic-link libraries read and write.

- [ ] **Step 1: Create `migrations/0002_sessions_and_login_tokens.sql`**

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the token; raw token only in the cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_tokens (         -- magic link tokens, single-use
  id TEXT PRIMARY KEY,              -- sha256 of token
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- 10 minutes
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Apply and verify locally**

Run (from `workers/api/`): `pnpm db:migrate`
Expected: `0002_sessions_and_login_tokens.sql` applies cleanly on top of `0001` without touching it.

- [ ] **Step 3: Commit**

```bash
git add migrations/0002_sessions_and_login_tokens.sql
git commit -m "feat: add sessions and login_tokens migration"
```

---

## Task 12: Session, Crypto, Mailer, and User-Lookup Libraries

**Files:**
- Create: `workers/api/src/lib/crypto.ts`
- Create: `workers/api/src/lib/crypto.test.ts`
- Create: `workers/api/src/lib/sessions.ts`
- Create: `workers/api/src/lib/mailer.ts`
- Create: `workers/api/src/lib/users.ts`

**Interfaces:**
- Consumes: `Env.DB` (`D1Database`, from Task 4's `env.ts`), the `sessions` table (Task 11).
- Produces: `generateToken(byteLength?: number): string`, `hashToken(token: string): Promise<string>` — used by both session and magic-link code so raw tokens are never stored, only their SHA-256 hash.
- Produces: `createSession(db: D1Database, userId: string): Promise<string>` (returns the raw token to set as a cookie), `resolveSession(db: D1Database, token: string): Promise<SessionUser | null>`, `destroySession(db: D1Database, token: string): Promise<void>`, plus the constants `SESSION_COOKIE_NAME = "wl_session"` and `SESSION_DURATION_MS`.
- Produces: `Mailer` interface (`sendMagicLink(email: string, url: string): Promise<void>`) and `ConsoleMailer` (dev implementation that logs the link).
- Produces: `ensureUserByEmail(db: D1Database, email: string): Promise<AppUser>` — create-or-link by email, used by both the magic-link and Google OAuth routes (Tasks 13-14) so a user is never duplicated across sign-in methods.

- [ ] **Step 1: Create `workers/api/src/lib/crypto.ts`**

```ts
export function generateToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(new Uint8Array(digest));
}

function bufferToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 2: Create `workers/api/src/lib/crypto.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./crypto";

describe("crypto helpers", () => {
  it("generates tokens of the requested byte length as hex", () => {
    const token = generateToken(32);
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates distinct tokens on each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("hashes a token deterministically", async () => {
    const token = "fixed-test-token";
    const hashA = await hashToken(token);
    const hashB = await hashToken(token);
    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it("produces different hashes for different tokens", async () => {
    const hashA = await hashToken("token-a");
    const hashB = await hashToken("token-b");
    expect(hashA).not.toBe(hashB);
  });
});
```

- [ ] **Step 3: Create `workers/api/src/lib/sessions.ts`**

```ts
import { generateToken, hashToken } from "./crypto";

export const SESSION_COOKIE_NAME = "wl_session";
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  id: string;
  email: string;
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = generateToken();
  const id = await hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;

  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, expiresAt, now)
    .run();

  return token;
}

export async function resolveSession(db: D1Database, token: string): Promise<SessionUser | null> {
  const id = await hashToken(token);
  const now = Date.now();

  const row = await db
    .prepare(
      `SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ?`
    )
    .bind(id)
    .first<{ id: string; email: string; expires_at: number }>();

  if (!row || row.expires_at < now) {
    return null;
  }

  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .bind(now + SESSION_DURATION_MS, id)
    .run();

  return { id: row.id, email: row.email };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const id = await hashToken(token);
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}
```

- [ ] **Step 4: Create `workers/api/src/lib/mailer.ts`**

```ts
export interface Mailer {
  sendMagicLink(email: string, url: string): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  async sendMagicLink(email: string, url: string): Promise<void> {
    console.log(`[mailer] magic link for ${email}: ${url}`);
  }
}
```

- [ ] **Step 5: Create `workers/api/src/lib/users.ts`**

```ts
export interface AppUser {
  id: string;
  email: string;
}

export async function ensureUserByEmail(db: D1Database, email: string): Promise<AppUser> {
  const existing = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email)
    .first<AppUser>();

  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, home_lat, home_lng, units, tier, stripe_customer_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, NULL, 'imperial', 'free', NULL, ?, ?, NULL)`
    )
    .bind(id, email, now, now)
    .run();

  return { id, email };
}
```

- [ ] **Step 6: Verify (crypto tests only — sessions/mailer/users need the D1-backed pool wired in Task 15)**

Run: `pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test`
Expected: all green (typecheck confirms `sessions.ts`/`users.ts` compile against `D1Database` types even though they aren't exercised by a test yet).

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/lib
git commit -m "feat: add session, crypto, mailer, and user-lookup libraries"
```

---

## Task 13: Magic Link Routes

**Files:**
- Create: `workers/api/src/routes/auth-magic-link.ts`

**Interfaces:**
- Consumes: `generateToken`/`hashToken` (Task 12 `crypto.ts`), `createSession`/`SESSION_COOKIE_NAME`/`SESSION_DURATION_MS` (Task 12 `sessions.ts`), `ConsoleMailer` (Task 12 `mailer.ts`), `ensureUserByEmail` (Task 12 `users.ts`), `Env` (Task 4 `env.ts`).
- Produces: `magicLinkRoutes` (a `Hono<{ Bindings: Env }>` instance) with `POST /api/auth/magic-link/request` and `GET /api/auth/magic-link/verify`, mounted onto the main app in Task 15.

- [ ] **Step 1: Create `workers/api/src/routes/auth-magic-link.ts`**

```ts
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Env } from "../env";
import { generateToken, hashToken } from "../lib/crypto";
import { ConsoleMailer } from "../lib/mailer";
import { createSession, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../lib/sessions";
import { ensureUserByEmail } from "../lib/users";

const LOGIN_TOKEN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export const magicLinkRoutes = new Hono<{ Bindings: Env }>();

magicLinkRoutes.post("/api/auth/magic-link/request", async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email_required" }, 400);
  }

  const token = generateToken();
  const id = await hashToken(token);
  const now = Date.now();

  await c.env.DB.prepare(
    "INSERT INTO login_tokens (id, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)"
  )
    .bind(id, email, now + LOGIN_TOKEN_DURATION_MS, now)
    .run();

  const requestUrl = new URL(c.req.url);
  const magicLinkUrl = `${requestUrl.origin}/api/auth/magic-link/verify?token=${token}`;

  const mailer = new ConsoleMailer();
  await mailer.sendMagicLink(email, magicLinkUrl);

  return c.json({ ok: true });
});

magicLinkRoutes.get("/api/auth/magic-link/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ error: "token_required" }, 400);
  }

  const id = await hashToken(token);
  const now = Date.now();

  const row = await c.env.DB.prepare("SELECT email, expires_at, consumed_at FROM login_tokens WHERE id = ?")
    .bind(id)
    .first<{ email: string; expires_at: number; consumed_at: number | null }>();

  if (!row || row.consumed_at !== null || row.expires_at < now) {
    return c.json({ error: "invalid_token" }, 401);
  }

  await c.env.DB.prepare("UPDATE login_tokens SET consumed_at = ? WHERE id = ?").bind(now, id).run();

  const user = await ensureUserByEmail(c.env.DB, row.email);
  const sessionToken = await createSession(c.env.DB, user.id);

  setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000
  });

  return c.json({ ok: true, userId: user.id });
});
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: compiles clean (route-level behavior is exercised end-to-end by Task 15's test suite, once the D1-backed test pool exists).

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/auth-magic-link.ts
git commit -m "feat: add magic link request/verify routes"
```

---

## Task 14: Google OAuth Routes

**Files:**
- Create: `workers/api/src/routes/auth-google.ts`

**Interfaces:**
- Consumes: `createSession`/`SESSION_COOKIE_NAME`/`SESSION_DURATION_MS` (Task 12 `sessions.ts`), `ensureUserByEmail` (Task 12 `users.ts`), `Env` (Task 4 `env.ts`, including `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).
- Produces: `googleAuthRoutes` (a `Hono<{ Bindings: Env }>` instance) with `GET /api/auth/google/start` and `GET /api/auth/google/callback`, mounted onto the main app in Task 15.

- [ ] **Step 1: Create `workers/api/src/routes/auth-google.ts`**

```ts
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Env } from "../env";
import { createSession, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../lib/sessions";
import { ensureUserByEmail } from "../lib/users";

export const googleAuthRoutes = new Hono<{ Bindings: Env }>();

googleAuthRoutes.get("/api/auth/google/start", (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: c.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline"
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

googleAuthRoutes.get("/api/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.json({ error: "missing_code" }, 400);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: c.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });

  if (!tokenResponse.ok) {
    return c.json({ error: "token_exchange_failed" }, 401);
  }

  const tokenBody = await tokenResponse.json<{ access_token: string }>();

  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` }
  });

  if (!userInfoResponse.ok) {
    return c.json({ error: "userinfo_failed" }, 401);
  }

  const userInfo = await userInfoResponse.json<{ email: string }>();
  const user = await ensureUserByEmail(c.env.DB, userInfo.email.toLowerCase());
  const sessionToken = await createSession(c.env.DB, user.id);

  setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000
  });

  return c.redirect("/");
});
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: compiles clean (exercised end-to-end by Task 15's test suite with `fetch` mocked).

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/auth-google.ts
git commit -m "feat: add Google OAuth start/callback routes"
```

---

## Task 15: `requireAuth` Middleware, Wire-Up, and Full Auth Test Suite

**Files:**
- Create: `workers/api/src/middleware/require-auth.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/vitest.config.ts` (switch from plain node env to `@cloudflare/vitest-pool-workers` so tests get a real local D1 binding)
- Modify: `workers/api/package.json` (add `@cloudflare/vitest-pool-workers` devDependency)
- Modify: `workers/api/tsconfig.json` (add `@cloudflare/vitest-pool-workers` ambient types)
- Create: `workers/api/test/apply-migrations.ts`
- Delete: `workers/api/src/index.test.ts` (superseded by `workers/api/test/auth.test.ts`, which also covers `/api/health`)
- Create: `workers/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `resolveSession` (Task 12 `sessions.ts`), `SESSION_COOKIE_NAME` (Task 12 `sessions.ts`), `magicLinkRoutes` (Task 13), `googleAuthRoutes` (Task 14).
- Produces: `requireAuth` middleware (`MiddlewareHandler<{ Bindings: Env; Variables: AuthedVariables }>`) and `AuthedVariables = { user: SessionUser }`, applied to `GET /api/me`.

- [ ] **Step 1: Create `workers/api/src/middleware/require-auth.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { resolveSession, SESSION_COOKIE_NAME, type SessionUser } from "../lib/sessions";

export type AuthedVariables = { user: SessionUser };

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthedVariables }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const user = await resolveSession(c.env.DB, token);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", user);
  await next();
};
```

- [ ] **Step 2: Replace `workers/api/src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./env";
import type { AuthedVariables } from "./middleware/require-auth";
import { requireAuth } from "./middleware/require-auth";
import { googleAuthRoutes } from "./routes/auth-google";
import { magicLinkRoutes } from "./routes/auth-magic-link";

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

const VERSION = "0.0.0";

app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));

app.route("/", magicLinkRoutes);
app.route("/", googleAuthRoutes);

app.get("/api/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, email: user.email });
});

export default app;
```

- [ ] **Step 3: Delete the now-superseded `workers/api/src/index.test.ts`**

Its one assertion (`/api/health` returns `{ ok: true }`) is re-covered by `workers/api/test/auth.test.ts` in Step 7, which also gets real D1 bindings.

- [ ] **Step 4: Add `@cloudflare/vitest-pool-workers` to `workers/api/package.json` devDependencies**

```json
"@cloudflare/vitest-pool-workers": "^0.5.19"
```
(Add alongside the existing `@cloudflare/workers-types`, `typescript`, `vitest`, `wrangler` entries from Task 4 — don't remove those.)

- [ ] **Step 5: Replace `workers/api/vitest.config.ts` to use the Workers pool**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"]
        }
      }
    }
  }
});
```

- [ ] **Step 6: Add `@cloudflare/vitest-pool-workers` to `workers/api/tsconfig.json` types**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 7: Create `workers/api/test/apply-migrations.ts`**

D1's JS `.exec()` API rejects SQL with inline comments, but our migration files use them — so this strips `--` line comments and runs each statement individually via `.prepare().run()` instead.

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_FILES = ["0001_initial_schema.sql", "0002_sessions_and_login_tokens.sql"];

export async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const raw = readFileSync(resolve(__dirname, "../../../migrations", file), "utf-8");
    const withoutComments = raw
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const statements = withoutComments
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}
```

- [ ] **Step 8: Create `workers/api/test/auth.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { applyMigrations } from "./apply-migrations";

describe("api worker", () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it("GET /api/health returns ok and a version", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; version: string }>();
    expect(body.ok).toBe(true);
  });

  it("GET /api/me returns 401 with no session cookie", async () => {
    const res = await app.request("/api/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("completes the magic-link flow, protects /api/me, and rejects a replayed token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const requestRes = await app.request(
      "/api/auth/magic-link/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "angler@example.com" })
      },
      env
    );
    expect(requestRes.status).toBe(200);

    const loggedLine = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes("magic link"));
    expect(loggedLine).toBeDefined();
    const magicLinkUrl = loggedLine!.split("magic link for angler@example.com: ")[1]!.trim();
    const token = new URL(magicLinkUrl).searchParams.get("token");
    expect(token).toBeTruthy();
    logSpy.mockRestore();

    const verifyRes = await app.request(`/api/auth/magic-link/verify?token=${token}`, {}, env);
    expect(verifyRes.status).toBe(200);
    const cookie = verifyRes.headers.get("set-cookie");
    expect(cookie).toContain("wl_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const sessionCookie = cookie!.split(";")[0]!;

    const meRes = await app.request("/api/me", { headers: { Cookie: sessionCookie } }, env);
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json<{ email: string }>();
    expect(meBody.email).toBe("angler@example.com");

    const replayRes = await app.request(`/api/auth/magic-link/verify?token=${token}`, {}, env);
    expect(replayRes.status).toBe(401);
  });

  it("completes the Google OAuth flow and creates-or-links a user by email", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
      }
      if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
        return new Response(JSON.stringify({ email: "googleuser@example.com" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const res = await app.request("/api/auth/google/callback?code=fake-code", {}, env);
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("wl_session=");

    const user = await env.DB.prepare("SELECT email FROM users WHERE email = ?")
      .bind("googleuser@example.com")
      .first<{ email: string }>();
    expect(user?.email).toBe("googleuser@example.com");

    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 9: Install and verify**

Run: `pnpm install && pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test`
Expected: all green — `/api/health` returns ok, `/api/me` 401s with no cookie, magic-link flow issues a session and 401s on replay, Google OAuth flow creates-or-links a user and issues a session, cookie has `HttpOnly; Secure; SameSite=Lax`.

- [ ] **Step 10: Full-repo verify**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter web build`
Expected: everything from Tasks 1-15 still green together (this is the same sequence CI runs).

- [ ] **Step 11: Commit**

```bash
git add workers/api
git commit -m "feat: add requireAuth middleware and wire up protected /api/me"
```

---

## Definition of Done

All three task-group acceptance checklists from the spec (T0.1, T0.2, T0.3) pass, `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter web build` is green on `main`, the repo has been pushed to GitHub and a Cloudflare Pages preview URL is live on a PR (manual dashboard step, see `docs/deploy-setup.md`), and `docs/adr/` contains an ADR for any deviation made along the way (none are anticipated by this plan — package names were chosen unscoped specifically to avoid needing one). Only then does Epic 1 begin.
