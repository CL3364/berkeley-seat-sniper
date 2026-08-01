import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PushKeys, SuppressionReason } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { readAdmissionPolicy } from './admission';
import { createApp, type AppRuntimeOptions, type SubscriptionRepo } from './app';
import { MemoryRateLimiter } from './rate-limit';
import {
  readWorkerReadiness,
  type WorkerReadinessSnapshot,
  workerPushIsOperational,
} from './worker-readiness';

const NOW = 2_000_000_000_000;
const HEALTHY_SNAPSHOT: WorkerReadinessSnapshot = {
  heartbeatAgeSeconds: 1,
  lastSuccessfulCycleAgeSeconds: 2,
  disabled: false,
  healthy: true,
  sourceStaleCount: 0,
  outboxQueued: 0,
  outboxProcessing: 0,
  outboxDeadLetter: 0,
  outboxOldestQueuedAgeSeconds: null,
};

afterEach(() => {
  delete process.env.WORKER_HEARTBEAT_FILE;
  delete process.env.WORKER_HEALTH_MAX_STALE_SECONDS;
  delete process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS;
});

function marker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    vapidPublicKey: null,
    disabled: false,
    heartbeatAtMs: NOW - 1_000,
    lastSuccessfulCycleAtMs: NOW - 2_000,
    healthy: true,
    health: {
      sourceStaleCount: 0,
      outboxQueued: 0,
      outboxProcessing: 0,
      outboxDeadLetter: 0,
      outboxOldestQueuedAgeMs: null,
    },
    ...overrides,
  };
}

function repo(overrides: Partial<SubscriptionRepo> = {}): SubscriptionRepo {
  return {
    async healthCheck() {},
    async getOutboxHealth() {
      return {
        queued: 0,
        processing: 0,
        deadLetter: 0,
        oldestQueuedAgeSeconds: null,
      };
    },
    async createSubscriber(_email, classKeys) {
      return {
        id: 'subscriber',
        watches: classKeys,
        watchFreshness: [],
      };
    },
    async getSubscriberById() {
      return null;
    },
    async addWatch(_subscriberId, classKey) {
      return { watches: [classKey], watchFreshness: [] };
    },
    async removeWatch(_subscriberId: string, _classKey: ClassKey) {},
    async deleteSubscriber() {},
    async confirmSubscriber() {
      return 'already_confirmed';
    },
    async suppressEmail(_email: string, _reason: SuppressionReason) {},
    async upsertPushSubscription(_subscriberId: string, _endpoint: string, _keys: PushKeys) {},
    async deletePushSubscriptionForSubscriber() {
      return 0;
    },
    async enqueueResendMailByEmail() {
      return { enqueued: false };
    },
    ...overrides,
  };
}

function runtime(overrides: Partial<AppRuntimeOptions> = {}): AppRuntimeOptions {
  return {
    admissionPolicy: readAdmissionPolicy({ ADMISSION_MODE: 'public' }),
    rateLimiter: new MemoryRateLimiter(),
    rateLimitConfig: {
      subscribeMax: 100,
      subscribeWindowSeconds: 60,
      emailMax: 100,
      emailWindowSeconds: 900,
    },
    remoteAddress: () => '127.0.0.1',
    requireProductionReadiness: true,
    workerReadinessCheck: async () => ({
      ready: true,
      snapshot: HEALTHY_SNAPSHOT,
    }),
    ...overrides,
  };
}

describe('strict worker heartbeat v2 readiness', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'seat-sniper-ready-v2-'));
    path = join(directory, 'heartbeat');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function read(value: Record<string, unknown>): ReturnType<typeof readWorkerReadiness> {
    writeFileSync(path, JSON.stringify(value));
    return readWorkerReadiness({
      path,
      nowMs: NOW,
      maxStaleSeconds: 90,
      maxOutboxAgeSeconds: 300,
    });
  }

  it('accepts a fully healthy, fresh marker and exposes only aggregate state', async () => {
    await expect(read(marker())).resolves.toEqual({
      ready: true,
      snapshot: HEALTHY_SNAPSHOT,
    });
  });

  it('advertises push only for the matching key on the same complete healthy marker', async () => {
    process.env.WORKER_HEARTBEAT_FILE = path;
    process.env.WORKER_HEALTH_MAX_STALE_SECONDS = '90';
    process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS = '300';
    writeFileSync(path, JSON.stringify(marker({ vapidPublicKey: 'public-a' })));

    await expect(workerPushIsOperational('public-a', NOW)).resolves.toBe(true);
    await expect(workerPushIsOperational('public-b', NOW)).resolves.toBe(false);

    writeFileSync(path, JSON.stringify(marker({ vapidPublicKey: 'public-a', healthy: false })));
    await expect(workerPushIsOperational('public-a', NOW)).resolves.toBe(false);

    writeFileSync(path, JSON.stringify(marker({ vapidPublicKey: 'public-a', disabled: true })));
    await expect(workerPushIsOperational('public-a', NOW)).resolves.toBe(false);

    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        vapidPublicKey: 'public-a',
        lastSuccessfulCycleAtMs: NOW,
      }),
    );
    await expect(workerPushIsOperational('public-a', NOW)).resolves.toBe(false);
  });

  it.each([
    ['disabled source', { disabled: true }],
    ['stale heartbeat', { heartbeatAtMs: NOW - 90_001 }],
    ['stale successful cycle', { lastSuccessfulCycleAtMs: NOW - 90_001 }],
    ['unhealthy verdict', { healthy: false }],
    [
      'stale source',
      {
        health: {
          sourceStaleCount: 1,
          outboxQueued: 0,
          outboxProcessing: 0,
          outboxDeadLetter: 0,
          outboxOldestQueuedAgeMs: null,
        },
      },
    ],
    [
      'dead letter',
      {
        health: {
          sourceStaleCount: 0,
          outboxQueued: 0,
          outboxProcessing: 0,
          outboxDeadLetter: 1,
          outboxOldestQueuedAgeMs: null,
        },
      },
    ],
    [
      'stale outbox',
      {
        health: {
          sourceStaleCount: 0,
          outboxQueued: 1,
          outboxProcessing: 0,
          outboxDeadLetter: 0,
          outboxOldestQueuedAgeMs: 300_001,
        },
      },
    ],
  ])('fails closed for %s', async (_name, overrides) => {
    const result = await read(marker(overrides));
    expect(result.ready).toBe(false);
    expect(result.snapshot).not.toBeNull();
  });

  it('rejects absent, legacy, incomplete, malformed, and future-dated markers', async () => {
    await expect(
      readWorkerReadiness({
        path,
        nowMs: NOW,
        maxStaleSeconds: 90,
        maxOutboxAgeSeconds: 300,
      }),
    ).resolves.toEqual({ ready: false, snapshot: null });
    await expect(read({ version: 1 })).resolves.toEqual({
      ready: false,
      snapshot: null,
    });
    await expect(read(marker({ heartbeatAtMs: NOW + 5_001 }))).resolves.toMatchObject({
      ready: false,
    });
    writeFileSync(path, '{malformed');
    await expect(
      readWorkerReadiness({
        path,
        nowMs: NOW,
        maxStaleSeconds: 90,
        maxOutboxAgeSeconds: 300,
      }),
    ).resolves.toEqual({ ready: false, snapshot: null });
  });
});

