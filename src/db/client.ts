import { PGlite } from '@electric-sql/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
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
 * Return the shared DB instance, creating it on first call.
 *
 * Driver selection (no docker required for tests):
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
 * Apply all pending migrations to the given DB instance.
 *
 * For real Postgres: uses drizzle-orm/node-postgres/migrator.
 * For PGlite: uses drizzle-orm/pglite/migrator.
 *
 * Called by src/db/migrate.ts at server start, and by makeTestDb() in tests.
 * The migrations folder is always `./drizzle` (relative to the project root).
 */
export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = './drizzle';

  // Discriminate by DATABASE_URL presence so the correct migrator is used.
  // makeTestDb() always passes a PgliteDatabase and does not set DATABASE_URL.
  if (process.env.DATABASE_URL) {
    await migrate(db as NodePgDatabase<typeof schema>, { migrationsFolder });
  } else {
    await migratePglite(db as PgliteDatabase<typeof schema>, { migrationsFolder });
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
  await migratePglite(db, { migrationsFolder: './drizzle' });
  return db;
}
