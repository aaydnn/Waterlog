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
})
