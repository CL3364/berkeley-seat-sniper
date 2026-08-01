import { describe, expect, it } from 'vitest';

import {
  getDistinctWatchedClassKeys,
  getSubscriberByEmail,
  mailOutbox,
  makeTestDb,
  subscribers,
  watches,
} from '../../src/db';
import { createApp, type SubscriptionRepo } from '../../src/server/app';
import { readAdmissionPolicy } from '../../src/server/admission';
import { MemoryRateLimiter, type RateLimiter } from '../../src/server/rate-limit';
import { makeServerRepo } from '../../src/server/repo';
import { mintToken } from '../../src/server/token';
import type { ClassKey } from '../../src/shared/class-key';

const TOKEN_SECRET = 'server-v04-test-token-secret-at-least-32-characters';
const CK_A = '2026-fall-compsci-189-001-lec-001';
const CK_B = '2026-fall-compsci-61a-001-lec-001';
const PUBLIC_ADMISSION = readAdmissionPolicy({ ADMISSION_MODE: 'public' });

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function runtime(
  rateLimiter: RateLimiter = new MemoryRateLimiter(),
  overrides: Partial<Parameters<typeof createApp>[2]> = {},
): Parameters<typeof createApp>[2] {
  return {
    admissionPolicy: PUBLIC_ADMISSION,
    rateLimiter,
    rateLimitConfig: {
      subscribeMax: 100,
      subscribeWindowSeconds: 60,
      emailMax: 100,
      emailWindowSeconds: 900,
    },
    remoteAddress: () => '127.0.0.1',
    ...overrides,
  };
}

