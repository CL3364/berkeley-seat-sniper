/**
 * Server entry point. Mounts the Hono app via @hono/node-server on PORT.
 *
 * This file wires the real db repo to the app by building an adapter that
 * closes over a single Db instance, bridging the db functions' `(db, ...)` call
 * signature to the SubscriptionRepo interface createApp() expects.
 *
 * For tests: import createApp from './app' and pass a mock SubscriptionRepo
 * directly — do NOT import this file, which would bind a live DB and port.
 */

import { serve } from '@hono/node-server';
import { getDb, makeRepo } from '../db';
import { createApp } from './app';

// makeRepo closes over the db instance and bridges the db functions' (db, ...)
// signatures to the SubscriptionRepo interface createApp() expects. The adapter
// lives in src/db/repo-adapter.ts (db's lane) since it knows the repo shapes.
const repo = makeRepo(getDb());

const PORT = parseInt(process.env.PORT ?? '8787', 10);
const app = createApp(repo);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log({ event: 'server_started', port: info.port });
});
