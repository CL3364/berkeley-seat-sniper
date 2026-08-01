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

const { Client, Pool } = pg;

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
let _runtimePool: InstanceType<typeof Pool> | undefined;
let _runtimePglite: PGlite | undefined;
let _runtimePgConfig:
  | {
      databaseUrl: string;
      connectionTimeoutMillis: number;
      lockTimeoutMillis: number;
      migrationTimeoutMillis: number;
    }
  | undefined;

function readPositiveTimeout(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

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

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const mailTransport = process.env.MAIL_TRANSPORT?.trim() || 'noop';
  if (!databaseUrl && (process.env.NODE_ENV === 'production' || mailTransport !== 'noop')) {
    throw new Error(
      'DATABASE_URL is required in production or when MAIL_TRANSPORT is non-noop; ' +
        'the PGlite fallback is process-local and cannot be shared by the API and worker.',
    );
  }

  if (databaseUrl) {
    const connectionTimeoutMillis = readPositiveTimeout('DB_CONNECT_TIMEOUT_MS', 5_000);
    const queryTimeoutMillis = readPositiveTimeout('DB_QUERY_TIMEOUT_MS', 20_000);
    const lockTimeoutMillis = readPositiveTimeout('DB_LOCK_TIMEOUT_MS', 5_000);
    const migrationTimeoutMillis = readPositiveTimeout('DB_MIGRATION_TIMEOUT_MS', 600_000);
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis,
      query_timeout: queryTimeoutMillis,
      statement_timeout: queryTimeoutMillis,
      lock_timeout: lockTimeoutMillis,
      idle_in_transaction_session_timeout: queryTimeoutMillis,
      application_name: 'berkeley-seat-sniper',
    });
    _runtimePool = pool;
    _db = drizzlePg(pool, { schema });
    _runtimePgConfig = {
      databaseUrl,
      connectionTimeoutMillis,
      lockTimeoutMillis,
      migrationTimeoutMillis,
    };
  } else {
    // In-process Postgres — used in dev and tests without a real PG instance.
    const pglite = new PGlite();
    _runtimePglite = pglite;
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
  } else if (db === _db && _runtimePgConfig) {
    // Runtime queries have a deliberately tight deadline, but schema upgrades
    // can legitimately scan/rewrite a retained table. Run migrations on a
    // dedicated pool with their own finite budget so DB_QUERY_TIMEOUT_MS cannot
    // create a permanent boot loop on a healthy, growing database.
    const migrationPool = new Pool({
      connectionString: _runtimePgConfig.databaseUrl,
      connectionTimeoutMillis: _runtimePgConfig.connectionTimeoutMillis,
      query_timeout: _runtimePgConfig.migrationTimeoutMillis,
      statement_timeout: _runtimePgConfig.migrationTimeoutMillis,
      lock_timeout: _runtimePgConfig.lockTimeoutMillis,
      idle_in_transaction_session_timeout: _runtimePgConfig.migrationTimeoutMillis,
      application_name: 'berkeley-seat-sniper-migrations',
    });
    try {
      await migrate(drizzlePg(migrationPool, { schema }), { migrationsFolder });
    } finally {
      await migrationPool.end();
    }
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

/** Close the module-level node-postgres pool (used by one-shot processes). */
export async function closeDb(): Promise<void> {
  const pool = _runtimePool;
  const pglite = _runtimePglite;
  _runtimePool = undefined;
  _runtimePglite = undefined;
  _runtimePgConfig = undefined;
  _db = undefined;
  if (pool) await pool.end();
  if (pglite) await pglite.close();
}

const WORKER_ADVISORY_LOCK_NAMESPACE = 0x53454154; // "SEAT"
const WORKER_ADVISORY_LOCK_KEY = 0x534e4950; // "SNIP"

export interface WorkerAdvisoryLease {
  /**
   * Probe the dedicated session. False means the session (and therefore its
   * automatically released advisory lock) was lost.
   */
  heartbeat(): Promise<boolean>;
  /** Idempotently unlock and close the dedicated connection. */
  release(): Promise<void>;
}

/**
 * Acquire the production worker's session-level advisory lease.
 *
 * A dedicated node-postgres Client is essential: a pooled query could acquire
 * the session lock on one connection and try to release it on another. Losing
 * this connection releases the lock inside PostgreSQL, enabling clean failover.
 */
export async function tryAcquireWorkerAdvisoryLease(): Promise<WorkerAdvisoryLease | undefined> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the worker advisory lease');
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: readPositiveTimeout('DB_CONNECT_TIMEOUT_MS', 5_000),
    query_timeout: readPositiveTimeout('DB_QUERY_TIMEOUT_MS', 20_000),
    statement_timeout: readPositiveTimeout('DB_QUERY_TIMEOUT_MS', 20_000),
    application_name: 'berkeley-seat-sniper-worker-lease',
  });
  let connectionLost = false;
  let released = false;
  client.on('error', () => {
    connectionLost = true;
  });

  try {
    await client.connect();
    const result = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1::integer, $2::integer) as acquired',
      [WORKER_ADVISORY_LOCK_NAMESPACE, WORKER_ADVISORY_LOCK_KEY],
    );
    if (result.rows[0]?.acquired !== true) {
      released = true;
      await client.end();
      return undefined;
    }
  } catch (error) {
    released = true;
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    async heartbeat() {
      if (released || connectionLost) return false;
      try {
        await client.query('select 1');
        return !connectionLost;
      } catch {
        connectionLost = true;
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!connectionLost) {
          await client.query('select pg_advisory_unlock($1::integer, $2::integer)', [
            WORKER_ADVISORY_LOCK_NAMESPACE,
            WORKER_ADVISORY_LOCK_KEY,
          ]);
        }
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
