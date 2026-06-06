import { defineConfig, devices } from '@playwright/test';

// End-to-end tests drive a REAL browser against the running app (single Node
// process serving the built SPA + /api). The webServer block builds the SPA and
// boots the server with a test TOKEN_SECRET and an in-process PGlite DB (no
// DATABASE_URL), so `npx playwright test` is self-contained.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:8787/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      TOKEN_SECRET: 'e2e-token-secret-at-least-32-characters-long',
      PORT: '8787',
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'noop',
      // The E2E suite makes many subscribes from one IP; raise the per-IP rate
      // limit so journey tests aren't throttled. The 429 path is covered by unit
      // tests + manual verification, not these browser journeys. (Limiter stays
      // active — just effectively un-throttled.)
      RATE_LIMIT_SUBSCRIBE_MAX: '100000',
    },
  },
});
