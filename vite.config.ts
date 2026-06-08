import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev/build config for the dashboard (src/client + src/components). The Hono API
// runs separately on PORT (default 8787); in dev we proxy /api to it so the
// browser only talks to Vite. Production serves the built assets behind Caddy.
const API_PORT = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
