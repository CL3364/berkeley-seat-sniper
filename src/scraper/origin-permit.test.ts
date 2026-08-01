import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassKey } from '../shared/class-key';
import { isSeatState } from '../shared/seat-state';
import {
  __clearRobotsCacheForTests,
  createPublicClassPageSource,
  fetchClassObservation,
  FetchError,
  isSourceFetchingEnabled,
  type OriginPermitContext,
  type OriginRequestStart,
  type RunWithOriginPermit,
} from './index';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const OPEN_PAGE = readFileSync(
  fileURLToPath(new URL('./fixtures/open-seats.html', import.meta.url)),
  'utf8',
);

describe('origin permit enforcement', () => {
  beforeEach(() => {
    process.env.KILL_SWITCH = '0';
    delete process.env.RESPECT_ROBOTS;
    delete process.env.FETCH_TIMEOUT_MS;
    __clearRobotsCacheForTests();
  });

  afterEach(() => {
    delete process.env.KILL_SWITCH;
    delete process.env.RESPECT_ROBOTS;
    delete process.env.FETCH_TIMEOUT_MS;
    __clearRobotsCacheForTests();
    vi.useRealTimers();
  });

  it('runs every robots, class, and redirect fetch inside its permit callback', async () => {
    const events: string[] = [];
    const contexts: OriginPermitContext[] = [];
    let attempt = 0;

    const runWithOriginPermit: RunWithOriginPermit = async <T>(
      context: OriginPermitContext,
      start: () => OriginRequestStart<T>,
    ): Promise<OriginRequestStart<T>> => {
      contexts.push(context);
      events.push(`permit:${context.kind}`);
      return start();
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const kind = path.startsWith('/robots') ? 'robots' : 'class';
      events.push(`fetch:${kind}`);
      expect(init.redirect).toBe('manual');
      attempt += 1;

      if (attempt === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/robots-v2.txt' },
        });
      }
      if (attempt === 2) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      if (attempt === 3) {
        return new Response(null, {
          status: 307,
          headers: { Location: `/content/${CLASS_KEY}-redirected` },
        });
      }
      return new Response(OPEN_PAGE, { status: 200 });
    });

    const source = createPublicClassPageSource({
      fetchImpl,
      runWithOriginPermit,
    });
    const observation = await source.fetch(CLASS_KEY);

    expect(observation.kind).toBe('result');
    if (observation.kind === 'result') {
      expect(isSeatState(observation.result)).toBe(true);
    }
    expect(events).toEqual([
      'permit:robots',
      'fetch:robots',
      'permit:robots',
      'fetch:robots',
      'permit:class',
      'fetch:class',
      'permit:class',
      'fetch:class',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(contexts).toHaveLength(4);
    expect(contexts.map(({ kind }) => kind)).toEqual(['robots', 'robots', 'class', 'class']);
    for (const context of contexts) {
      expect(Object.keys(context).sort()).toEqual(['kind', 'signal']);
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context).not.toHaveProperty('url');
      expect(context).not.toHaveProperty('classKey');
    }
  });

  it('does not start fetchImpl until the permit wrapper invokes its callback', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const events: string[] = [];
    let releaseBoundary: (() => void) | undefined;
    let markBoundaryStarted: (() => void) | undefined;
    const boundaryStarted = new Promise<void>((resolve) => {
      markBoundaryStarted = resolve;
    });

    const runWithOriginPermit: RunWithOriginPermit = async (_context, start) => {
      events.push('permit:start');
      markBoundaryStarted?.();
      await new Promise<void>((resolve) => {
        releaseBoundary = resolve;
      });
      events.push('permit:ready');
      return start();
    };
    const fetchImpl = vi.fn(async () => {
      events.push('fetch');
      return new Response(OPEN_PAGE, { status: 200 });
    });
    const source = createPublicClassPageSource({ fetchImpl });

    const observationPromise = source.fetch(CLASS_KEY, {
      runWithOriginPermit,
    });
    await boundaryStarted;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events).toEqual(['permit:start']);

    releaseBoundary?.();
    await observationPromise;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['permit:start', 'permit:ready', 'fetch']);
  });

  it('surfaces pre-start wrapper rejection as a typed transient error without fetching', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const fetchImpl = vi.fn();

    const error = await fetchClassObservation(CLASS_KEY, {
      fetchImpl,
      runWithOriginPermit: async () => {
        throw new Error('internal limiter failure that must not be reflected');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      status: 0,
      detail: 'class origin permit acquisition failed',
    });
    expect((error as FetchError).detail).not.toContain('internal limiter failure');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a stalled pre-start wrapper by the same absolute request deadline', async () => {
    vi.useFakeTimers();
    process.env.RESPECT_ROBOTS = '0';
    process.env.FETCH_TIMEOUT_MS = '25';
    let permitSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn();

    const observationPromise = fetchClassObservation(CLASS_KEY, {
      fetchImpl,
      runWithOriginPermit: async <T>({
        signal,
      }: OriginPermitContext): Promise<OriginRequestStart<T>> => {
        permitSignal = signal;
        return new Promise<OriginRequestStart<T>>(() => undefined);
      },
    });
    const rejection = expect(observationPromise).rejects.toMatchObject({
      name: 'FetchError',
      status: 0,
      detail: expect.stringContaining('timed out'),
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(permitSignal?.aborted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts an already-started request when post-start reconciliation rejects', async () => {
    process.env.RESPECT_ROBOTS = '0';
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init.signal as AbortSignal;
          requestSignal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const runWithOriginPermit: RunWithOriginPermit = async (_context, start) => {
      start();
      throw new Error('private reconciliation failure');
    };

    const error = await fetchClassObservation(CLASS_KEY, {
      fetchImpl,
      runWithOriginPermit,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      status: 0,
      detail: 'class origin permit acquisition failed',
    });
    expect((error as FetchError).detail).not.toContain('private reconciliation failure');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('fails closed when the wrapper returns without invoking the physical start', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const fetchImpl = vi.fn();

    const error = await fetchClassObservation(CLASS_KEY, {
      fetchImpl,
      runWithOriginPermit: async <T>(): Promise<OriginRequestStart<T>> => ({
        started: new Promise<T>(() => undefined),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      status: 0,
      detail: 'class origin permit did not return its request start',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps one robots request per cycle while permitting every class request', async () => {
    const kinds: string[] = [];
    const fetchedPaths: string[] = [];
    const source = createPublicClassPageSource({
      runWithOriginPermit: async ({ kind }, start) => {
        kinds.push(kind);
        return start();
      },
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        fetchedPaths.push(path);
        return path === '/robots.txt'
          ? new Response('User-agent: *\nAllow: /\n', { status: 200 })
          : new Response(OPEN_PAGE, { status: 200 });
      },
    });

    source.beginCycle();
    try {
      await source.fetch(CLASS_KEY);
      await source.fetch(CLASS_KEY);
    } finally {
      source.endCycle();
    }

    expect(kinds).toEqual(['robots', 'class', 'class']);
    expect(fetchedPaths.filter((path) => path === '/robots.txt')).toHaveLength(1);
    expect(fetchedPaths.filter((path) => path.startsWith('/content/'))).toHaveLength(2);
  });

  it('runs a conditional request inside the same class start wrapper', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const kinds: string[] = [];
    let wrapperCalls = 0;
    const runWithOriginPermit: RunWithOriginPermit = async <T>(
      { kind }: OriginPermitContext,
      start: () => OriginRequestStart<T>,
    ): Promise<OriginRequestStart<T>> => {
      wrapperCalls += 1;
      kinds.push(kind);
      return start();
    };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('if-none-match')).toBe('"fixture-v1"');
      return new Response(null, { status: 304 });
    });

    const observation = await fetchClassObservation(CLASS_KEY, {
      fetchImpl,
      runWithOriginPermit,
      validators: { etag: '"fixture-v1"' },
    });

    expect(observation.kind).toBe('not-modified');
    expect(kinds).toEqual(['class']);
    expect(wrapperCalls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fail-closed source-fetch enablement', () => {
  afterEach(() => {
    delete process.env.KILL_SWITCH;
    delete process.env.RESPECT_ROBOTS;
  });

  it.each([undefined, '', '1', 'false', '00', ' 0 ', 'invalid'])(
    'suppresses fetching for KILL_SWITCH=%s',
    async (value) => {
      if (value === undefined) {
        delete process.env.KILL_SWITCH;
      } else {
        process.env.KILL_SWITCH = value;
      }
      process.env.RESPECT_ROBOTS = '0';
      const fetchImpl = vi.fn();

      const observation = await fetchClassObservation(CLASS_KEY, { fetchImpl });

      expect(isSourceFetchingEnabled()).toBe(false);
      expect(observation).toMatchObject({
        kind: 'result',
        result: {
          kind: 'parser-broke',
          classKey: CLASS_KEY,
          detail: expect.stringContaining('kill-switch'),
        },
        cache: null,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('permits an injected request only for exact KILL_SWITCH=0', async () => {
    process.env.KILL_SWITCH = '0';
    process.env.RESPECT_ROBOTS = '0';
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const observation = await fetchClassObservation(CLASS_KEY, { fetchImpl });

    expect(isSourceFetchingEnabled()).toBe(true);
    expect(observation).toMatchObject({
      kind: 'result',
      result: { kind: 'class-gone', classKey: CLASS_KEY },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
