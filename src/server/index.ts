/**
 * Production server entrypoint.
 *
 * Production migrations are a separate one-shot release step (`db:migrate`);
 * the API never races another process to mutate schema at startup. Local
 * process-owned PGlite may be initialized only through the explicit
 * `AUTO_MIGRATE_DEV=1` switch.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { apiError } from '../shared/errors';

// Tests/E2E set SKIP_ENV_FILE=1 so a developer's local configuration cannot
// redirect an isolated run to production-like dependencies.
if (process.env.SKIP_ENV_FILE !== '1') {
  try {
    process.loadEnvFile();
  } catch {
    // Deployed environments inject variables; a missing local .env is normal.
  }
}

function readPort(): number {
  const raw = process.env.PORT?.trim() || '8787';
  if (!/^\d+$/.test(raw)) throw new Error('PORT must be an integer from 1 to 65535');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return value;
}

function hasUnsafeEncodedPath(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return /\\|%00|%2f|%5c/i.test(path);
}

async function bootstrap(): Promise<void> {
  const [
    dbModule,
    notifyModule,
    appModule,
    admissionModule,
    repoModule,
    readinessModule,
    rateLimitModule,
  ] = await Promise.all([
    import('../db'),
    import('../notify'),
    import('./app'),
    import('./admission'),
    import('./repo'),
    import('./worker-readiness'),
    import('./rate-limit'),
  ]);
  const { closeDb, getDb, runMigrations } = dbModule;
  const { createNotifier } = notifyModule;
  const { createApp } = appModule;
  const { readAdmissionPolicy, subscriberLimitForAdmission } = admissionModule;
  const { makeServerRepo, readSourceCapacityConfig } = repoModule;
  const { workerPushIsOperational } = readinessModule;
  const { connectRedisRateLimiter, defaultRateLimiter } = rateLimitModule;
  const admissionPolicy = readAdmissionPolicy();

  // Construction performs fail-loud mail/provider/base-URL validation. The
  // resulting notifier is deliberately discarded: v0.4 API routes enqueue
  // durable work, and the worker is the only dispatcher.
  void createNotifier({ push: null });

  const db = getDb();
  const autoMigrateDev = process.env.AUTO_MIGRATE_DEV === '1';
  if (autoMigrateDev && process.env.NODE_ENV === 'production') {
    throw new Error('AUTO_MIGRATE_DEV=1 is forbidden in production; run db:migrate once');
  }
  if (autoMigrateDev) {
    await runMigrations(db);
    console.log({ event: 'development_migrations_applied' });
  }

  const redisUrl = process.env.REDIS_URL?.trim();
  const redisHandle = redisUrl ? await connectRedisRateLimiter(redisUrl) : undefined;
  // Throws in production when no connected Redis dependency was supplied.
  const rateLimiter = redisHandle?.limiter ?? defaultRateLimiter();

  const sourceCapacity = readSourceCapacityConfig();
  const api = createApp(
    makeServerRepo(db, {
      maxUniqueSections: sourceCapacity.maxUniqueSections,
      maxSubscribers: subscriberLimitForAdmission(admissionPolicy),
    }),
    undefined,
    {
      admissionPolicy,
      rateLimiter,
      capacityRetryAfterSeconds: sourceCapacity.visibleTargetSeconds,
      isPushOperational: workerPushIsOperational,
    },
  );

  const app = new Hono();
  app.route('/', api);
  app.all('/api/*', (c) => c.json(apiError('not_found', 'route not found'), 404));

  // Defense in depth around static lookup. @hono/node-server 2.0.11 already
  // rejects encoded traversal; rejecting separators/NUL before file resolution
  // keeps that invariant explicit if adapters change later.
  app.use('/*', async (c, next) => {
    if (hasUnsafeEncodedPath(c.req.raw)) {
      return c.text('Bad Request', 400);
    }
    await next();
  });
  app.use('/*', serveStatic({ root: './dist/web' }));
  app.get('/*', serveStatic({ path: './dist/web/index.html' }));

  const server = serve({ fetch: app.fetch, port: readPort() }, (info) => {
    console.log({
      event: 'server_started',
      port: info.port,
      uniqueSectionCapacity: sourceCapacity.maxUniqueSections,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log({ event: 'server_shutdown_started', signal });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await redisHandle?.close();
    await closeDb();
    console.log({ event: 'server_shutdown_complete' });
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
}

bootstrap().catch((error: unknown) => {
  console.error({
    event: 'bootstrap_failed',
    errorName: error instanceof Error ? error.constructor.name : 'unknown',
  });
  process.exit(1);
});
