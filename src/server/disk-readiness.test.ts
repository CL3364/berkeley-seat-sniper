import { describe, expect, it } from 'vitest';

import type { PushKeys, SuppressionReason } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { readAdmissionPolicy } from './admission';
import { createApp, type AppRuntimeOptions, type SubscriptionRepo } from './app';
import { readDiskReadiness, readDiskReadinessConfig } from './disk-readiness';
import { MemoryRateLimiter } from './rate-limit';

function repo(): SubscriptionRepo {
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
    requireProductionReadiness: false,
    ...overrides,
  };
}

describe('disk readiness configuration', () => {
  it('is optional outside production and required in production', () => {
    expect(readDiskReadinessConfig({ NODE_ENV: 'test' })).toBeNull();
    expect(() => readDiskReadinessConfig({ NODE_ENV: 'production' })).toThrow(
      /DISK_READINESS_PATH/,
    );
  });

  it('accepts a bounded absolute operator path and defaults to one GiB', () => {
    expect(
      readDiskReadinessConfig({
        NODE_ENV: 'production',
        DISK_READINESS_PATH: ' /app/runtime ',
      }),
    ).toEqual({
      path: '/app/runtime',
      minFreeKb: 1_048_576,
    });
  });

  it('rejects unsafe paths and invalid thresholds before startup', () => {
    expect(() =>
      readDiskReadinessConfig({
        NODE_ENV: 'production',
        DISK_READINESS_PATH: 'runtime',
      }),
    ).toThrow(/bounded absolute path/);
    expect(() =>
      readDiskReadinessConfig({
        NODE_ENV: 'production',
        DISK_READINESS_PATH: `/app/${'x'.repeat(1_024)}`,
      }),
    ).toThrow(/bounded absolute path/);
    expect(() =>
      readDiskReadinessConfig({
        NODE_ENV: 'production',
        DISK_READINESS_PATH: '/app/runtime',
        HEALTH_DISK_MIN_FREE_KB: '0',
      }),
    ).toThrow(/HEALTH_DISK_MIN_FREE_KB/);
  });
});

describe('disk readiness probe', () => {
  it('uses Node statfs for the configured path and fails a missing path closed', async () => {
    await expect(
      readDiskReadiness({
        path: process.cwd(),
        minFreeKb: 1,
      }),
    ).resolves.toEqual({ ready: true });
    await expect(
      readDiskReadiness({
        path: `${process.cwd()}/does-not-exist-disk-readiness`,
        minFreeKb: 1,
      }),
    ).resolves.toEqual({ ready: false });
  });

  it('is ready at or above the configured available-space threshold', async () => {
    await expect(
      readDiskReadiness({
        path: '/not-exposed',
        minFreeKb: 10,
        statfsReader: async () => ({ bavail: 10n, bsize: 1_024n }),
      }),
    ).resolves.toEqual({ ready: true });
    await expect(
      readDiskReadiness({
        path: '/not-exposed',
        minFreeKb: 10,
        statfsReader: async () => ({ bavail: 11n, bsize: 1_024n }),
      }),
    ).resolves.toEqual({ ready: true });
  });

  it('fails closed below threshold or for invalid filesystem values', async () => {
    await expect(
      readDiskReadiness({
        path: '/not-exposed',
        minFreeKb: 10,
        statfsReader: async () => ({ bavail: 9n, bsize: 1_024n }),
      }),
    ).resolves.toEqual({ ready: false });
    await expect(
      readDiskReadiness({
        path: '/not-exposed',
        minFreeKb: 10,
        statfsReader: async () => ({ bavail: -1n, bsize: 1_024n }),
      }),
    ).resolves.toEqual({ ready: false });
  });

  it('fails closed on missing or unreadable paths without returning details', async () => {
    const path = '/operator/runtime/secret';
    const error = Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    const result = await readDiskReadiness({
      path,
      minFreeKb: 10,
      statfsReader: async () => {
        throw error;
      },
    });

    expect(result).toEqual({ ready: false });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result)).not.toContain('EACCES');
  });
});

describe('aggregate readiness disk signal', () => {
  it('fails readiness on low disk, recovers, and keeps liveness green', async () => {
    let diskReady = false;
    const app = createApp(
      repo(),
      undefined,
      runtime({
        diskReadinessCheck: async () => ({ ready: diskReady }),
      }),
    );

    expect((await app.request('http://localhost/api/health')).status).toBe(200);
    const unavailable = await app.request('http://localhost/api/ready');
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      status: 'unavailable',
      checks: { disk: 'unavailable' },
    });

    diskReady = true;
    const recovered = await app.request('http://localhost/api/ready');
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      status: 'ready',
      checks: { disk: 'ok' },
    });
  });

  it('does not expose path or errno when an injected probe throws', async () => {
    const app = createApp(
      repo(),
      undefined,
      runtime({
        diskReadinessCheck: async () => {
          throw Object.assign(new Error('EACCES: /app/runtime'), { code: 'EACCES' });
        },
      }),
    );

    const response = await app.request('http://localhost/api/ready');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('/app/runtime');
    expect(body).not.toContain('EACCES');
    expect(JSON.parse(body)).toMatchObject({
      status: 'unavailable',
      checks: { disk: 'unavailable' },
    });
  });
});
