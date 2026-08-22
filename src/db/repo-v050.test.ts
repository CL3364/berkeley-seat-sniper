import { describe, expect, it } from 'vitest';

import type { ClassKey } from '../shared/class-key';
import { MAX_OBSERVED_COUNT } from '../shared/seat-state';
import {
  addWatchWithFreshness,
  claimAlertDelivery,
  claimOpeningDeliveries,
  commitOpeningAndEnqueueMail,
  confirmSubscriber,
  createSubscriberWithWatches,
  getClassState,
  listWatches,
  makeRepo,
  makeTestDb,
  retireWatchesForClass,
  upsertClassState,
  WatchLimitError,
} from './index';
import { alertDeliveries, classState, mailOutbox, subscribers, watches } from './schema';

const CLASS_KEYS = [
  '2026-fall-compsci-189-001-lec-001' as ClassKey,
  '2026-fall-compsci-61a-001-lec-001' as ClassKey,
  '2026-fall-math-110-001-lec-001' as ClassKey,
  '2026-fall-data-100-001-lec-001' as ClassKey,
  '2026-fall-stat-134-001-lec-001' as ClassKey,
] as const;

describe('v0.5 watch-cap repository invariants', () => {
  it('rejects a five-watch create inside the transaction before any durable write', async () => {
    const db = await makeTestDb();

    await expect(
      createSubscriberWithWatches(db, 'v050-create-cap@berkeley.edu', [...CLASS_KEYS]),
    ).rejects.toBeInstanceOf(WatchLimitError);

    expect(await db.select().from(subscribers)).toHaveLength(0);
    expect(await db.select().from(watches)).toHaveLength(0);
    expect(await db.select().from(mailOutbox)).toHaveLength(0);
  });

  it('caps Pending subscribers, preserves duplicate precedence, and treats retirement as a slot', async () => {
    const db = await makeTestDb();
    const created = await createSubscriberWithWatches(
      db,
      'v050-pending-cap@berkeley.edu',
      CLASS_KEYS.slice(0, 4),
    );

    await expect(
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[0]),
    ).rejects.toMatchObject({ name: 'DuplicateWatchError' });
    await expect(
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[4]),
    ).rejects.toBeInstanceOf(WatchLimitError);

    expect(await retireWatchesForClass(db, CLASS_KEYS[0])).toBe(1);
    expect(await addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[4])).toHaveLength(4);
    await expect(
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[0]),
    ).rejects.toBeInstanceOf(WatchLimitError);
  });

  it('reports the personal cap before unique-Section capacity for Confirmed subscribers', async () => {
    const db = await makeTestDb();
    const created = await createSubscriberWithWatches(
      db,
      'v050-confirmed-cap@berkeley.edu',
      CLASS_KEYS.slice(0, 4),
    );
    expect(
      await confirmSubscriber(db, created.subscriberId, {
        maxUniqueSections: 4,
      }),
    ).toBe('confirmed');

    await expect(
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[4], {
        maxUniqueSections: 4,
      }),
    ).rejects.toBeInstanceOf(WatchLimitError);
  });

  it('serializes concurrent additions competing for the final live slot', async () => {
    const db = await makeTestDb();
    const created = await createSubscriberWithWatches(
      db,
      'v050-concurrent-cap@berkeley.edu',
      CLASS_KEYS.slice(0, 3),
    );
    expect(
      await confirmSubscriber(db, created.subscriberId, {
        maxUniqueSections: 10,
      }),
    ).toBe('confirmed');

    const results = await Promise.allSettled([
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[3], {
        maxUniqueSections: 10,
      }),
      addWatchWithFreshness(db, created.subscriberId, CLASS_KEYS[4], {
        maxUniqueSections: 10,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status !== 'rejected') throw new Error('expected one rejected add');
    expect(rejected.reason).toBeInstanceOf(WatchLimitError);
    expect(await listWatches(db, created.subscriberId)).toHaveLength(4);
  });
});

