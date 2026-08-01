/**
 * Same-process E2E backend harness.
 *
 * Local browser tests must never inherit a developer DATABASE_URL/REDIS_URL.
 * With those values explicitly blanked by playwright.config.ts, this process
 * owns one ephemeral PGlite database. Keeping the real API and durable outbox
 * drain in this process lets them share that database without adding a test
 * backdoor or leaking emailed tokens through an API response.
 *
 * CI deliberately supplies job-scoped PostgreSQL and Redis URLs instead. The
 * same harness consumes them with SKIP_ENV_FILE=1 and applies migrations
 * idempotently before it binds the port.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { closeDb, getDb, runMigrations } from '../src/db';
import { createMailDispatcher } from '../src/notify';
import { createApp } from '../src/server/app';
import { connectRedisRateLimiter, defaultRateLimiter } from '../src/server/rate-limit';
import { makeServerRepo, readSourceCapacityConfig } from '../src/server/repo';
import { createWorkerRepo, drainMailOutboxOnce } from '../src/worker/public';

const HOSTNAME = '127.0.0.1';
const DRAIN_INTERVAL_MS = 20;

function readPort(): number {
  const value = Number(process.env.PORT ?? '8787');
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.SKIP_ENV_FILE !== '1') {
    throw new Error('the E2E server requires NODE_ENV=test and SKIP_ENV_FILE=1');
  }

  const db = getDb();
  await runMigrations(db);

  const redisUrl = process.env.REDIS_URL?.trim();
  const redisHandle = redisUrl ? await connectRedisRateLimiter(redisUrl) : undefined;
  const capacity = readSourceCapacityConfig();
  const api = createApp(
    makeServerRepo(db, { maxUniqueSections: capacity.maxUniqueSections }),
    undefined,
    {
      rateLimiter: redisHandle?.limiter ?? defaultRateLimiter(),
      capacityRetryAfterSeconds: capacity.visibleTargetSeconds,
      isPushOperational: () => false,
    },
  );

  const app = new Hono();
  app.route('/', api);

  const workerRepo = createWorkerRepo(db);
  const dispatcher = createMailDispatcher({ push: null });
  let activeDrain: Promise<void> | undefined;
  let drainFailure: unknown;
  const drainTimer = setInterval(() => {
    if (activeDrain || drainFailure) return;
    activeDrain = drainMailOutboxOnce({
      repo: workerRepo,
      dispatcher,
      batchSize: 100,
      claimLeaseSeconds: 5,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        drainFailure = error;
        console.error({
          event: 'e2e_outbox_drain_failed',
          errorName: error instanceof Error ? error.constructor.name : 'unknown',
        });
      })
      .finally(() => {
        activeDrain = undefined;
      });
  }, DRAIN_INTERVAL_MS);

  const server = serve({
    fetch: app.fetch,
    hostname: HOSTNAME,
    port: readPort(),
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(drainTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await activeDrain;
    await redisHandle?.close();
    await closeDb();
  }

  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(drainFailure ? 1 : 0));
  });
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(drainFailure ? 1 : 0));
  });
}

main().catch((error: unknown) => {
  console.error({
    event: 'e2e_server_failed',
    errorName: error instanceof Error ? error.constructor.name : 'unknown',
  });
  process.exit(1);
});
