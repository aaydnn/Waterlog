import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build output goes to dist/ (Cloudflare Pages default).
// base: '/' keeps asset paths root-relative for Pages.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