describe('v0.5 persisted-count repository boundaries', () => {
  it('persists the inclusive int4 maximum through class state and alert delivery', async () => {
    const db = await makeTestDb();
    const created = await createSubscriberWithWatches(db, 'v050-max-observed-count@berkeley.edu', [
      CLASS_KEYS[0],
    ]);
    expect(await confirmSubscriber(db, created.subscriberId)).toBe('confirmed');
    await upsertClassState(db, {
      classKey: CLASS_KEYS[0],
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
    });

    const deliveries = await claimOpeningDeliveries(db, {
      classKey: CLASS_KEYS[0],
      previousStateVersion: 0,
      openedAt: new Date().toISOString(),
      reason: 'seats-open',
      openSeats: MAX_OBSERVED_COUNT,
      nextState: {
        lastStatus: 'open',
        lastOpenSeats: MAX_OBSERVED_COUNT,
        lastWaitlistOpen: false,
        displayName: null,
        lastEnrolled: MAX_OBSERVED_COUNT,
        lastCapacity: MAX_OBSERVED_COUNT,
        lastWaitlisted: MAX_OBSERVED_COUNT,
        lastWaitlistMax: MAX_OBSERVED_COUNT,
        lastOpenReserved: MAX_OBSERVED_COUNT,
      },
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.openSeats).toBe(MAX_OBSERVED_COUNT);
    expect(deliveries[0]?.openReserved).toBe(MAX_OBSERVED_COUNT);
    expect(
      await db
        .select({
          openSeats: alertDeliveries.openSeats,
          openReserved: alertDeliveries.openReserved,
        })
        .from(alertDeliveries),
    ).toEqual([{ openSeats: MAX_OBSERVED_COUNT, openReserved: MAX_OBSERVED_COUNT }]);
    expect(await getClassState(db, CLASS_KEYS[0])).toMatchObject({
      lastOpenSeats: MAX_OBSERVED_COUNT,
      lastEnrolled: MAX_OBSERVED_COUNT,
      lastCapacity: MAX_OBSERVED_COUNT,
      lastWaitlisted: MAX_OBSERVED_COUNT,
      lastWaitlistMax: MAX_OBSERVED_COUNT,
      lastOpenReserved: MAX_OBSERVED_COUNT,
    });
  });

  it.each([
    'lastOpenSeats',
    'lastEnrolled',
    'lastCapacity',
    'lastWaitlisted',
    'lastWaitlistMax',
    'lastOpenReserved',
  ] as const)('rejects an over-int4 %s before class-state persistence', async (field) => {
    const db = await makeTestDb();
    const state = {
      classKey: CLASS_KEYS[0],
      lastStatus: 'closed' as const,
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
      [field]: MAX_OBSERVED_COUNT + 1,
    };

    await expect(upsertClassState(db, state)).rejects.toThrow(
      `${field} must be a non-negative integer no greater than ${MAX_OBSERVED_COUNT}`,
    );
    expect(await getClassState(db, CLASS_KEYS[0])).toBeUndefined();
  });

  it('rejects a reserved observation above open seats at both repository and SQL boundaries', async () => {
    const db = await makeTestDb();
    const invalidState = {
      classKey: CLASS_KEYS[0],
      lastStatus: 'open' as const,
      lastOpenSeats: 2,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: 3,
    };
    const expected = 'lastOpenReserved must be no greater than lastOpenSeats';

    await expect(upsertClassState(db, invalidState)).rejects.toThrow(expected);
    const opening = {
      classKey: CLASS_KEYS[0],
      previousStateVersion: 0,
      openedAt: new Date().toISOString(),
      reason: 'seats-open' as const,
      openSeats: 2,
      nextState: invalidState,
    };
    await expect(claimOpeningDeliveries(db, opening)).rejects.toThrow(expected);
    await expect(commitOpeningAndEnqueueMail(db, opening)).rejects.toThrow(expected);
    expect(await getClassState(db, CLASS_KEYS[0])).toBeUndefined();

    await expect(
      db.insert(classState).values({
        classKey: CLASS_KEYS[0],
        lastStatus: 'open',
        lastOpenSeats: 2,
        lastWaitlistOpen: false,
        lastOpenReserved: 3,
      }),
    ).rejects.toThrow();
    expect(await getClassState(db, CLASS_KEYS[0])).toBeUndefined();
  });

  it('rejects an over-int4 alert count on all three durable-opening entry points', async () => {
    const db = await makeTestDb();
    const openedAt = new Date().toISOString();
    const overBound = MAX_OBSERVED_COUNT + 1;
    const opening = {
      classKey: CLASS_KEYS[0],
      previousStateVersion: 0,
      openedAt,
      reason: 'seats-open' as const,
      openSeats: overBound,
      nextState: {
        lastStatus: 'open' as const,
        lastOpenSeats: 0,
        lastWaitlistOpen: false,
        displayName: null,
        lastEnrolled: null,
        lastCapacity: null,
        lastWaitlisted: null,
        lastWaitlistMax: null,
        lastOpenReserved: null,
      },
    };
    const expected = `openSeats must be a non-negative integer no greater than ${MAX_OBSERVED_COUNT}`;

    await expect(
      claimAlertDelivery(db, {
        subscriberId: 'missing-subscriber',
        classKey: CLASS_KEYS[0],
        openedAt,
        reason: 'seats-open',
        openSeats: overBound,
        openReserved: null,
      }),
    ).rejects.toThrow(expected);
    await expect(claimOpeningDeliveries(db, opening)).rejects.toThrow(expected);
    await expect(commitOpeningAndEnqueueMail(db, opening)).rejects.toThrow(expected);
  });

  it('rejects an independently over-int4 next-state count on both atomic paths', async () => {
    const db = await makeTestDb();
    const opening = {
      classKey: CLASS_KEYS[0],
      previousStateVersion: 0,
      openedAt: new Date().toISOString(),
      reason: 'seats-open' as const,
      openSeats: 0,
      nextState: {
        lastStatus: 'open' as const,
        lastOpenSeats: MAX_OBSERVED_COUNT + 1,
        lastWaitlistOpen: false,
        displayName: null,
        lastEnrolled: null,
        lastCapacity: null,
        lastWaitlisted: null,
        lastWaitlistMax: null,
        lastOpenReserved: null,
      },
    };
    const expected = `lastOpenSeats must be a non-negative integer no greater than ${MAX_OBSERVED_COUNT}`;

    await expect(claimOpeningDeliveries(db, opening)).rejects.toThrow(expected);
    await expect(commitOpeningAndEnqueueMail(db, opening)).rejects.toThrow(expected);
  });
});

describe('v0.5 dashboard persistence', () => {
  it('emits every required dashboard key as null for a never-observed watch', async () => {
    const db = await makeTestDb();
    const created = await makeRepo(db).createSubscriber('v050-null-row@berkeley.edu', [
      CLASS_KEYS[0],
    ]);

    expect(created.watchFreshness).toEqual([
      {
        classKey: CLASS_KEYS[0],
        source: 'public-class-page',
        lastCheckedAt: null,
        sourceStale: true,
        displayName: null,
        openSeats: null,
        enrolled: null,
        capacity: null,
        waitlisted: null,
        waitlistMax: null,
        openReserved: null,
        waitlistOpen: null,
      },
    ]);
  });

  it('persists observations and explicitly clears optional values on a later upsert', async () => {
    const db = await makeTestDb();
    const repo = makeRepo(db);
    const created = await repo.createSubscriber('v050-clear-row@berkeley.edu', [CLASS_KEYS[0]]);

    await upsertClassState(db, {
      classKey: CLASS_KEYS[0],
      lastStatus: 'open',
      lastOpenSeats: 3,
      lastWaitlistOpen: false,
      displayName: 'COMPSCI 189 001 - LEC 001',
      lastEnrolled: 347,
      lastCapacity: 350,
      lastWaitlisted: 100,
      lastWaitlistMax: 100,
      lastOpenReserved: 2,
      sourceFreshUntil: new Date(Date.now() + 60_000),
    });

    expect((await repo.getSubscriberById(created.id))?.watchFreshness[0]).toMatchObject({
      displayName: 'COMPSCI 189 001 - LEC 001',
      openSeats: 3,
      enrolled: 347,
      capacity: 350,
      waitlisted: 100,
      waitlistMax: 100,
      openReserved: 2,
      waitlistOpen: false,
    });

    await upsertClassState(db, {
      classKey: CLASS_KEYS[0],
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
      sourceFreshUntil: new Date(Date.now() + 60_000),
    });

    expect((await repo.getSubscriberById(created.id))?.watchFreshness[0]).toMatchObject({
      displayName: null,
      openSeats: 0,
      enrolled: null,
      capacity: null,
      waitlisted: null,
      waitlistMax: null,
      openReserved: null,
      waitlistOpen: false,
    });
  });

  it('threads required nullable observations through both atomic opening paths', async () => {
    const db = await makeTestDb();
    await upsertClassState(db, {
      classKey: CLASS_KEYS[0],
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
    });

    expect(
      await claimOpeningDeliveries(db, {
        classKey: CLASS_KEYS[0],
        previousStateVersion: 0,
        openedAt: new Date().toISOString(),
        reason: 'seats-open',
        openSeats: 3,
        nextState: {
          lastStatus: 'open',
          lastOpenSeats: 3,
          lastWaitlistOpen: false,
          displayName: 'COMPSCI 189 001 - LEC 001',
          lastEnrolled: 347,
          lastCapacity: 350,
          lastWaitlisted: 100,
          lastWaitlistMax: 100,
          lastOpenReserved: 3,
        },
      }),
    ).toEqual([]);
    expect(await getClassState(db, CLASS_KEYS[0])).toMatchObject({
      stateVersion: 1,
      displayName: 'COMPSCI 189 001 - LEC 001',
      lastEnrolled: 347,
      lastCapacity: 350,
      lastWaitlisted: 100,
      lastWaitlistMax: 100,
      lastOpenReserved: 3,
    });

    expect(
      await commitOpeningAndEnqueueMail(db, {
        classKey: CLASS_KEYS[0],
        previousStateVersion: 1,
        openedAt: new Date().toISOString(),
        reason: 'seats-open',
        openSeats: 4,
        nextState: {
          lastStatus: 'open',
          lastOpenSeats: 4,
          lastWaitlistOpen: true,
          displayName: 'COMPSCI 189 001 - LEC 001',
          lastEnrolled: 346,
          lastCapacity: 350,
          lastWaitlisted: 39,
          lastWaitlistMax: 40,
          lastOpenReserved: 1,
        },
      }),
    ).toEqual({ transitioned: true, enqueued: 0 });
    expect(await getClassState(db, CLASS_KEYS[0])).toMatchObject({
      stateVersion: 2,
      lastOpenSeats: 4,
      lastWaitlistOpen: true,
      displayName: 'COMPSCI 189 001 - LEC 001',
      lastEnrolled: 346,
      lastCapacity: 350,
      lastWaitlisted: 39,
      lastWaitlistMax: 40,
      lastOpenReserved: 1,
    });
  });
});
