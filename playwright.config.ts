import { defineConfig, devices } from '@playwright/test';

import { defaultE2ePaths } from './e2e/outbox';

const isCi = Boolean(process.env.CI);
const paths = defaultE2ePaths(process.pid);

function requiredCiDependency(name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Playwright in CI`);
  }
  return value;
}

// Keep the browser workers, global setup, and same-process API/dispatcher
// harness on one invocation-specific outbox path.
process.env.E2E_OUTBOX_FILE = paths.outboxFile;

const dependencyEnv = {
  // Local E2E explicitly blanks inherited service URLs: the harness owns one
  // process-local PGlite database and the test-only in-memory limiter. CI is the
  // only mode allowed to consume its job-scoped PostgreSQL/Redis services.
  DATABASE_URL: isCi ? requiredCiDependency('DATABASE_URL') : '',
  REDIS_URL: isCi ? requiredCiDependency('REDIS_URL') : '',
};

const commonEnv = {
  ...dependencyEnv,
  NODE_ENV: 'test',
  SKIP_ENV_FILE: '1',
  // Production defaults fail closed. Legacy browser journeys exercise the
  // ordinary public flow; admission-specific behavior is isolated with route
  // interception in e2e/admission.spec.ts.
  ADMISSION_MODE: 'public',
  TOKEN_SECRET: 'e2e-token-secret-at-least-32-characters-long',
  MAIL_TRANSPORT: 'noop',
  MAIL_PROVIDER: '',
  RESEND_API_KEY: '',
  RESEND_WEBHOOK_SECRET: '',
  NOOP_OUTBOX_FILE: paths.outboxFile,
  APP_BASE_URL: 'http://127.0.0.1:5173',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
  TRUST_PROXY: '0',
  // Browser journeys intentionally exercise many unique subscribers from one
  // loopback address. Atomic limiter behavior has its own real-Redis tests.
  RATE_LIMIT_SUBSCRIBE_MAX: '100000',
  RATE_LIMIT_EMAIL_MAX: '100000',
};

// End-to-end tests drive a real browser against Vite plus a test-only Hono
// harness. The harness composes the production API, migrations, repositories,
// durable mail dispatcher, and worker drain seam in one process. That is what
// makes local PGlite self-contained without weakening the emailed-token wall.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  outputDir: paths.artifactDir,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/server.ts',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...commonEnv,
        PORT: '8787',
      },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...commonEnv,
        PORT: '8787',
      },
    },
  ],
});
