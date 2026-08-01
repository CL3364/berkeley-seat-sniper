import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkerReadiness, workerPushIsOperational } from '../../src/server/worker-readiness';
import { createWorkerHeartbeat } from '../../src/worker/poller';

const HEALTHY_SNAPSHOT = {
  sourceStaleCount: 0,
  outboxQueued: 0,
  outboxProcessing: 0,
  outboxDeadLetter: 0,
  outboxOldestQueuedAgeMs: null,
};

describe('worker push readiness marker', () => {
  let directory: string;
  let markerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'seat-sniper-worker-ready-'));
    markerPath = join(directory, 'heartbeat');
    process.env.WORKER_HEARTBEAT_FILE = markerPath;
    process.env.WORKER_HEALTH_MAX_STALE_SECONDS = '90';
    process.env.VAPID_PUBLIC_KEY = 'public-a';
  });

  afterEach(() => {
    delete process.env.WORKER_HEARTBEAT_FILE;
    delete process.env.WORKER_HEALTH_MAX_STALE_SECONDS;
    delete process.env.VAPID_PUBLIC_KEY;
    rmSync(directory, { recursive: true, force: true });
  });

  it('accepts only a fresh marker for the exact public key', async () => {
    const now = Date.now();
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 2,
        vapidPublicKey: 'public-a',
        disabled: false,
        heartbeatAtMs: now,
        lastSuccessfulCycleAtMs: now,
        healthy: true,
        health: HEALTHY_SNAPSHOT,
      }),
    );

    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(true);
    await expect(workerPushIsOperational('public-b', now)).resolves.toBe(false);
  });

  it('keeps progress liveness separate from successful-cycle readiness', async () => {
    const now = Date.now();
    let heartbeatNow = now - 91_000;
    const heartbeat = createWorkerHeartbeat(() => heartbeatNow);

    heartbeat.reset();
    heartbeat.recordProgress();
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({
      version: 2,
      vapidPublicKey: 'public-a',
      lastSuccessfulCycleAtMs: null,
    });
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);

    // A later progress write refreshes mtime but preserves the old successful
    // cycle, as happens while a failed cycle backs off.
    heartbeat.recordSuccess(HEALTHY_SNAPSHOT);
    heartbeatNow = now;
    heartbeat.recordProgress();
    utimesSync(markerPath, now / 1_000, now / 1_000);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).lastSuccessfulCycleAtMs).toBe(now - 91_000);
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);

    heartbeat.recordSuccess(HEALTHY_SNAPSHOT);
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(true);
  });

  it('publishes strict v2 health truth and progress never paints an unhealthy worker green', async () => {
    let now = Date.now();
    const heartbeat = createWorkerHeartbeat(() => now);
    const healthy = {
      sourceStaleCount: 0,
      outboxQueued: 1,
      outboxProcessing: 0,
      outboxDeadLetter: 0,
      outboxOldestQueuedAgeMs: 2_000,
    };

    heartbeat.recordSuccess(healthy);
    await expect(
      readWorkerReadiness({
        path: markerPath,
        nowMs: now,
        maxStaleSeconds: 90,
        maxOutboxAgeSeconds: 300,
      }),
    ).resolves.toMatchObject({
      ready: true,
      snapshot: {
        healthy: true,
        sourceStaleCount: 0,
        outboxDeadLetter: 0,
        outboxOldestQueuedAgeSeconds: 2,
      },
    });

    const successfulAt = now;
    now += 1_000;
    heartbeat.recordUnhealthy({
      sourceStaleCount: 1,
      outboxQueued: 2,
      outboxProcessing: 0,
      outboxDeadLetter: 1,
      outboxOldestQueuedAgeMs: 1_000,
    });
    now += 1_000;
    heartbeat.recordProgress();

    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      heartbeatAtMs: number;
      lastSuccessfulCycleAtMs: number;
      healthy: boolean;
      health: { sourceStaleCount: number; outboxDeadLetter: number };
    };
    expect(marker).toMatchObject({
      heartbeatAtMs: now,
      lastSuccessfulCycleAtMs: successfulAt,
      healthy: false,
      health: {
        sourceStaleCount: 1,
        outboxDeadLetter: 1,
      },
    });
    await expect(
      readWorkerReadiness({
        path: markerPath,
        nowMs: now,
        maxStaleSeconds: 90,
        maxOutboxAgeSeconds: 300,
      }),
    ).resolves.toMatchObject({
      ready: false,
      snapshot: {
        healthy: false,
        sourceStaleCount: 1,
        outboxDeadLetter: 1,
      },
    });
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);
  });

  it('rejects stale, future-dated, legacy, absent, and malformed markers', async () => {
    const now = Date.now();
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 2,
        vapidPublicKey: 'public-a',
        lastSuccessfulCycleAtMs: now - 91_000,
      }),
    );
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);

    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 2,
        vapidPublicKey: 'public-a',
        lastSuccessfulCycleAtMs: now + 5_001,
      }),
    );
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);

    writeFileSync(markerPath, JSON.stringify({ version: 1, vapidPublicKey: 'public-a' }));
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);

    writeFileSync(markerPath, '{not-json');
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);
    rmSync(markerPath);
    await expect(workerPushIsOperational('public-a', now)).resolves.toBe(false);
  });
});
