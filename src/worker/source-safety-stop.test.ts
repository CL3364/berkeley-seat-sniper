import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileSourceOriginControl } from './source-origin-control';
import {
  SOURCE_SAFETY_STOP_RESET_CONFIRMATION,
  SourceSafetyStopResetDeferredError,
  createFileSourceSafetyStopStore,
  defaultSourceSafetyStopFile,
  sourceSafetyStopCliResetRejection,
} from './source-safety-stop';

const temporaryDirectories: string[] = [];
const STOPPED_AT = '2026-07-27T22:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function markerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'seat-sniper-worker-stop-'));
  temporaryDirectories.push(directory);
  return join(directory, 'source-safety-stop.json');
}

describe('file source-safety-stop store', () => {
  it('writes a bounded non-PII marker that a new store instance observes', async () => {
    const path = await markerPath();
    const first = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(STOPPED_AT),
    });

    await expect(first.engage('source_forbidden')).resolves.toEqual({
      stopped: true,
      classification: 'source_forbidden',
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      reason: 'source_forbidden',
      stoppedAt: STOPPED_AT,
      resumeNotBefore: null,
    });

    const afterRestart = createFileSourceSafetyStopStore({ path });
    await expect(afterRestart.inspect()).resolves.toEqual({
      stopped: true,
      classification: 'source_forbidden',
    });
  });

  it('persists a bounded 429 deadline that survives restart and rejects early reset', async () => {
    const path = await markerPath();
    let currentMs = Date.parse(STOPPED_AT);
    const first = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(currentMs),
    });

    await expect(first.engage('source_rate_limited', { resumeDelayMs: 90_000 })).resolves.toEqual({
      stopped: true,
      classification: 'source_rate_limited',
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      reason: 'source_rate_limited',
      stoppedAt: STOPPED_AT,
      resumeNotBefore: '2026-07-27T22:01:30.000Z',
    });

    const restartedEarly = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(currentMs),
    });
    await expect(
      restartedEarly.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION),
    ).rejects.toBeInstanceOf(SourceSafetyStopResetDeferredError);
    await expect(restartedEarly.inspect()).resolves.toEqual({
      stopped: true,
      classification: 'source_rate_limited',
    });

    currentMs += 90_000;
    const restartedAtDeadline = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(currentMs),
    });
    await restartedAtDeadline.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION);
    await expect(restartedAtDeadline.inspect()).resolves.toEqual({ stopped: false });
  });

  it.each(['not json', '{}', '{"version":1,"reason":"unknown","stoppedAt":"never"}'])(
    'fails closed for malformed marker %j',
    async (contents) => {
      const path = await markerPath();
      await writeFile(path, contents, 'utf8');

      await expect(createFileSourceSafetyStopStore({ path }).inspect()).resolves.toEqual({
        stopped: true,
        classification: 'marker_invalid',
      });
    },
  );

  it('fails closed when the marker parent cannot be inspected or written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seat-sniper-worker-stop-'));
    temporaryDirectories.push(root);
    const missingParentPath = join(root, 'missing', 'source-safety-stop.json');

    await expect(
      createFileSourceSafetyStopStore({ path: missingParentPath }).inspect(),
    ).resolves.toEqual({
      stopped: true,
      classification: 'marker_unreadable',
    });
  });

  it('fails closed when the configured marker path is not a regular file', async () => {
    const path = await markerPath();
    await mkdir(path);

    await expect(createFileSourceSafetyStopStore({ path }).inspect()).resolves.toEqual({
      stopped: true,
      classification: 'marker_invalid',
    });
  });

  it('does not clear without the exact Operator confirmation', async () => {
    const path = await markerPath();
    const store = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(STOPPED_AT),
    });
    await store.engage('robots_disallow');

    await expect(store.reset('yes')).rejects.toThrow('confirmation rejected');
    await expect(store.inspect()).resolves.toMatchObject({ stopped: true });

    await store.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION);
    await expect(store.inspect()).resolves.toEqual({ stopped: false });
  });

  it('clears a stale origin fence on reset without deleting request history', async () => {
    const path = await markerPath();
    const originPath = `${path}.origin-state`;
    let currentMs = Date.parse(STOPPED_AT);
    const originControl = createFileSourceOriginControl({
      path: originPath,
      nowMs: () => currentMs,
    });
    const owned = await originControl.acquireFence();
    if (!owned.acquired) throw new Error('origin fence was not acquired');
    await expect(
      owned.fence.runWithPermit(
        {
          requestsPerSecond: 1,
          nowMs: () => currentMs,
          sleep: async (milliseconds) => {
            currentMs += milliseconds;
          },
          beforeStart: async () => true,
        },
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    owned.fence.retain();
    await owned.fence.release();

    const store = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(STOPPED_AT),
      originControl,
    });
    await store.engage('source_forbidden');
    const persistedBeforeReset = await readFile(originPath, 'utf8');
    await store.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION);

    const afterReset = await createFileSourceOriginControl({ path: originPath }).acquireFence();
    expect(afterReset.acquired).toBe(true);
    if (afterReset.acquired) await afterReset.fence.release();
    await expect(readFile(originPath, 'utf8')).resolves.toBe(persistedBeforeReset);
  });

  it('repairs malformed origin state before clearing the retained fence', async () => {
    const path = await markerPath();
    const originPath = `${path}.origin-state`;
    const resetAtMs = Date.parse(STOPPED_AT);
    await writeFile(originPath, 'not-json', 'utf8');
    const originControl = createFileSourceOriginControl({
      path: originPath,
      nowMs: () => resetAtMs,
    });
    const owned = await originControl.acquireFence();
    if (!owned.acquired) throw new Error('origin fence was not acquired');
    await expect(
      owned.fence.runWithPermit(
        {
          requestsPerSecond: 1,
          nowMs: () => resetAtMs,
          sleep: async () => undefined,
          beforeStart: async () => true,
        },
        () => undefined,
      ),
    ).resolves.toEqual({
      status: 'blocked',
      classification: 'origin_state_invalid',
    });
    await owned.fence.release();

    const store = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(resetAtMs),
      originControl,
    });
    await store.engage('source_forbidden');
    await store.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION);
    expect(JSON.parse(await readFile(originPath, 'utf8'))).toMatchObject({
      version: 2,
      lastPermitAt: STOPPED_AT,
      notBefore: null,
      notBeforeSetAt: null,
    });

    let currentMs = resetAtMs;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    const repairedControl = createFileSourceOriginControl({ path: originPath });
    const repairedOwner = await repairedControl.acquireFence();
    if (!repairedOwner.acquired) throw new Error('repaired origin fence was not acquired');
    await expect(
      repairedOwner.fence.runWithPermit(
        {
          requestsPerSecond: 1,
          nowMs: () => currentMs,
          sleep,
          beforeStart: async () => true,
        },
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
    await repairedOwner.fence.release();
  });

  it('never follows or removes a pre-existing temporary-file symlink', async () => {
    const path = await markerPath();
    const target = join(dirname(path), 'unrelated-target');
    const temporaryPath = `${path}.tmp-${process.pid}-fixed-test-suffix`;
    await writeFile(target, 'unchanged', 'utf8');
    await symlink(target, temporaryPath);
    const store = createFileSourceSafetyStopStore({
      path,
      now: () => new Date(STOPPED_AT),
      temporarySuffix: () => 'fixed-test-suffix',
    });

    await expect(store.engage('source_forbidden')).resolves.toEqual({
      stopped: true,
      classification: 'marker_persist_failed',
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
    expect((await lstat(temporaryPath)).isSymbolicLink()).toBe(true);
  });

  it('never follows a configured marker symlink while inspecting', async () => {
    const path = await markerPath();
    const target = join(dirname(path), 'unrelated-marker-target');
    await writeFile(
      target,
      JSON.stringify({
        version: 2,
        reason: 'source_forbidden',
        stoppedAt: STOPPED_AT,
        resumeNotBefore: null,
      }),
      'utf8',
    );
    await symlink(target, path);

    await expect(createFileSourceSafetyStopStore({ path }).inspect()).resolves.toEqual({
      stopped: true,
      classification: 'marker_unreadable',
    });
  });

  it('defaults beside the configured heartbeat unless explicitly overridden', () => {
    expect(
      defaultSourceSafetyStopFile({
        WORKER_HEARTBEAT_FILE: '/runtime/worker-heartbeat',
      }),
    ).toBe('/runtime/worker-heartbeat.source-safety-stop');
    expect(
      defaultSourceSafetyStopFile({
        WORKER_HEARTBEAT_FILE: '/runtime/worker-heartbeat',
        SOURCE_SAFETY_STOP_FILE: '/state/source-stop',
      }),
    ).toBe('/state/source-stop');
  });

  it('requires both the exact reset phrase and an active kill switch at the CLI boundary', () => {
    expect(sourceSafetyStopCliResetRejection('wrong', { KILL_SWITCH: '1' })).toBe(
      'confirmation_missing',
    );
    expect(
      sourceSafetyStopCliResetRejection(SOURCE_SAFETY_STOP_RESET_CONFIRMATION, {
        KILL_SWITCH: '0',
      }),
    ).toBe('kill_switch_required');
    expect(
      sourceSafetyStopCliResetRejection(SOURCE_SAFETY_STOP_RESET_CONFIRMATION, {
        KILL_SWITCH: '1',
      }),
    ).toBeNull();
  });
});
