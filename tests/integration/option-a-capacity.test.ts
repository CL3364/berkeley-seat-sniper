import { describe, expect, it } from 'vitest';

import {
  getDistinctWatchedClassKeys,
  getSubscriberByEmail,
  makeTestDb,
  watches,
} from '../../src/db';
import { makeServerRepo, readSourceCapacityConfig } from '../../src/server/repo';
import type { ClassKey } from '../../src/shared/class-key';

const HEADROOM_RATIO = 0.8;

function classKey(index: number): ClassKey {
  const identifier = String(index).padStart(3, '0');
  return `2026-fall-compsci-189-${identifier}-lec-${identifier}` as ClassKey;
}

describe('Option A unique-Section capacity boundary', () => {
  it('admits 96 distinct Sections, atomically rejects the 97th, and shares an existing slot', async () => {
    const capacity = readSourceCapacityConfig({});
    expect(capacity).toEqual({
      requestsPerSecond: 1,
      visibleTargetSeconds: 120,
      maxUniqueSections: 96,
    });
    expect(
      Math.floor(HEADROOM_RATIO * capacity.requestsPerSecond * capacity.visibleTargetSeconds),
    ).toBe(capacity.maxUniqueSections);

    const db = await makeTestDb();
    const repo = makeServerRepo(db, { maxUniqueSections: capacity.maxUniqueSections });
    const admittedKeys = Array.from({ length: capacity.maxUniqueSections }, (_, index) =>
      classKey(index + 1),
    );

    const subscribersNeeded = capacity.maxUniqueSections / 4;
    expect(Number.isInteger(subscribersNeeded)).toBe(true);
    for (let index = 0; index < subscribersNeeded; index += 1) {
      const created = await repo.createSubscriber(
        `option-a-${index}@berkeley.edu`,
        admittedKeys.slice(index * 4, index * 4 + 4),
      );
      await expect(repo.confirmSubscriber(created.id)).resolves.toBe('confirmed');
    }
    expect(await repo.countDistinctLiveClassKeys()).toBe(capacity.maxUniqueSections);

    const rejectedEmail = 'option-a-rejected@berkeley.edu';
    const rejectedKey = classKey(capacity.maxUniqueSections + 1);
    const rejected = await repo.createSubscriber(rejectedEmail, [admittedKeys[0]!, rejectedKey]);

    await expect(repo.confirmSubscriber(rejected.id)).resolves.toBe('capacity_exceeded');

    const rejectedSubscriber = await getSubscriberByEmail(db, rejectedEmail);
    const rejectedWatches = (await db.select().from(watches)).filter(
      (watch) => watch.subscriberId === rejected.id,
    );
    expect(rejectedSubscriber?.confirmedAt).toBeNull();
    expect(rejectedWatches).toHaveLength(2);
    expect(
      rejectedWatches.every(
        (watch) => watch.activatedAt === null && watch.activationOrder === null,
      ),
    ).toBe(true);
    expect(await getDistinctWatchedClassKeys(db)).not.toContain(rejectedKey);
    expect(await repo.countDistinctLiveClassKeys()).toBe(capacity.maxUniqueSections);

    const shared = await repo.createSubscriber('option-a-shared@berkeley.edu', [admittedKeys[0]!]);
    await expect(repo.confirmSubscriber(shared.id)).resolves.toBe('confirmed');

    const sharedWatch = (await db.select().from(watches)).find(
      (watch) => watch.subscriberId === shared.id,
    );
    expect(sharedWatch?.activatedAt).toBeInstanceOf(Date);
    expect(sharedWatch?.activationOrder).not.toBeNull();
    expect(await repo.countDistinctLiveClassKeys()).toBe(capacity.maxUniqueSections);
  });
});