describe('production readiness aggregation', () => {
  it('includes worker v2 state and stays ready only when live outbox truth agrees', async () => {
    const app = createApp(repo(), undefined, runtime());
    const response = await app.request('http://localhost/api/ready');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      checks: {
        database: 'ok',
        rateLimiter: 'ok',
        outbox: 'ok',
        worker: 'ok',
      },
      outbox: {
        queued: 0,
        processing: 0,
        deadLetter: 0,
        oldestQueuedAgeSeconds: null,
      },
      worker: HEALTHY_SNAPSHOT,
    });
  });

  it('keeps liveness green while worker or live dead-letter truth fails readiness', async () => {
    const app = createApp(
      repo({
        async getOutboxHealth() {
          return {
            queued: 0,
            processing: 0,
            deadLetter: 1,
            oldestQueuedAgeSeconds: null,
          };
        },
      }),
      undefined,
      runtime({
        workerReadinessCheck: async () => ({
          ready: false,
          snapshot: { ...HEALTHY_SNAPSHOT, healthy: false },
        }),
      }),
    );

    expect((await app.request('http://localhost/api/health')).status).toBe(200);
    const ready = await app.request('http://localhost/api/ready');
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'unavailable',
      checks: {
        outbox: 'unavailable',
        worker: 'unavailable',
      },
    });
  });

  it('keeps liveness available while backup readiness fails, then recovers on a fresh marker', async () => {
    let backupReady = false;
    const app = createApp(
      repo(),
      undefined,
      runtime({
        backupReadinessCheck: async () =>
          backupReady
            ? {
                ready: true,
                snapshot: {
                  completedAt: '2030-07-24T11:59:30.000Z',
                  ageSeconds: 30,
                },
              }
            : { ready: false, snapshot: null },
      }),
    );

    expect((await app.request('http://localhost/api/health')).status).toBe(200);
    const unavailable = await app.request('http://localhost/api/ready');
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      status: 'unavailable',
      checks: { backup: 'unavailable' },
      backup: null,
    });

    backupReady = true;
    expect((await app.request('http://localhost/api/health')).status).toBe(200);
    const recovered = await app.request('http://localhost/api/ready');
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      status: 'ready',
      checks: { backup: 'ok' },
      backup: {
        completedAt: '2030-07-24T11:59:30.000Z',
        ageSeconds: 30,
      },
    });
  });

  it('fails closed when production dependency probes are not configured', async () => {
    const missingProbes = repo();
    delete missingProbes.healthCheck;
    delete missingProbes.getOutboxHealth;
    const app = createApp(missingProbes, undefined, runtime());

    const response = await app.request('http://localhost/api/ready');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: {
        database: 'unavailable',
        outbox: 'not-configured',
        worker: 'ok',
      },
    });
  });

  it('uses the strict Compose outbox-age env threshold and rejects invalid config', async () => {
    process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS = '120';
    const app = createApp(
      repo({
        async getOutboxHealth() {
          return {
            queued: 1,
            processing: 0,
            deadLetter: 0,
            oldestQueuedAgeSeconds: 121,
          };
        },
      }),
      undefined,
      runtime(),
    );
    expect((await app.request('http://localhost/api/ready')).status).toBe(503);

    process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS = '0';
    expect(() => createApp(repo(), undefined, runtime())).toThrow(/HEALTH_OUTBOX_MAX_AGE_SECONDS/);
    process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS = 'not-a-number';
    expect(() => createApp(repo(), undefined, runtime())).toThrow(/HEALTH_OUTBOX_MAX_AGE_SECONDS/);
  });
});
