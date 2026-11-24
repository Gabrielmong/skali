import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const SERVER = 'http://127.0.0.1:4200'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // No changeOrigin: the server accepts the browser's own Host/Origin (localhost:5173) and rejects a mismatched pair.
    proxy: {
      '/api': { target: SERVER },
      '/ws': { target: SERVER, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
