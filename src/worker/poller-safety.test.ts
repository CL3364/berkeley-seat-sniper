import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectWorkerSourceDisabled, runPollCycle, type PollCycleDeps } from './poller';
import { createMemorySourceOriginControl, type SourceOriginControl } from './source-origin-control';
import {
  createMemorySourceSafetyStopStore,
  type SourceSafetyStopStore,
} from './source-safety-stop';

let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env['KILL_SWITCH'];
  process.env['KILL_SWITCH'] = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env['KILL_SWITCH'];
  else process.env['KILL_SWITCH'] = originalKillSwitch;
});

describe('worker source-disabled health fallback', () => {
  it('reports enabled only for exact zero with healthy safety authorities', async () => {
    await expect(
      inspectWorkerSourceDisabled(
        createMemorySourceSafetyStopStore(),
        createMemorySourceOriginControl(),
      ),
    ).resolves.toBe(false);
  });

  it.each([undefined, '', '1', 'true', '11', ' 0 '])(
    'reports disabled for non-opt-in KILL_SWITCH %j',
    async (value) => {
      if (value === undefined) delete process.env['KILL_SWITCH'];
      else process.env['KILL_SWITCH'] = value;
      await expect(
        inspectWorkerSourceDisabled(
          createMemorySourceSafetyStopStore(),
          createMemorySourceOriginControl(),
        ),
      ).resolves.toBe(true);
    },
  );

  it('reports disabled for a safety latch, an origin block, or inspection failure', async () => {
    const stopped = createMemorySourceSafetyStopStore({
      stopped: true,
      classification: 'source_forbidden',
    });
    await expect(
      inspectWorkerSourceDisabled(stopped, createMemorySourceOriginControl()),
    ).resolves.toBe(true);

    const origin = createMemorySourceOriginControl();
    const owned = await origin.acquireFence();
    if (!owned.acquired) throw new Error('origin fence was not acquired');
    await expect(
      inspectWorkerSourceDisabled(createMemorySourceSafetyStopStore(), origin),
    ).resolves.toBe(true);
    await owned.fence.release();

    const failingSafety: SourceSafetyStopStore = {
      async inspect() {
        throw new Error('synthetic inspection failure');
      },
      async engage() {
        return { stopped: true, classification: 'marker_persist_failed' };
      },
      async reset() {
        return undefined;
      },
    };
    const failingOrigin: SourceOriginControl = {
      async inspect() {
        throw new Error('synthetic inspection failure');
      },
      async acquireFence() {
        return { acquired: false, classification: 'origin_fence_unavailable' };
      },
      async clearFence() {
        return undefined;
      },
    };
    await expect(
      inspectWorkerSourceDisabled(failingSafety, createMemorySourceOriginControl()),
    ).resolves.toBe(true);
    await expect(
      inspectWorkerSourceDisabled(createMemorySourceSafetyStopStore(), failingOrigin),
    ).resolves.toBe(true);
  });
});

describe('legacy poll-cycle source opt-in', () => {
  it.each([undefined, '', '1', 'true', '11', ' 0 '])(
    'makes zero fetches for non-opt-in KILL_SWITCH %j',
    async (value) => {
      if (value === undefined) delete process.env['KILL_SWITCH'];
      else process.env['KILL_SWITCH'] = value;
      const fetchClass = vi.fn();
      const deps = {
        repo: {},
        notifier: {},
        fetchClass,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as unknown as PollCycleDeps;

      await expect(runPollCycle(deps)).resolves.toMatchObject({
        fetched: 0,
        sourceDisabled: true,
        healthy: false,
      });
      expect(fetchClass).not.toHaveBeenCalled();
    },
  );
});
