import { describe, expect, it } from 'vitest';
import { validateWorkerHealthWindow } from '../../src/worker/poller';

const defaults = {
  baseIntervalMs: 30_000,
  jitterMs: 10_000,
  maxBackoffMs: 600_000,
  workerHealthMaxStaleMs: 900_000,
  dbConnectTimeoutMs: 5_000,
  dbQueryTimeoutMs: 20_000,
  fetchTimeoutMs: 10_000,
  sendTimeoutMs: 10_000,
};

describe('worker health timing configuration', () => {
  it('accepts the shipped timing window', () => {
    expect(() => validateWorkerHealthWindow(defaults)).not.toThrow();
  });

  it('rejects a poll interval longer than the heartbeat window can cover', () => {
    expect(() =>
      validateWorkerHealthWindow({
        ...defaults,
        baseIntervalMs: 1_800_000,
      }),
    ).toThrow(/WORKER_HEALTH_MAX_STALE_SECONDS.*more than 1870 seconds/);
  });

  it('rejects a backoff longer than the heartbeat window can cover', () => {
    expect(() =>
      validateWorkerHealthWindow({
        ...defaults,
        maxBackoffMs: 1_200_000,
      }),
    ).toThrow(/WORKER_HEALTH_MAX_STALE_SECONDS.*more than 1270 seconds/);
  });

  it('rejects the exact computed boundary so healthcheck scheduling has margin', () => {
    expect(() =>
      validateWorkerHealthWindow({
        ...defaults,
        workerHealthMaxStaleMs: 670_000,
      }),
    ).toThrow(/more than 670 seconds/);
  });

  it('adds pool acquisition and every claim-transaction statement', () => {
    expect(() =>
      validateWorkerHealthWindow({
        ...defaults,
        baseIntervalMs: 30_000,
        jitterMs: 0,
        maxBackoffMs: 30_000,
        dbConnectTimeoutMs: 100_000,
        dbQueryTimeoutMs: 100_000,
        fetchTimeoutMs: 1_000,
        sendTimeoutMs: 1_000,
        workerHealthMaxStaleMs: 461_000,
      }),
    ).toThrow(/more than 960 seconds/);
  });
});