describe('v0.4 capacity admission and durable API enqueue', () => {
  it('stages both creates, then atomically activates only one of two racing unique Sections', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db, { maxUniqueSections: 1 }), undefined, runtime());

    const creates = await Promise.all([
      request(app, 'POST', '/api/subscriptions', {
        email: 'capacity-a@berkeley.edu',
        classKeys: [CK_A],
      }),
      request(app, 'POST', '/api/subscriptions', {
        email: 'capacity-b@berkeley.edu',
        classKeys: [CK_B],
      }),
    ]);

    expect(creates.map((response) => response.status)).toEqual([202, 202]);
    expect(await getDistinctWatchedClassKeys(db)).toEqual([]);
    const staged = await db.select().from(watches);
    expect(staged).toHaveLength(2);
    expect(staged.every((watch) => watch.activatedAt === null)).toBe(true);
    expect(staged.every((watch) => watch.activationOrder === null)).toBe(true);

    const [a, b] = await Promise.all([
      getSubscriberByEmail(db, 'capacity-a@berkeley.edu'),
      getSubscriberByEmail(db, 'capacity-b@berkeley.edu'),
    ]);
    if (!a || !b) throw new Error('expected both staged subscribers');
    const confirmations = await Promise.all([
      request(app, 'POST', `/api/subscriptions/${mintToken(a.id)}/confirm`, {}),
      request(app, 'POST', `/api/subscriptions/${mintToken(b.id)}/confirm`, {}),
    ]);

    expect(confirmations.map((response) => response.status).sort()).toEqual([200, 503]);
    const rejected = confirmations.find((response) => response.status === 503);
    if (!rejected) {
      throw new Error('expected one capacity rejection');
    }
    expect(rejected.headers.get('retry-after')).toBe('120');
    expect(await rejected.json()).toEqual({
      error: {
        code: 'capacity_exceeded',
        message: 'source monitoring capacity is full; please try again later',
      },
    });

    const persistedSubscribers = await db.select().from(subscribers);
    const persistedWatches = await db.select().from(watches);
    expect(persistedSubscribers).toHaveLength(2);
    expect(
      persistedSubscribers.filter((subscriber) => subscriber.confirmedAt !== null),
    ).toHaveLength(1);
    expect(persistedWatches.filter((watch) => watch.activatedAt !== null)).toHaveLength(1);
    expect(persistedWatches.filter((watch) => watch.activationOrder !== null)).toHaveLength(1);
    expect(await getDistinctWatchedClassKeys(db)).toHaveLength(1);
    expect(await db.select().from(mailOutbox)).toHaveLength(2);
  });

  it('confirms another subscriber for an already-demanded Section at capacity', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db, { maxUniqueSections: 1 }), undefined, runtime());

    const first = await request(app, 'POST', '/api/subscriptions', {
      email: 'capacity-existing-a@berkeley.edu',
      classKeys: [CK_A],
    });
    const second = await request(app, 'POST', '/api/subscriptions', {
      email: 'capacity-existing-b@berkeley.edu',
      classKeys: [CK_A],
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const [a, b] = await Promise.all([
      getSubscriberByEmail(db, 'capacity-existing-a@berkeley.edu'),
      getSubscriberByEmail(db, 'capacity-existing-b@berkeley.edu'),
    ]);
    if (!a || !b) throw new Error('expected both staged subscribers');

    const confirmations = await Promise.all([
      request(app, 'POST', `/api/subscriptions/${mintToken(a.id)}/confirm`, {}),
      request(app, 'POST', `/api/subscriptions/${mintToken(b.id)}/confirm`, {}),
    ]);
    expect(confirmations.map((response) => response.status)).toEqual([200, 200]);
    expect(await db.select().from(subscribers)).toHaveLength(2);
    expect(await db.select().from(watches)).toHaveLength(2);
    expect(await getDistinctWatchedClassKeys(db)).toEqual([CK_A]);
    expect(await db.select().from(mailOutbox)).toHaveLength(2);
  });

  it('returns all three typed confirmation outcomes without partially activating a loser', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const repo = makeServerRepo(db, { maxUniqueSections: 1 });
    const first = await repo.createSubscriber('typed-a@berkeley.edu', [CK_A as ClassKey]);
    const second = await repo.createSubscriber('typed-b@berkeley.edu', [CK_B as ClassKey]);

    await expect(repo.confirmSubscriber(first.id)).resolves.toBe('confirmed');
    const afterFirst = (await db.select().from(subscribers)).find((row) => row.id === first.id);
    const firstActivation = (await db.select().from(watches)).find(
      (row) => row.subscriberId === first.id,
    );
    expect(afterFirst?.confirmedAt).toBeInstanceOf(Date);
    expect(firstActivation?.activatedAt).toBeInstanceOf(Date);
    expect(firstActivation?.activationOrder).not.toBeNull();

    await expect(repo.confirmSubscriber(first.id)).resolves.toBe('already_confirmed');
    await expect(repo.confirmSubscriber(second.id)).resolves.toBe('capacity_exceeded');

    const afterSecondCall = (await db.select().from(subscribers)).find(
      (row) => row.id === first.id,
    );
    const rejectedSubscriber = (await db.select().from(subscribers)).find(
      (row) => row.id === second.id,
    );
    const rejectedWatch = (await db.select().from(watches)).find(
      (row) => row.subscriberId === second.id,
    );
    expect(afterSecondCall?.confirmedAt).toEqual(afterFirst?.confirmedAt);
    expect(rejectedSubscriber?.confirmedAt).toBeNull();
    expect(rejectedWatch?.activatedAt).toBeNull();
    expect(rejectedWatch?.activationOrder).toBeNull();
  });

  it('lets Pending add stage above capacity, rejects whole confirmation, and retries after removal', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(
      makeServerRepo(db, { maxUniqueSections: 1 }),
      undefined,
      runtime(undefined, { capacityRetryAfterSeconds: 137 }),
    );
    expect(
      (
        await request(app, 'POST', '/api/subscriptions', {
          email: 'pending-stage@berkeley.edu',
          classKeys: [CK_A],
        })
      ).status,
    ).toBe(202);
    const subscriber = await getSubscriberByEmail(db, 'pending-stage@berkeley.edu');
    if (!subscriber) throw new Error('expected staged subscriber');
    const token = mintToken(subscriber.id);

    const add = await request(app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_B,
    });
    expect(add.status).toBe(200);
    expect(await getDistinctWatchedClassKeys(db)).toEqual([]);

    const rejected = await request(app, 'POST', `/api/subscriptions/${token}/confirm`, {});
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('137');
    expect(await rejected.json()).toEqual({
      error: {
        code: 'capacity_exceeded',
        message: 'source monitoring capacity is full; please try again later',
      },
    });
    expect((await db.select().from(subscribers))[0]?.confirmedAt).toBeNull();
    expect((await db.select().from(watches)).every((watch) => watch.activatedAt === null)).toBe(
      true,
    );

    expect(
      (
        await request(
          app,
          'DELETE',
          `/api/subscriptions/${token}/watches/${encodeURIComponent(CK_B)}`,
        )
      ).status,
    ).toBe(204);
    expect((await request(app, 'POST', `/api/subscriptions/${token}/confirm`, {})).status).toBe(
      200,
    );
    expect(await getDistinctWatchedClassKeys(db)).toEqual([CK_A]);
  });

  it('rejects a Confirmed add at capacity without disturbing existing demand', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(
      makeServerRepo(db, { maxUniqueSections: 1 }),
      undefined,
      runtime(undefined, { capacityRetryAfterSeconds: 149 }),
    );
    await request(app, 'POST', '/api/subscriptions', {
      email: 'confirmed-add@berkeley.edu',
      classKeys: [CK_A],
    });
    const subscriber = await getSubscriberByEmail(db, 'confirmed-add@berkeley.edu');
    if (!subscriber) throw new Error('expected subscriber');
    const token = mintToken(subscriber.id);
    expect((await request(app, 'POST', `/api/subscriptions/${token}/confirm`, {})).status).toBe(
      200,
    );

    const rejected = await request(app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_B,
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('149');
    expect(await getDistinctWatchedClassKeys(db)).toEqual([CK_A]);
    const live = await db.select().from(watches);
    expect(live).toHaveLength(1);
    expect(live[0]?.classKey).toBe(CK_A);
  });

  it('returns only after committing a queued confirmation job with no recipient or token payload', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db), undefined, runtime());
    const email = 'durable-api@berkeley.edu';

    const response = await request(app, 'POST', '/api/subscriptions', {
      email,
      classKeys: [CK_A],
    });

    expect(response.status).toBe(202);
    const [job] = await db.select().from(mailOutbox);
    expect(job).toMatchObject({
      kind: 'confirmation',
      status: 'queued',
      payload: {},
      attempts: 0,
    });
    const persisted = JSON.stringify(job);
    expect(persisted).not.toContain(email);
    expect(persisted).not.toContain('token');
    expect(job?.subscriberId).toBeTruthy();
  });
});

