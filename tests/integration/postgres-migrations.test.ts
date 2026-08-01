import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  SubscriberCapacityError,
  alertDeliveries,
  claimMailJobs,
  confirmSubscriber,
  deleteSubscriber,
  getDistinctWatchedClassKeys,
  mailOutbox,
  makeRepo,
  subscribers,
  sweepRetention,
  tryAcquireWorkerAdvisoryLease,
  watches,
  type Db,
} from '../../src/db';
import * as schema from '../../src/db/schema';
import type { ClassKey } from '../../src/shared/class-key';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const realPostgresIt = testDatabaseUrl ? it : it.skip;
const { Pool } = pg;

interface IsolatedPostgres {
  db: Db;
  connectionString: string;
  migrateFrom(folder: string): Promise<void>;
  close(): Promise<void>;
}

async function isolatedPostgres(): Promise<IsolatedPostgres> {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required');
  const databaseName = `seat_sniper_it_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: testDatabaseUrl });
  await admin.query(`create database "${databaseName}"`);
  const isolatedUrl = new URL(testDatabaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const connectionString = isolatedUrl.toString();
  const pool = new Pool({
    connectionString,
  });
  const nodeDb = drizzlePg(pool, { schema });
  const db: Db = nodeDb;
  return {
    db,
    connectionString,
    async migrateFrom(folder: string) {
      await migrate(nodeDb, {
        migrationsFolder: folder,
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations',
      });
    },
    async close() {
      await pool.end();
      await admin.query(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    },
  };
}

function migrationPrefixThrough0008(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seat-sniper-old-migrations-'));
  const metadata = join(directory, 'meta');
  mkdirSync(metadata);
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 8);
  writeFileSync(join(metadata, '_journal.json'), JSON.stringify({ ...journal, entries }), 'utf8');
  for (const entry of entries) {
    cpSync(join(process.cwd(), 'drizzle', `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  return directory;
}

async function verifyCurrentRepo(db: Db, suffix: string): Promise<void> {
  const repo = makeRepo(db);
  const created = await repo.createSubscriber(`migration-${suffix}@berkeley.edu`, [
    '2026-fall-compsci-189-001-lec-001' as ClassKey,
  ]);
  expect(await confirmSubscriber(db, created.id)).toBe('confirmed');
  const jobs = await claimMailJobs(db);
  const job = jobs.find(
    (candidate) => candidate.kind === 'confirmation' && candidate.subscriberId === created.id,
  );
  expect(job).toMatchObject({
    kind: 'confirmation',
    subscriberId: created.id,
    email: `migration-${suffix}@berkeley.edu`,
    attempts: 1,
  });
}

