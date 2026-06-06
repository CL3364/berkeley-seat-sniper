/**
 * Server entry point. Runs DB migrations, mounts the Hono app via
 * @hono/node-server on PORT, and serves the built SPA from dist/web/.
 *
 * Boot order:
 *   1. getDb()          — construct the DB driver (PGlite or real Postgres)
 *   2. runMigrations()  — apply pending drizzle migrations (CRITICAL: tables
 *                         must exist before any request is served)
 *   3. createApp(repo)  — build the Hono API handler (pure, no side-effects)
 *   4. static serving   — serve dist/web/ assets + SPA fallback for non-/api/
 *                         GET requests (client-side routing)
 *   5. serve()          — bind the port
 *
 * For tests: import createApp from './app' and pass a mock SubscriptionRepo
 * directly — do NOT import this file, which would bind a live DB and port.
 *
 * For the SPA: API routes take priority (registered first). Any unmatched
 * /api/* path returns a JSON 404 envelope — never index.html. Non-/api/ GETs
 * that do not match a static asset fall back to dist/web/index.html so deep
 * links like /?token=... work correctly with client-side routing.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getDb, makeRepo, runMigrations } from '../db';
import { createApp } from './app';
import { apiError } from '../shared/errors';

const PORT = parseInt(process.env.PORT ?? '8787', 10);

async function bootstrap(): Promise<void> {
  // Step 1+2: acquire a single DB instance and run migrations before serving.
  // Fail loudly — if migrations throw, the process exits with a non-zero code
  // rather than silently serving an empty DB and 500ing on every request.
  const db = getDb();
  await runMigrations(db);
  console.log({ event: 'migrations_applied' });

  // Step 3: the API Hono app, pure — no port binding, no FS access.
  // makeRepo closes over db and bridges the (db, ...) signatures to
  // the SubscriptionRepo interface createApp() expects.
  const api = createApp(makeRepo(db));

  // Step 4: root app that mounts API first, then static assets + SPA fallback.
  // Keeping this in index.ts (not createApp) means unit tests never require
  // a real dist/web/ directory on disk.
  const app = new Hono();

  // 4a. API routes — matched /api/* paths handled here, no fall-through.
  app.route('/', api);

  // 4b. API catch-all: any unmatched /api/* path returns a JSON 404 envelope,
  //     not index.html. Placed AFTER app.route so known routes win.
  app.all('/api/*', (c) => c.json(apiError('not_found', 'route not found'), 404));

  // 4c. Static assets from dist/web/ (JS, CSS, images, etc.).
  //     serveStatic calls next() when no file is found, falling through to 4d.
  app.use(
    '/*',
    serveStatic({
      root: './dist/web',
    }),
  );

  // 4d. SPA fallback: for any non-/api/ GET that didn't match a real file,
  //     serve index.html so client-side routing works (e.g. /?token=...).
  app.get('/*', serveStatic({ path: './dist/web/index.html' }));

  // Step 5: bind the port.
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log({ event: 'server_started', port: info.port });
  });
}

// Top-level await is not available in CommonJS; use .catch to fail loudly.
bootstrap().catch((err: unknown) => {
  console.error({
    event: 'bootstrap_failed',
    errorName: err instanceof Error ? err.constructor.name : 'unknown',
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
