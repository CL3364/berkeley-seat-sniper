/**
 * Standalone migration runner. Called by `npm run db:migrate` at server start
 * or manually. Uses the DATABASE_URL environment variable; if absent, falls
 * back to PGlite (useful in dev/test without a real Postgres).
 *
 * Secrets come only from the environment (constitution — never hard-coded).
 */
import { getDb, runMigrations } from './client';

const db = getDb();
await runMigrations(db);
console.log('migrations applied');
