/**
 * Standalone migration runner. Called by `npm run db:migrate` at server start
 * or manually. Uses the DATABASE_URL environment variable; if absent, falls
 * back to PGlite (useful in dev/test without a real Postgres).
 *
 * Secrets come only from the environment (constitution — never hard-coded).
 */
import { closeDb, getDb, runMigrations } from './client';

try {
  process.loadEnvFile();
} catch {
  // No local .env — use the deployment environment as-is.
}

try {
  const db = getDb();
  await runMigrations(db);
  console.log('migrations applied');
} finally {
  // A one-shot migration must not leave the module-level Pool holding the
  // process open. `finally` also closes it when a migration fails.
  await closeDb();
}
