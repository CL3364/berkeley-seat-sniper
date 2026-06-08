import { PGlite } from '@electric-sql/pglite';
import { is } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

/**
 * Driver-agnostic DB type. Defined explicitly as a union of the two concrete
 * driver types so repo functions and getDb() have a non-circular annotation.
 * Both NodePgDatabase and PgliteDatabase expose the same Drizzle query API
 * (select/insert/update/delete/transaction), so repo functions that accept
 * `Db` compile against both drivers.
 */
export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

/** Module-level singleton for production/dev use. Tests use makeTestDb() instead. */
let _db: Db | undefined;

/**
 * Return the shared DB instance, creating it on first call. Subsequent calls
 * return the SAME instance — the migrated db and the repo share one connection.
 *
 * Driver selection (no docker required for dev/tests):
 *   - DATABASE_URL set → real Postgres via node-postgres Pool
 *   - DATABASE_URL absent → in-process PGlite (zero external services)
 *
 * Secrets come only from the environment (constitution). Never hard-code
 * connection strings or credentials.
 */
export function getDb(): Db {
  if (_db) return _db;

  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzlePg(pool, { schema });
  } else {
    // In-process Postgres — used in dev and tests without a real PG instance.
    const pglite = new PGlite();
    _db = drizzlePglite(pglite, { schema });
  }

  return _db;
}

/**
 * Apply all pending migrations to the given DB instance. Safe to call on every
 * boot — Drizzle's migrator is idempotent (it tracks applied migrations in
 * `__drizzle_migrations` and skips already-applied ones).
 *
 * Intended call site: `await runMigrations(getDb())` in the server bootstrap,
 * BEFORE any request handler runs or any repo function is invoked.
 *
 * Migrator selection is based on the actual db instance type (via drizzle's
 * `is()` helper) rather than env-var presence. This is robust when, e.g., a
 * test passes a PgliteDatabase while DATABASE_URL happens to be set.
 *
 * CWD assumption: `migrationsFolder` is resolved relative to `process.cwd()`.
 * The server must be started from the project root (the directory that contains
 * `drizzle/`) — i.e. `node dist/server/index.js` or `tsx src/server/index.ts`
 * from the repo root. Docker / CI must set the working directory accordingly.
 *
 * Also called by makeTestDb() and src/db/migrate.ts.
 */
export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = './drizzle';

  // Discriminate on the actual db instance, not on DATABASE_URL, so that
  // makeTestDb() (which always creates a PgliteDatabase) works correctly even
  // when DATABASE_URL is set in the environment.
  if (is(db, PgliteDatabase)) {
    await migratePglite(db, { migrationsFolder });
  } else {
    // NodePgDatabase — safe cast: the only other Db variant is NodePgDatabase
    await migrate(db as NodePgDatabase<typeof schema>, { migrationsFolder });
  }
}

/**
 * Create a FRESH in-process PGlite database and apply migrations.
 * Each call returns a fully isolated DB — no shared state between tests.
 *
 * Usage in tests:
 *   const db = await makeTestDb();
 *   // pass db to any repo function
 *
 * The DB is ephemeral: it lives only in memory for the life of the process.
 * No docker, no external services required.
 */
export async function makeTestDb(): Promise<PgliteDatabase<typeof schema>> {
  const pglite = new PGlite();
  const db = drizzlePglite(pglite, { schema });
  // Re-use runMigrations so the test path exercises the same code as production.
  await runMigrations(db);
  return db;
}
