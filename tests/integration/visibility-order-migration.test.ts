import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  confirmSubscriber,
  getPollCycleCutoff,
  makeRepo,
  makeTestDb,
  retireWatchesForClass,
  watches,
} from '../../src/db';
import type { ClassKey } from '../../src/shared/class-key';

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const CK_BASE = '2026-fall-compsci-61a-001-lec-001' as ClassKey;

const PRE_VISIBILITY_ORDER_MIGRATIONS = [
  'drizzle/0000_wakeful_ben_urich.sql',
  'drizzle/0001_bizarre_quasimodo.sql',
  'drizzle/0002_durable_alert_deliveries.sql',
  'drizzle/0003_aromatic_mephistopheles.sql',
  'drizzle/0004_clean_vermin.sql',
  'drizzle/0005_quick_the_santerians.sql',
  'drizzle/0006_cloudy_silver_samurai.sql',
  'drizzle/0007_gray_mystique.sql',
] as const;

describe('monotonic watch visibility order', () => {
  it('backfills a pre-0008 database without attaching stale deliveries to a newer watch', async () => {
    const db = new PGlite();
    try {
      for (const migration of PRE_VISIBILITY_ORDER_MIGRATIONS) {
        await db.exec(readFileSync(migration, 'utf8'));
      }

      await db.query(
        `insert into subscribers (id, email, confirmed_at)
         values ($1, $2, now()), ($3, $4, now())`,
        [
          'subscriber-current',
          'current@berkeley.edu',
          'subscriber-readded',
          'readded@berkeley.edu',
        ],
      );
      await db.query(
        `insert into class_state
           (class_key, last_status, last_open_seats, last_waitlist_open, state_version, updated_at)
         values ($1, 'closed', 0, false, 0, $2)`,
        [CK, '2026-07-21T00:00:02.000Z'],
      );
      await db.query(
        `insert into watches (id, subscriber_id, class_key, activated_at)
         values
           ('watch-current', 'subscriber-current', $1, $2),
           ('watch-readded', 'subscriber-readded', $1, $3)`,
        [CK, '2026-07-21T00:00:01.000Z', '2026-07-21T00:00:03.000Z'],
      );
      await db.query(
        `insert into alert_deliveries
           (subscriber_id, class_key, opened_at, reason, open_seats, created_at)
         values
           ('subscriber-current', $1, $2, 'seats-open', 1, $2),
           ('subscriber-readded', $1, $3, 'seats-open', 1, $3)`,
        [CK, '2026-07-21T00:00:04.000Z', '2026-07-21T00:00:01.000Z'],
      );

      await db.exec(readFileSync('drizzle/0008_empty_darkhawk.sql', 'utf8'));

      const backfilled = await db.query<{
        subscriberId: string;
        activationOrder: number | bigint;
        observedWatchOrder: number | bigint;
        watchActivationOrder: number | bigint;
      }>(
        `select
           w.subscriber_id as "subscriberId",
           w.activation_order as "activationOrder",
           cs.observed_watch_order as "observedWatchOrder",
           ad.watch_activation_order as "watchActivationOrder"
         from watches w
         join class_state cs on cs.class_key = w.class_key
         join alert_deliveries ad
           on ad.subscriber_id = w.subscriber_id and ad.class_key = w.class_key
         order by w.subscriber_id`,
      );

      expect(
        backfilled.rows.map((row) => ({
          subscriberId: row.subscriberId,
          activationOrder: Number(row.activationOrder),
          observedWatchOrder: Number(row.observedWatchOrder),
          watchActivationOrder: Number(row.watchActivationOrder),
        })),
      ).toEqual([
        {
          subscriberId: 'subscriber-current',
          activationOrder: 1,
          observedWatchOrder: 1,
          watchActivationOrder: 1,
        },
        {
          subscriberId: 'subscriber-readded',
          activationOrder: 2,
          observedWatchOrder: 1,
          watchActivationOrder: 0,
        },
      ]);

      const next = await db.query<{ value: string }>(
        `select nextval('watch_visibility_order_seq')::text as value`,
      );
      expect(next.rows[0]?.value).toBe('3');
    } finally {
      await db.close();
    }
  });

  it('never retires a causally later activation even when its wall clock moves backward', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const owner = await api.createSubscriber('visibility-order@berkeley.edu', [CK_BASE]);
    await confirmSubscriber(db, owner.id);

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const cutoff = await getPollCycleCutoff(db);
      await api.addWatch(owner.id, CK);

      // Reproduce the misleading timestamp relation that made the old
      // activated_at <= cutoff predicate retire a causally later watch.
      await db
        .update(watches)
        .set({ activatedAt: new Date('2000-01-01T00:00:00.000Z') })
        .where(and(eq(watches.subscriberId, owner.id), eq(watches.classKey, CK)));

      expect(await retireWatchesForClass(db, CK, cutoff)).toBe(0);
      expect((await api.getSubscriberById(owner.id))?.watches).toContain(CK);
      await api.removeWatch(owner.id, CK);
    }
  });
});