describe('v0.4 shared limiter, readiness, and canonical JSON failures', () => {
  it('shares one injected atomic window across API instances and preserves it across reconstruction', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const shared = new MemoryRateLimiter();
    const options = runtime(shared, {
      rateLimitConfig: {
        subscribeMax: 2,
        subscribeWindowSeconds: 60,
        emailMax: 100,
        emailWindowSeconds: 900,
      },
    });
    const repo = makeServerRepo(db);
    const first = createApp(repo, undefined, options);
    const second = createApp(repo, undefined, options);

    expect(
      (
        await request(first, 'POST', '/api/subscriptions/resend', {
          email: 'shared-one@berkeley.edu',
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await request(second, 'POST', '/api/subscriptions/resend', {
          email: 'shared-two@berkeley.edu',
        })
      ).status,
    ).toBe(202);

    const reconstructed = createApp(repo, undefined, options);
    const limited = await request(reconstructed, 'POST', '/api/subscriptions/resend', {
      email: 'shared-three@berkeley.edu',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await limited.json()).error.code).toBe('rate_limited');
  });

  it('reports healthy dependencies and aggregate outbox state on readiness', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db), undefined, runtime());

    const response = await request(app, 'GET', '/api/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', rateLimiter: 'ok', outbox: 'ok' },
      outbox: {
        queued: 0,
        processing: 0,
        deadLetter: 0,
        oldestQueuedAgeSeconds: null,
      },
    });
  });

  it('keeps liveness green while readiness fails closed for DB, limiter, or stale outbox', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const base = makeServerRepo(db);
    const repo: SubscriptionRepo = {
      ...base,
      healthCheck: async () => {
        throw new Error('database unavailable');
      },
      getOutboxHealth: async () => ({
        queued: 1,
        processing: 0,
        deadLetter: 0,
        oldestQueuedAgeSeconds: 301,
      }),
    };
    const limiter: RateLimiter = {
      backend: 'test',
      consume: async (_scope, _identifier, _max, windowSeconds) => ({
        allowed: true,
        retryAfterSeconds: windowSeconds,
      }),
      healthCheck: async () => {
        throw new Error('limiter unavailable');
      },
    };
    const app = createApp(repo, undefined, runtime(limiter, { outboxReadinessMaxAgeSeconds: 300 }));

    expect((await request(app, 'GET', '/api/health')).status).toBe(200);
    const ready = await request(app, 'GET', '/api/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: 'unavailable',
      checks: {
        database: 'unavailable',
        rateLimiter: 'unavailable',
        outbox: 'unavailable',
      },
    });
  });

  it('uses the standard JSON envelope for unmatched routes and unhandled middleware failures', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const repo = makeServerRepo(db);
    const brokenLimiter: RateLimiter = {
      backend: 'test',
      consume: async () => {
        throw new Error('backend unavailable');
      },
      healthCheck: async () => undefined,
    };
    const app = createApp(repo, undefined, runtime(brokenLimiter));

    const missing = await request(app, 'GET', '/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'route not found' },
    });

    const failed = await request(app, 'POST', '/api/subscriptions/resend', {
      email: 'middleware-failure@berkeley.edu',
    });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('content-type')).toContain('application/json');
    expect(await failed.json()).toEqual({
      error: { code: 'internal_error', message: 'an unexpected error occurred' },
    });
  });

  it('handles malformed and encoded-separator token paths without escaping the JSON error boundary', async () => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db), undefined, runtime());

    for (const path of [
      '/api/subscriptions/%E0%A4%A',
      '/api/subscriptions/not-a-token%2Fstill-one-segment',
    ]) {
      const response = await request(app, 'GET', path);
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: { code: 'token_invalid', message: 'invalid or expired token' },
      });
    }
  });
});
