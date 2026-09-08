import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// base stays '/' — root-relative asset paths for Cloudflare Pages.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Caching strategy stays minimal in Epic 0: precache the app shell only.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Workbox routes every *navigation* to the cached index.html so deep links work
        // offline. Without this denylist that also swallows /api/* navigations — which broke
        // sign-in outright: visiting /api/auth/google rendered the app shell instead of
        // redirecting to Google, and the OAuth callback was hijacked the same way, so a
        // session could never be created. Those paths must reach the Pages Function proxy.
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'WaterLog',
        short_name: 'WaterLog',
        description: 'Personal fishing analytics',
        theme_color: '#0b1d2a',
        background_color: '#0b1d2a',
        display: 'standalone',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
  },
  // Mirrors the Pages Function that proxies /api/* in production, so the client can use the
  // same relative, same-origin paths in dev. Start the API with `pnpm dev` in workers/api.
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
})
