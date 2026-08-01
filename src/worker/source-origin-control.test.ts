import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __clearRobotsCacheForTests,
  createPublicClassPageSource,
  type SourceCacheMetadata,
} from '../scraper';
import type { ClassKey } from '../shared/class-key';
import {
  createFileSourceOriginControl,
  createMemorySourceOriginControl,
  defaultSourceOriginStateFile,
  sourceOriginFenceFile,
} from './source-origin-control';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function originStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'seat-sniper-origin-control-'));
  temporaryDirectories.push(directory);
  return join(directory, 'origin-state.json');
}

function permitOptions(
  nowMs: () => number,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
) {
  return {
    requestsPerSecond: 1,
    nowMs,
    sleep,
    beforeStart: async () => true,
  };
}

describe('file source-origin control', () => {
  it('spaces actual robots, conditional class, and redirect starts after unequal persistence and continuation latency', async () => {
    const path = await originStatePath();
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    let currentMs = baseMs;
    let persistenceIndex = 0;
    let continuationIndex = 0;
    const persistenceLatenciesMs = [900, 150, 50, 800, 800, 25, 10, 600];
    const continuationLatenciesMs = [800, 0, 500, 50];
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => {
        const index = persistenceIndex;
        persistenceIndex += 1;
        currentMs += persistenceLatenciesMs[index] ?? 0;
        return `persist-${index}`;
      },
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');

    const priorKillSwitch = process.env.KILL_SWITCH;
    const priorRespectRobots = process.env.RESPECT_ROBOTS;
    process.env.KILL_SWITCH = '0';
    delete process.env.RESPECT_ROBOTS;
    __clearRobotsCacheForTests();

    const actualStarts: Array<{
      atMs: number;
      kind: 'robots' | 'class';
      headers: Headers;
      path: string;
    }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const requestPath = new URL(url).pathname;
      actualStarts.push({
        atMs: currentMs,
        kind: requestPath.startsWith('/robots') ? 'robots' : 'class',
        headers: new Headers(init.headers),
        path: requestPath,
      });
      expect(init.redirect).toBe('manual');

      switch (actualStarts.length) {
        case 1:
          return new Response(null, {
            status: 302,
            headers: { Location: '/robots-v2.txt' },
          });
        case 2:
          return new Response('User-agent: *\nAllow: /\n', { status: 200 });
        case 3:
          return new Response(null, {
            status: 307,
            headers: { Location: `/content/${CLASS_KEY}` },
          });
        case 4:
          return new Response(null, { status: 304 });
        default:
          throw new Error('unexpected physical source request');
      }
    });
    const source = createPublicClassPageSource({ fetchImpl });
    const previousCache: SourceCacheMetadata = {
      checkedAt: new Date(baseMs - 60_000).toISOString(),
      cacheControl: 'public, max-age=60',
      ageSeconds: 0,
      maxAgeSeconds: 60,
      freshForSeconds: 60,
      freshUntil: new Date(baseMs).toISOString(),
      etag: '"seat-state-v1"',
      lastModified: null,
    };

    try {
      source.beginCycle();
      const observation = await source.fetch(CLASS_KEY, {
        validators: { etag: '"seat-state-v1"' },
        previousCache,
        runWithOriginPermit: async ({ signal }, start) => {
          const result = await acquired.fence.runWithPermit(
            {
              requestsPerSecond: 1,
              nowMs: () => currentMs,
              sleep: async (milliseconds) => {
                currentMs += milliseconds;
              },
              signal,
              beforeStart: async () => true,
            },
            start,
          );
          if (result.status !== 'started') {
            throw new Error(`origin permit did not resolve: ${result.status}`);
          }
          currentMs += continuationLatenciesMs[continuationIndex] ?? 0;
          continuationIndex += 1;
          return result.value;
        },
      });

      expect(observation).toMatchObject({
        kind: 'not-modified',
        classKey: CLASS_KEY,
        cache: {
          etag: '"seat-state-v1"',
        },
      });
      expect(actualStarts.map(({ kind }) => kind)).toEqual(['robots', 'robots', 'class', 'class']);
      expect(actualStarts.map(({ path: requestPath }) => requestPath)).toEqual([
        '/robots.txt',
        '/robots-v2.txt',
        `/content/${CLASS_KEY}`,
        `/content/${CLASS_KEY}`,
      ]);
      expect(actualStarts.map(({ atMs }) => atMs - baseMs)).toEqual([1_000, 2_950, 4_750, 6_275]);
      expect(
        actualStarts.slice(1).map(({ atMs }, index) => atMs - actualStarts[index]!.atMs),
      ).toEqual([1_950, 1_800, 1_525]);
      expect(actualStarts.slice(2).map(({ headers }) => headers.get('if-none-match'))).toEqual([
        '"seat-state-v1"',
        '"seat-state-v1"',
      ]);
    } finally {
      source.endCycle();
      __clearRobotsCacheForTests();
      await acquired.fence.release();
      if (priorKillSwitch === undefined) {
        delete process.env.KILL_SWITCH;
      } else {
        process.env.KILL_SWITCH = priorKillSwitch;
      }
      if (priorRespectRobots === undefined) {
        delete process.env.RESPECT_ROBOTS;
      } else {
        process.env.RESPECT_ROBOTS = priorRespectRobots;
      }
    }

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 2,
      lastPermitAt: new Date(actualStarts.at(-1)!.atMs).toISOString(),
      notBefore: null,
      notBeforeSetAt: null,
    });
  });

  it('preserves actual permit spacing across a normal release and fresh owner', async () => {
    const path = await originStatePath();
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    let currentMs = baseMs;
    let firstWriteIndex = 0;
    const firstControl = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => {
        currentMs += firstWriteIndex === 0 ? 900 : 150;
        const suffix = `first-owner-${firstWriteIndex}`;
        firstWriteIndex += 1;
        return suffix;
      },
    });
    const first = await firstControl.acquireFence();
    if (!first.acquired) throw new Error('first owner did not acquire the fence');
    let firstPhysicalStartMs = -1;

    await expect(
      first.fence.runWithPermit(
        permitOptions(
          () => currentMs,
          async (milliseconds) => {
            currentMs += milliseconds;
          },
        ),
        () => {
          firstPhysicalStartMs = currentMs;
        },
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    await first.fence.release();

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      lastPermitAt: new Date(firstPhysicalStartMs).toISOString(),
    });

    let secondWriteIndex = 0;
    const secondControl = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => {
        currentMs += secondWriteIndex === 0 ? 50 : 0;
        const suffix = `second-owner-${secondWriteIndex}`;
        secondWriteIndex += 1;
        return suffix;
      },
    });
    const second = await secondControl.acquireFence();
    if (!second.acquired) throw new Error('second owner did not acquire the fence');
    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    let secondPhysicalStartMs = -1;

    await expect(
      second.fence.runWithPermit(
        permitOptions(() => currentMs, sleep),
        () => {
          secondPhysicalStartMs = currentMs;
        },
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(950, undefined);
    expect(secondPhysicalStartMs - firstPhysicalStartMs).toBe(1_150);
    expect(secondPhysicalStartMs - firstPhysicalStartMs).toBeGreaterThanOrEqual(1_000);
    await second.fence.release();
  });

  it('does not start and retains the fence when the durable reservation write fails', async () => {
    const path = await originStatePath();
    const suffix = 'blocked-reservation';
    await writeFile(`${path}.tmp-${process.pid}-${suffix}`, 'occupied', 'utf8');
    let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => suffix,
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    const start = vi.fn();

    await expect(
      acquired.fence.runWithPermit(
        permitOptions(
          () => currentMs,
          async (milliseconds) => {
            currentMs += milliseconds;
          },
        ),
        start,
      ),
    ).resolves.toEqual({
      status: 'blocked',
      classification: 'origin_state_persist_failed',
    });
    expect(start).not.toHaveBeenCalled();

    await acquired.fence.release();
    await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });
  });

  it('starts once but retains the fence when actual-start reconciliation fails', async () => {
    const path = await originStatePath();
    const reconciliationSuffix = 'blocked-reconciliation';
    await writeFile(`${path}.tmp-${process.pid}-${reconciliationSuffix}`, 'occupied', 'utf8');
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    let currentMs = baseMs;
    let writeIndex = 0;
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => {
        const index = writeIndex;
        writeIndex += 1;
        if (index === 0) {
          currentMs += 1_200;
          return 'successful-reservation';
        }
        return reconciliationSuffix;
      },
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    const physicalStarts: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });

    await expect(
      acquired.fence.runWithPermit(
        permitOptions(() => currentMs, sleep),
        () => {
          physicalStarts.push(currentMs);
          return 'started-request';
        },
      ),
    ).resolves.toEqual({
      status: 'blocked',
      classification: 'origin_state_persist_failed',
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(physicalStarts).toEqual([baseMs + 1_200]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      lastPermitAt: new Date(baseMs + 1_000).toISOString(),
    });

    await acquired.fence.release();
    await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });
  });

  it('reconciles the start boundary before surfacing a synchronous start error', async () => {
    const path = await originStatePath();
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    let currentMs = baseMs;
    let writeIndex = 0;
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
      temporarySuffix: () => {
        const index = writeIndex;
        writeIndex += 1;
        if (index === 0) currentMs += 1_200;
        return `sync-start-error-${index}`;
      },
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    const startError = new Error('synthetic synchronous start failure');
    const start = vi.fn(() => {
      throw startError;
    });

    await expect(
      acquired.fence.runWithPermit(
        permitOptions(
          () => currentMs,
          async (milliseconds) => {
            currentMs += milliseconds;
          },
        ),
        start,
      ),
    ).rejects.toBe(startError);
    expect(start).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      lastPermitAt: new Date(baseMs + 1_200).toISOString(),
    });

    await acquired.fence.release();
    const nextOwner = await createFileSourceOriginControl({ path }).acquireFence();
    expect(nextOwner.acquired).toBe(true);
    if (nextOwner.acquired) await nextOwner.fence.release();
  });

  it('allows only one owner and permits a new owner after a normal release', async () => {
    const path = await originStatePath();
    const firstControl = createFileSourceOriginControl({ path });
    const secondControl = createFileSourceOriginControl({ path });

    const first = await firstControl.acquireFence();
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error('first owner did not acquire the fence');

    await expect(secondControl.acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });

    await first.fence.release();
    const second = await secondControl.acquireFence();
    expect(second.acquired).toBe(true);
    if (second.acquired) await second.fence.release();
  });

  it('persists first-use state and enforces its spacing after restart', async () => {
    const path = await originStatePath();
    let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
    const firstControl = createFileSourceOriginControl({ path });
    const first = await firstControl.acquireFence();
    if (!first.acquired) throw new Error('first owner did not acquire the fence');

    await expect(
      first.fence.runWithPermit(
        permitOptions(
          () => currentMs,
          async (milliseconds) => {
            currentMs += milliseconds;
          },
        ),
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    await first.fence.release();

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 2,
      lastPermitAt: '2026-07-27T20:00:01.000Z',
      notBefore: null,
      notBeforeSetAt: null,
    });

    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    const restartedControl = createFileSourceOriginControl({ path });
    const restarted = await restartedControl.acquireFence();
    if (!restarted.acquired) throw new Error('restarted owner did not acquire the fence');

    await expect(
      restarted.fence.runWithPermit(
        permitOptions(() => currentMs, sleep),
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
    await restarted.fence.release();
  });

  it('starts nothing on an aborted reserved wait and a new owner cannot start early', async () => {
    const path = await originStatePath();
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    let currentMs = baseMs;
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    const controller = new AbortController();
    const start = vi.fn();

    await expect(
      acquired.fence.runWithPermit(
        {
          ...permitOptions(
            () => currentMs,
            async () => {
              currentMs += 250;
              controller.abort();
            },
          ),
          signal: controller.signal,
        },
        start,
      ),
    ).resolves.toEqual({ status: 'aborted' });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      lastPermitAt: new Date(baseMs + 1_000).toISOString(),
    });
    await acquired.fence.release();

    const nextControl = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const next = await nextControl.acquireFence();
    if (!next.acquired) throw new Error('next owner did not acquire the fence');
    const nextSleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    const actualStarts: number[] = [];
    await expect(
      next.fence.runWithPermit(
        permitOptions(() => currentMs, nextSleep),
        () => {
          actualStarts.push(currentMs);
        },
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    expect(nextSleep).toHaveBeenCalledWith(1_750, undefined);
    expect(actualStarts).toEqual([baseMs + 2_000]);
    await next.fence.release();
  });

  it('keeps the durable fence when its owner crashes after reserving a start', async () => {
    const path = await originStatePath();
    let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    const controller = new AbortController();

    await expect(
      acquired.fence.runWithPermit(
        {
          ...permitOptions(
            () => currentMs,
            async (milliseconds) => {
              currentMs += milliseconds;
              controller.abort();
            },
          ),
          signal: controller.signal,
        },
        () => {
          throw new Error('crashed owner unexpectedly started a request');
        },
      ),
    ).resolves.toEqual({ status: 'aborted' });
    acquired.fence.retain();
    await acquired.fence.release();

    await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });
  });

  it('reads v1 request history and upgrades it on the next permit', async () => {
    const path = await originStatePath();
    let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        ownerToken: '00000000-0000-4000-8000-000000000001',
        lastPermitAt: '2026-07-27T20:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    const control = createFileSourceOriginControl({ path });
    await expect(control.inspect()).resolves.toEqual({ blocked: false });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');

    await expect(
      acquired.fence.runWithPermit(
        permitOptions(() => currentMs, sleep),
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 2,
      lastPermitAt: '2026-07-27T20:00:01.000Z',
      notBefore: null,
      notBeforeSetAt: null,
    });
    await acquired.fence.release();
  });

  it('preserves a durable cooldown across reset and enforces it after restart', async () => {
    const path = await originStatePath();
    let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');
    await acquired.fence.runWithPermit(
      permitOptions(
        () => currentMs,
        async (milliseconds) => {
          currentMs += milliseconds;
        },
      ),
      () => undefined,
    );
    await expect(acquired.fence.deferUntil(currentMs + 60_000)).resolves.toEqual({
      deferred: true,
    });
    acquired.fence.retain();
    await acquired.fence.release();

    const persistedBeforeReset = await readFile(path, 'utf8');
    expect(JSON.parse(persistedBeforeReset)).toMatchObject({
      version: 2,
      lastPermitAt: '2026-07-27T20:00:01.000Z',
      notBefore: '2026-07-27T20:01:01.000Z',
      notBeforeSetAt: '2026-07-27T20:00:01.000Z',
    });
    await control.clearFence();
    await expect(readFile(path, 'utf8')).resolves.toBe(persistedBeforeReset);

    const sleep = vi.fn(async (milliseconds: number) => {
      currentMs += milliseconds;
    });
    const restarted = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const restartedOwner = await restarted.acquireFence();
    if (!restartedOwner.acquired) throw new Error('restarted owner did not acquire the fence');
    await expect(
      restartedOwner.fence.runWithPermit(
        permitOptions(() => currentMs, sleep),
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'started', value: undefined });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000, undefined);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 2,
      lastPermitAt: '2026-07-27T20:01:01.000Z',
      notBefore: null,
      notBeforeSetAt: null,
    });
    await restartedOwner.fence.release();
  });

  it.each([
    {
      label: 'advances an older start boundary',
      lastPermitOffsetMs: 0,
      expectedOffsetMs: 10_000,
    },
    {
      label: 'does not move a future start boundary backward',
      lastPermitOffsetMs: 120_000,
      expectedOffsetMs: 120_000,
    },
  ])(
    '$label during reset and preserves the later cooldown',
    async ({ lastPermitOffsetMs, expectedOffsetMs }) => {
      const path = await originStatePath();
      const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
      const resetAtMs = baseMs + 10_000;
      await writeFile(
        path,
        `${JSON.stringify({
          version: 2,
          ownerToken: '00000000-0000-4000-8000-000000000001',
          lastPermitAt: new Date(baseMs + lastPermitOffsetMs).toISOString(),
          notBefore: new Date(baseMs + 180_000).toISOString(),
          notBeforeSetAt: new Date(baseMs).toISOString(),
        })}\n`,
        'utf8',
      );
      const control = createFileSourceOriginControl({
        path,
        nowMs: () => resetAtMs,
      });
      const acquired = await control.acquireFence();
      if (!acquired.acquired) throw new Error('owner did not acquire the fence');

      await control.clearFence();

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: 2,
        ownerToken: '00000000-0000-4000-8000-000000000001',
        lastPermitAt: new Date(baseMs + expectedOffsetMs).toISOString(),
        notBefore: new Date(baseMs + 180_000).toISOString(),
        notBeforeSetAt: new Date(baseMs).toISOString(),
      });
      const nextOwner = await createFileSourceOriginControl({ path }).acquireFence();
      expect(nextOwner.acquired).toBe(true);
      if (nextOwner.acquired) await nextOwner.fence.release();
    },
  );

  it('leaves the fence active when a monotonic reset write cannot persist', async () => {
    const path = await originStatePath();
    const suffix = 'blocked-reset';
    const baseMs = Date.parse('2026-07-27T20:00:00.000Z');
    const originalState = `${JSON.stringify({
      version: 2,
      ownerToken: '00000000-0000-4000-8000-000000000001',
      lastPermitAt: new Date(baseMs).toISOString(),
      notBefore: null,
      notBeforeSetAt: null,
    })}\n`;
    await writeFile(path, originalState, 'utf8');
    await writeFile(`${path}.tmp-${process.pid}-${suffix}`, 'occupied', 'utf8');
    const control = createFileSourceOriginControl({
      path,
      nowMs: () => baseMs + 10_000,
      temporarySuffix: () => suffix,
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');

    await expect(control.clearFence()).rejects.toThrow('source origin state reset failed');
    await expect(readFile(path, 'utf8')).resolves.toBe(originalState);
    await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });
  });

  it.each(['memory', 'file'] as const)(
    'uses the longer deferred deadline for the next %s permit',
    async (kind) => {
      const path = kind === 'file' ? await originStatePath() : null;
      let currentMs = Date.parse('2026-07-27T20:00:00.000Z');
      const control =
        path === null
          ? createMemorySourceOriginControl()
          : createFileSourceOriginControl({ path, nowMs: () => currentMs });
      const acquired = await control.acquireFence();
      if (!acquired.acquired) throw new Error('owner did not acquire the fence');
      await acquired.fence.runWithPermit(
        permitOptions(
          () => currentMs,
          async (milliseconds) => {
            currentMs += milliseconds;
          },
        ),
        () => undefined,
      );
      await expect(acquired.fence.deferUntil(currentMs + 45_000)).resolves.toEqual({
        deferred: true,
      });

      const sleep = vi.fn(async (milliseconds: number) => {
        currentMs += milliseconds;
      });
      await expect(
        acquired.fence.runWithPermit(
          permitOptions(() => currentMs, sleep),
          () => undefined,
        ),
      ).resolves.toEqual({ status: 'started', value: undefined });
      expect(sleep).toHaveBeenCalledWith(45_000, undefined);
      await acquired.fence.release();
    },
  );

  it('fails closed on malformed state and retains the owner fence', async () => {
    const path = await originStatePath();
    await writeFile(path, 'not-json', 'utf8');
    const control = createFileSourceOriginControl({ path });
    await expect(control.inspect()).resolves.toEqual({
      blocked: true,
      classification: 'origin_state_invalid',
    });
    const acquired = await control.acquireFence();
    if (!acquired.acquired) throw new Error('owner did not acquire the fence');

    await expect(
      acquired.fence.runWithPermit(
        permitOptions(Date.now, async () => undefined),
        () => undefined,
      ),
    ).resolves.toEqual({
      status: 'blocked',
      classification: 'origin_state_invalid',
    });
    await acquired.fence.release();

    await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
      acquired: false,
      classification: 'origin_fence_active',
    });
  });

  it.each(['memory', 'file'] as const)(
    'serializes concurrent physical permits in the %s control',
    async (kind) => {
      const path = kind === 'file' ? await originStatePath() : null;
      const control =
        path === null ? createMemorySourceOriginControl() : createFileSourceOriginControl({ path });
      const acquired = await control.acquireFence();
      if (!acquired.acquired) throw new Error('owner did not acquire the fence');

      let currentMs = 0;
      let activeCommits = 0;
      let maximumActiveCommits = 0;
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });
      const sleep = vi.fn(async (milliseconds: number) => {
        currentMs += milliseconds;
      });
      const enterCommit = async (wait: boolean): Promise<boolean> => {
        activeCommits += 1;
        maximumActiveCommits = Math.max(maximumActiveCommits, activeCommits);
        if (wait) {
          markFirstEntered();
          await firstGate;
        }
        activeCommits -= 1;
        return true;
      };

      const first = acquired.fence.runWithPermit(
        {
          ...permitOptions(() => currentMs, sleep),
          beforeStart: () => enterCommit(true),
        },
        () => 'first-start',
      );
      await firstEntered;
      const second = acquired.fence.runWithPermit(
        {
          ...permitOptions(() => currentMs, sleep),
          beforeStart: () => enterCommit(false),
        },
        () => 'second-start',
      );
      await Promise.resolve();
      expect(maximumActiveCommits).toBe(1);
      releaseFirst();

      await expect(Promise.all([first, second])).resolves.toEqual([
        { status: 'started', value: 'first-start' },
        { status: 'started', value: 'second-start' },
      ]);
      expect(maximumActiveCommits).toBe(1);
      expect(sleep).toHaveBeenCalledWith(1_000, undefined);
      await acquired.fence.release();
    },
  );

  it.each(['memory', 'file'] as const)(
    'fails closed and retains the %s fence above one request per second',
    async (kind) => {
      const path = kind === 'file' ? await originStatePath() : null;
      const control =
        path === null ? createMemorySourceOriginControl() : createFileSourceOriginControl({ path });
      const acquired = await control.acquireFence();
      if (!acquired.acquired) throw new Error('owner did not acquire the fence');

      await expect(
        acquired.fence.runWithPermit(
          {
            ...permitOptions(Date.now, async () => undefined),
            requestsPerSecond: 1.0001,
          },
          () => undefined,
        ),
      ).resolves.toEqual({
        status: 'blocked',
        classification: 'origin_state_invalid',
      });
      await acquired.fence.release();
      await expect(control.acquireFence()).resolves.toEqual({
        acquired: false,
        classification: 'origin_fence_active',
      });
    },
  );

  it('derives stable state and fence paths from the safety marker', () => {
    const statePath = defaultSourceOriginStateFile({
      SOURCE_SAFETY_STOP_FILE: '/runtime/source-safety-stop',
    });
    expect(statePath).toBe('/runtime/source-safety-stop.origin-state');
    expect(sourceOriginFenceFile(statePath)).toBe('/runtime/source-safety-stop.origin-state.fence');
  });
});