describe('real PostgreSQL migrations (optional)', () => {
  realPostgresIt(
    'applies the complete migration history to a fresh isolated database',
    async () => {
      const target = await isolatedPostgres();
      try {
        await target.migrateFrom('./drizzle');
        await verifyCurrentRepo(target.db, 'fresh');
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  realPostgresIt(
    'upgrades a database at migration 0008 through the current v0.4 migration',
    async () => {
      const target = await isolatedPostgres();
      const oldMigrations = migrationPrefixThrough0008();
      try {
        await target.migrateFrom(oldMigrations);
        const subscriberId = 'legacy-upgrade-subscriber';
        const classKey = '2026-fall-compsci-189-001-lec-001';
        await target.db.execute(sql`
          insert into subscribers (id, email, created_at, confirmed_at)
          values (
            ${subscriberId},
            ${'legacy-upgrade@berkeley.edu'},
            clock_timestamp() - interval '30 minutes',
            clock_timestamp() - interval '29 minutes'
          )
        `);
        await target.db.execute(sql`
          insert into watches (
            id,
            subscriber_id,
            class_key,
            created_at,
            retired_at,
            activated_at
          )
          values (
            ${'legacy-upgrade-watch'},
            ${subscriberId},
            ${classKey},
            clock_timestamp() - interval '28 minutes',
            null,
            clock_timestamp() - interval '28 minutes'
          )
        `);
        await target.db.execute(sql`
          insert into alert_deliveries (
            subscriber_id,
            class_key,
            opened_at,
            reason,
            open_seats,
            sent_at,
            created_at,
            cancelled_at,
            attempt_count,
            next_attempt_at,
            watch_activation_order
          )
          select
            ${subscriberId},
            ${classKey},
            clock_timestamp() - interval '10 minutes',
            'seats-open',
            2,
            null,
            clock_timestamp() - interval '9 minutes',
            null,
            1,
            clock_timestamp(),
            activation_order
          from watches
          where id = ${'legacy-upgrade-watch'}
        `);

        await target.migrateFrom('./drizzle');
        const legacyRows = await target.db.select().from(alertDeliveries);
        const transferredRows = await target.db.select().from(mailOutbox);
        expect(legacyRows).toHaveLength(1);
        expect(transferredRows).toHaveLength(1);
        const [legacy] = legacyRows;
        const [transferred] = transferredRows;
        expect(transferred).toMatchObject({
          kind: 'alert',
          subscriberId,
          classKey,
          reason: 'seats-open',
          status: 'queued',
          attempts: 1,
          payload: { openSeats: 2 },
        });
        expect(transferred?.providerIdempotencyKey).toBe(legacy?.providerIdempotencyKey);
        expect(transferred?.openedAt?.getTime()).toBe(legacy?.openedAt.getTime());
        expect(legacy).toMatchObject({
          sentAt: null,
          cancelledAt: null,
        });
        expect(legacy?.deadLetteredAt).toBeInstanceOf(Date);
        expect(legacy?.terminalAt).toBeInstanceOf(Date);

        await verifyCurrentRepo(target.db, 'upgrade');
      } finally {
        rmSync(oldMigrations, { recursive: true, force: true });
        await target.close();
      }
    },
    120_000,
  );

  realPostgresIt(
    'serializes concurrent confirmations without exceeding unique-Section capacity',
    async () => {
      const target = await isolatedPostgres();
      try {
        await target.migrateFrom('./drizzle');
        const repo = makeRepo(target.db, { maxUniqueSections: 1 });
        const first = await repo.createSubscriber('capacity-race-a@berkeley.edu', [
          '2026-fall-compsci-189-001-lec-001' as ClassKey,
        ]);
        const second = await repo.createSubscriber('capacity-race-b@berkeley.edu', [
          '2026-fall-compsci-61a-001-lec-001' as ClassKey,
        ]);

        expect(await getDistinctWatchedClassKeys(target.db)).toEqual([]);
        const results = await Promise.all([
          repo.confirmSubscriber(first.id),
          repo.confirmSubscriber(second.id),
        ]);
        expect(results.sort()).toEqual(['capacity_exceeded', 'confirmed']);
        expect(await getDistinctWatchedClassKeys(target.db)).toHaveLength(1);
        const persisted = await target.db.select().from(watches);
        expect(persisted.filter((watch) => watch.activatedAt !== null)).toHaveLength(1);
        expect(persisted.filter((watch) => watch.activatedAt === null)).toHaveLength(1);
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  realPostgresIt(
    'atomically caps the pilot at 100 current Pending + Confirmed subscribers and releases slots',
    async () => {
      const target = await isolatedPostgres();
      try {
        await target.migrateFrom('./drizzle');
        const repo = makeRepo(target.db, {
          maxUniqueSections: 96,
          maxSubscribers: 100,
        });
        const classKey = '2026-fall-compsci-189-001-lec-001' as ClassKey;
        const attempts = await Promise.allSettled(
          Array.from({ length: 101 }, (_, index) =>
            repo.createSubscriber(`pilot-cap-${index}@berkeley.edu`, [classKey]),
          ),
        );
        const admitted = attempts.filter(
          (
            result,
          ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repo.createSubscriber>>> =>
            result.status === 'fulfilled',
        );
        const rejected = attempts.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );

        expect(admitted).toHaveLength(100);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(SubscriberCapacityError);
        expect(await target.db.select().from(subscribers)).toHaveLength(100);

        // Confirmation does not release a slot: both Pending and Confirmed count.
        expect(await confirmSubscriber(target.db, admitted[0]!.value.id)).toBe('confirmed');
        await expect(
          repo.createSubscriber('pilot-still-full@berkeley.edu', [classKey]),
        ).rejects.toBeInstanceOf(SubscriberCapacityError);

        // Unsubscribe releases one slot.
        await deleteSubscriber(target.db, admitted[0]!.value.id);
        await expect(
          repo.createSubscriber('pilot-after-delete@berkeley.edu', [classKey]),
        ).resolves.toBeDefined();
        expect(await target.db.select().from(subscribers)).toHaveLength(100);

        // The 72-hour Pending purge also releases one slot.
        const pendingId = admitted[1]!.value.id;
        await target.db
          .update(subscribers)
          .set({ createdAt: new Date(Date.now() - 73 * 60 * 60_000) })
          .where(eq(subscribers.id, pendingId));
        const swept = await sweepRetention(target.db, new Date());
        expect(swept.pendingSubscribers).toBe(1);
        expect(
          await target.db.select().from(subscribers).where(eq(subscribers.id, pendingId)),
        ).toHaveLength(0);
        await expect(
          repo.createSubscriber('pilot-after-purge@berkeley.edu', [classKey]),
        ).resolves.toBeDefined();
        expect(await target.db.select().from(subscribers)).toHaveLength(100);
      } finally {
        await target.close();
      }
    },
    180_000,
  );

  realPostgresIt(
    'allows exactly one advisory-lease owner and fails over after release or session loss',
    async () => {
      const target = await isolatedPostgres();
      const originalDatabaseUrl = process.env.DATABASE_URL;
      let first: Awaited<ReturnType<typeof tryAcquireWorkerAdvisoryLease>> | undefined;
      let successor: Awaited<ReturnType<typeof tryAcquireWorkerAdvisoryLease>> | undefined;
      let failover: Awaited<ReturnType<typeof tryAcquireWorkerAdvisoryLease>> | undefined;
      try {
        process.env.DATABASE_URL = target.connectionString;
        first = await tryAcquireWorkerAdvisoryLease();
        expect(first).toBeDefined();
        expect(await tryAcquireWorkerAdvisoryLease()).toBeUndefined();
        await expect(first!.heartbeat()).resolves.toBe(true);

        await first!.release();
        successor = await tryAcquireWorkerAdvisoryLease();
        expect(successor).toBeDefined();

        await target.db.execute(sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = current_database()
            and application_name = 'berkeley-seat-sniper-worker-lease'
            and pid <> pg_backend_pid()
        `);
        await expect(successor!.heartbeat()).resolves.toBe(false);

        failover = await tryAcquireWorkerAdvisoryLease();
        expect(failover).toBeDefined();
        await expect(failover!.heartbeat()).resolves.toBe(true);
      } finally {
        await failover?.release();
        await successor?.release();
        await first?.release();
        if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDatabaseUrl;
        await target.close();
      }
    },
    120_000,
  );
});
