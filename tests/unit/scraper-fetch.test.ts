/**
 * Unit tests for fetchClass — spec FR-6, FR-7, AC-6.
 *
 * No real network calls. All tests inject a fake `fetchImpl` via FetchOptions
 * so the live Berkeley site is never touched. The kill-switch and robots.txt
 * paths are exercised by controlling env vars and the fake fetcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchClass,
  fetchClassObservation,
  FetchError,
  __clearRobotsCacheForTests,
} from '../../src/scraper/fetch';
import type { SourceCacheMetadata } from '../../src/scraper/fetch';
import { isClassGone, isParserBroke, isSeatState } from '../../src/shared/seat-state';
import type { ClassKey } from '../../src/shared/class-key';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;

const FIXTURE_DIR = fileURLToPath(new URL('../../src/scraper/fixtures/', import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf-8');
}

/** Build a fake fetchImpl that returns HTTP 200 with the given body text. */
function fakeHttp200(body: string) {
  return vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
}

/** Build a fake fetchImpl that returns the given status (no body). */
function fakeHttpStatus(status: number) {
  return vi.fn().mockResolvedValue(new Response('', { status }));
}

/** Build a response whose transport-level body cancellation can be asserted. */
function cancellableResponse(
  status: number,
  options: {
    headers?: HeadersInit;
    onCancel?: (reason: unknown) => void | Promise<void>;
  } = {},
) {
  const cancel = vi.fn(options.onCancel ?? (() => undefined));
  const body = new ReadableStream<Uint8Array>({ cancel });
  return {
    cancel,
    response: new Response(body, { status, headers: options.headers }),
  };
}

/** Build a fake fetchImpl that rejects with a network error. */
function fakeNetworkError(message = 'connection refused') {
  return vi.fn().mockRejectedValue(new Error(message));
}

/**
 * Fake fetchImpl that answers robots.txt with "Allow all" then serves `classHtml`
 * for the class page. Berkeley's robots.txt is at a different URL so we must
 * handle both calls in order.
 */
function fakeWithRobots(robotsTxt: string, classHtml: string) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('robots.txt')) {
      return new Response(robotsTxt, { status: 200 });
    }
    return new Response(classHtml, { status: 200 });
  });
}

let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  // Source access is fail-closed. Every fetch-positive test opts in explicitly.
  process.env.KILL_SWITCH = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env.KILL_SWITCH;
  else process.env.KILL_SWITCH = originalKillSwitch;
});

// ---------------------------------------------------------------------------
// Kill-switch (AC-6, FR-7)
// ---------------------------------------------------------------------------

describe('fetchClass — source access requires exact KILL_SWITCH=0 (AC-6)', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['one', '1'],
    ['boolean-like', 'true'],
    ['multi-character numeric', '11'],
    ['whitespace-padded zero', ' 0 '],
    ['whitespace-padded one', ' 1 '],
  ])('%s KILL_SWITCH fails closed with zero source calls', async (_case, value) => {
    if (value === undefined) delete process.env.KILL_SWITCH;
    else process.env.KILL_SWITCH = value;
    const fetchImpl = vi.fn();

    const result = await fetchClass(CK, { fetchImpl });

    expect(result).toMatchObject({
      kind: 'parser-broke',
      classKey: CK,
      detail: expect.stringContaining('kill-switch'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exact KILL_SWITCH=0 permits source fetching', async () => {
    process.env.KILL_SWITCH = '0';
    const fetchImpl = fakeWithRobots('User-agent: *\nAllow: /', loadFixture('open-seats.html'));

    const result = await fetchClass(CK, { fetchImpl });

    expect(isSeatState(result)).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes(`/content/${CK}`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Successful parse with open-seats fixture
// ---------------------------------------------------------------------------

describe('fetchClass — successful parse with open-seats fixture', () => {
  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
    vi.restoreAllMocks();
  });

  it('returns a SeatState for the open-seats fixture', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('open-seats.html');
    const result = await fetchClass(CK, { fetchImpl: fakeHttp200(html) });
    expect(isSeatState(result)).toBe(true);
  });

  it('returns openSeats=3 and status=open from the open-seats fixture', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('open-seats.html');
    const result = await fetchClass(CK, { fetchImpl: fakeHttp200(html) });
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('open');
    expect(result.openSeats).toBe(3);
    expect(result.classKey).toBe(CK);
  });

  it('returns status=closed and openSeats=0 for the zero-seats fixture', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('zero-seats.html');
    const result = await fetchClass(CK, { fetchImpl: fakeHttp200(html) });
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('closed');
    expect(result.openSeats).toBe(0);
  });

  it('returns status=waitlist for the waitlist-open fixture', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('waitlist-open.html');
    const result = await fetchClass(CK, { fetchImpl: fakeHttp200(html) });
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('waitlist');
    expect(result.waitlistOpen).toBe(true);
  });

  it('returns parser-broke for the changed-shape fixture (AC-5)', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('changed-shape.html');
    const result = await fetchClass(CK, { fetchImpl: fakeHttp200(html) });
    expect(isParserBroke(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe('fetchClass — network errors', () => {
  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
    delete process.env.FETCH_TIMEOUT_MS;
    delete process.env.FETCH_MAX_BODY_BYTES;
    vi.restoreAllMocks();
  });

  it('with onNetworkError="return-broke" a network error returns parser-broke', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const result = await fetchClass(CK, {
      fetchImpl: fakeNetworkError('connection refused'),
      onNetworkError: 'return-broke',
    });
    expect(isParserBroke(result)).toBe(true);
  });

  it('parser-broke from network error has a non-empty, non-HTML detail', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const result = await fetchClass(CK, {
      fetchImpl: fakeNetworkError('connection refused'),
      onNetworkError: 'return-broke',
    });
    if (!isParserBroke(result)) throw new Error('expected parser-broke');
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail).not.toMatch(/<[^>]+>/);
  });

  it('with onNetworkError="throw" a network error throws a FetchError', async () => {
    process.env.RESPECT_ROBOTS = '0';
    await expect(
      fetchClass(CK, {
        fetchImpl: fakeNetworkError('timeout'),
        onNetworkError: 'throw',
      }),
    ).rejects.toBeInstanceOf(FetchError);
  });

  it.each([
    ['network rejection', fakeNetworkError('connection reset')],
    ['transient HTTP response', fakeHttpStatus(503)],
  ])('defaults to throwing FetchError for a %s', async (_case, fetchImpl) => {
    process.env.RESPECT_ROBOTS = '0';
    await expect(fetchClass(CK, { fetchImpl })).rejects.toBeInstanceOf(FetchError);
  });

  it('applies FETCH_TIMEOUT_MS through class response-body consumption', async () => {
    process.env.RESPECT_ROBOTS = '0';
    process.env.FETCH_TIMEOUT_MS = '10';
    const stalledResponse = {
      status: 200,
      text: () => new Promise<string>(() => undefined),
    } as Response;
    const fetchImpl = vi.fn().mockResolvedValue(stalledResponse);

    const error = await fetchClass(CK, { fetchImpl }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).detail).toContain('timed out');
  });

  it('rejects a class response body beyond the configured byte ceiling', async () => {
    process.env.RESPECT_ROBOTS = '0';
    process.env.FETCH_MAX_BODY_BYTES = '16';
    const { response, cancel } = cancellableResponse(200, {
      headers: { 'content-length': '17' },
    });

    await expect(
      fetchClass(CK, { fetchImpl: vi.fn().mockResolvedValue(response) }),
    ).rejects.toMatchObject({
      name: 'FetchError',
      detail: expect.stringContaining('response limit'),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the unread body before returning class-gone for a 404', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const { response, cancel } = cancellableResponse(404);

    const result = await fetchClass(CK, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    expect(isClassGone(result)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds cancellation of an unread non-200 body by the active fetch deadline', async () => {
    vi.useFakeTimers();
    process.env.RESPECT_ROBOTS = '0';
    process.env.FETCH_TIMEOUT_MS = '10';
    const { response, cancel } = cancellableResponse(503, {
      onCancel: () => new Promise<void>(() => undefined),
    });

    try {
      const resultPromise = fetchClass(CK, {
        fetchImpl: vi.fn().mockResolvedValue(response),
        onNetworkError: 'return-broke',
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(resultPromise).resolves.toMatchObject({ kind: 'parser-broke' });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-13: a 404 returns class-gone (NOT parser-broke) so the worker retires the watch', async () => {
    // v0.3 split (D8): a 404 is EXPECTED lifecycle (cancelled section / ended
    // term), distinct from a 200-but-unreadable page. It returns the class-gone
    // arm, never parser-broke — so the operator is not paged for a non-bug.
    process.env.RESPECT_ROBOTS = '0';
    const result = await fetchClass(CK, {
      fetchImpl: fakeHttpStatus(404),
      onNetworkError: 'return-broke',
    });
    expect(isClassGone(result)).toBe(true);
    expect(isParserBroke(result)).toBe(false);
  });

  it('a transient 500 with onNetworkError="return-broke" returns parser-broke', async () => {
    // A 5xx is a transient fetch condition, NOT class-gone: under return-broke it
    // surfaces as parser-broke (the page may well still exist).
    process.env.RESPECT_ROBOTS = '0';
    const result = await fetchClass(CK, {
      fetchImpl: fakeHttpStatus(500),
      onNetworkError: 'return-broke',
    });
    expect(isParserBroke(result)).toBe(true);
    expect(isClassGone(result)).toBe(false);
  });

  it('non-200 HTTP response with onNetworkError="throw" throws a FetchError', async () => {
    process.env.RESPECT_ROBOTS = '0';
    await expect(
      fetchClass(CK, {
        fetchImpl: fakeHttpStatus(500),
        onNetworkError: 'throw',
      }),
    ).rejects.toBeInstanceOf(FetchError);
  });

  it('FetchError carries the HTTP status code', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const err = await fetchClass(CK, {
      fetchImpl: fakeHttpStatus(503),
      onNetworkError: 'throw',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(503);
  });

  it('a 429 exposes bounded numeric Retry-After for scheduler backoff', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { 'Retry-After': '17' },
      }),
    );

    const error = await fetchClass(CK, { fetchImpl }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      kind: 'source-rate-limited',
      status: 429,
      retryAfterMs: 17_000,
    });
  });

  it('class-page 403 has the fixed source-forbidden safety classification', async () => {
    process.env.RESPECT_ROBOTS = '0';

    const error = await fetchClass(CK, {
      fetchImpl: fakeHttpStatus(403),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      kind: 'source-forbidden',
      status: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// Cache metadata + conditional requests (FR-3, FR-16, AC-18)
// ---------------------------------------------------------------------------

describe('fetchClassObservation — cache-visible scheduling metadata', () => {
  beforeEach(() => {
    process.env.RESPECT_ROBOTS = '0';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T20:00:00.000Z'));
  });

  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('derives remaining freshness from Cache-Control max-age minus Age', async () => {
    const response = new Response(loadFixture('open-seats.html'), {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=900',
        Age: '600',
        ETag: '"representation-v1"',
        'Last-Modified': 'Thu, 23 Jul 2026 19:45:00 GMT',
      },
    });

    const observation = await fetchClassObservation(CK, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    expect(observation.kind).toBe('result');
    if (observation.kind !== 'result') return;
    expect(observation.cache).toEqual({
      checkedAt: '2026-07-23T20:00:00.000Z',
      cacheControl: 'public, max-age=900',
      ageSeconds: 600,
      maxAgeSeconds: 900,
      freshForSeconds: 300,
      freshUntil: '2026-07-23T20:05:00.000Z',
      etag: '"representation-v1"',
      lastModified: 'Thu, 23 Jul 2026 19:45:00 GMT',
    });
    expect(observation.result).toMatchObject({ fetchedAt: '2026-07-23T20:00:00.000Z' });
  });

  it('sends prior validators and preserves sparse cache metadata on 304', async () => {
    const previousCache: SourceCacheMetadata = {
      checkedAt: '2026-07-23T19:45:00.000Z',
      cacheControl: 'public, max-age=900',
      ageSeconds: 0,
      maxAgeSeconds: 900,
      freshForSeconds: 900,
      freshUntil: '2026-07-23T20:00:00.000Z',
      etag: '"representation-v1"',
      lastModified: 'Thu, 23 Jul 2026 19:45:00 GMT',
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));

    const observation = await fetchClassObservation(CK, {
      fetchImpl,
      previousCache,
    });

    expect(observation).toMatchObject({
      kind: 'not-modified',
      classKey: CK,
      checkedAt: '2026-07-23T20:00:00.000Z',
      cache: {
        cacheControl: 'public, max-age=900',
        maxAgeSeconds: 900,
        freshForSeconds: 900,
        etag: '"representation-v1"',
        lastModified: 'Thu, 23 Jul 2026 19:45:00 GMT',
      },
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'If-None-Match': '"representation-v1"',
      'If-Modified-Since': 'Thu, 23 Jul 2026 19:45:00 GMT',
    });
    expect(init.redirect).toBe('manual');
  });

  it('treats no-store as immediately stale even when max-age is present', async () => {
    const response = new Response(loadFixture('open-seats.html'), {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=900, no-store', Age: '10' },
    });
    const observation = await fetchClassObservation(CK, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    expect(observation.kind).toBe('result');
    if (observation.kind !== 'result') return;
    expect(observation.cache).toMatchObject({
      maxAgeSeconds: 900,
      ageSeconds: 10,
      freshForSeconds: 0,
      freshUntil: '2026-07-23T20:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Manual redirect safety (FR-16, AC-17)
// ---------------------------------------------------------------------------

describe('fetchClassObservation — bounded same-origin redirects', () => {
  beforeEach(() => {
    process.env.RESPECT_ROBOTS = '0';
  });

  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
    vi.restoreAllMocks();
  });

  it('follows up to three exact-origin HTTPS redirects manually', async () => {
    const locations = [`/content/${CK}/alias-one`, `/content/${CK}/alias-two`, `/content/${CK}`];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: locations[0] } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { Location: locations[1] } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Location: locations[2] } }),
      )
      .mockResolvedValueOnce(new Response(loadFixture('open-seats.html'), { status: 200 }));

    const observation = await fetchClassObservation(CK, { fetchImpl });

    expect(observation.kind).toBe('result');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe('manual');
    }
  });

  it.each([
    'http://classes.berkeley.edu/content/target',
    'https://evil.example/content/target',
    'https://classes.berkeley.edu/content/target?cache-bust=1',
    'https://user:pass@classes.berkeley.edu/content/target',
  ])('rejects an unsafe redirect before requesting it: %s', async (location) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: location },
      }),
    );

    await expect(fetchClassObservation(CK, { fetchImpl })).rejects.toMatchObject({
      name: 'FetchError',
      detail: expect.stringContaining('redirect target was rejected'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a fourth redirect without making a fifth request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: `/content/${CK}` },
      }),
    );

    await expect(fetchClassObservation(CK, { fetchImpl })).rejects.toMatchObject({
      name: 'FetchError',
      detail: expect.stringContaining('exceeded 3 redirects'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// robots.txt (FR-7)
// ---------------------------------------------------------------------------

describe('fetchClass — robots.txt compliance (FR-7, RFC 9309)', () => {
  beforeEach(() => {
    // The robots decision is memoized in a module-level per-cycle cache. Clear it
    // before each test so one test's robots fetch (e.g. allow-all) cannot leak a
    // cached decision into the next (e.g. the disallow / unreachable cases).
    __clearRobotsCacheForTests();
  });

  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
    delete process.env.FETCH_TIMEOUT_MS;
    delete process.env.FETCH_MAX_BODY_BYTES;
    delete process.env.FETCH_USER_AGENT;
    __clearRobotsCacheForTests();
    vi.restoreAllMocks();
  });

  it('RESPECT_ROBOTS=0 skips the robots.txt fetch entirely (only one fetch call)', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('open-seats.html');
    const spy = fakeHttp200(html);
    await fetchClass(CK, { fetchImpl: spy });
    // Only one fetch call — the class page itself.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('without RESPECT_ROBOTS=0, the fetcher is called for robots.txt first', async () => {
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');
    const spy = fakeWithRobots('User-agent: *\nAllow: /', html);
    await fetchClass(CK, { fetchImpl: spy });
    // First call is to robots.txt, second is to the class page.
    expect(spy).toHaveBeenCalledTimes(2);
    const [firstUrl] = spy.mock.calls[0] as [string];
    expect(firstUrl).toContain('robots.txt');
  });

  it('an explicit Disallow produces a typed persistent-stop safety signal', async () => {
    delete process.env.RESPECT_ROBOTS;
    const robotsTxt = 'User-agent: *\nDisallow: /content/';
    const html = loadFixture('open-seats.html');
    const spy = fakeWithRobots(robotsTxt, html);

    const error = await fetchClass(CK, { fetchImpl: spy }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({
      kind: 'robots-disallow',
    });
    // Class page should NOT have been fetched after robots.txt said no.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('legacy return-broke mode converts an explicit Disallow to parser-broke', async () => {
    const spy = fakeWithRobots(
      'User-agent: *\nDisallow: /content/',
      loadFixture('open-seats.html'),
    );

    const result = await fetchClass(CK, {
      fetchImpl: spy,
      onNetworkError: 'return-broke',
    });

    expect(isParserBroke(result)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('D9/RFC 9309: an unreachable robots.txt is FAIL-CLOSED — the class page is NOT fetched', async () => {
    // v0.3 posture (D9): robots.txt 5xx/unreachable → treat as DISALLOWED and
    // SKIP the class fetch this cycle (no more fail-open). The skip surfaces as
    // parser-broke (the class still exists; the watch must NOT be retired), and
    // the class page is never requested.
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');
    let callCount = 0;
    const spy = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('robots.txt')) throw new Error('robots.txt unreachable');
      return new Response(html, { status: 200 });
    });
    await expect(fetchClass(CK, { fetchImpl: spy })).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'transient',
      detail: expect.stringContaining('robots.txt:'),
    });
    // Fail-closed and backoff-capable: ONLY robots.txt was requested.
    expect(callCount).toBe(1);
  });

  it('D9: a robots.txt 5xx is FAIL-CLOSED — parser-broke, class page skipped', async () => {
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');
    let callCount = 0;
    const spy = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('robots.txt')) return new Response('', { status: 503 });
      return new Response(html, { status: 200 });
    });
    await expect(fetchClass(CK, { fetchImpl: spy })).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'transient',
      detail: expect.stringContaining('server error (503)'),
    });
    expect(callCount).toBe(1);
  });

  it('cancels an unread robots.txt 404 body before allowing the class fetch', async () => {
    const html = loadFixture('open-seats.html');
    const { response, cancel } = cancellableResponse(404);
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('robots.txt')) return response;
      return new Response(html, { status: 200 });
    });

    expect(isSeatState(await fetchClass(CK, { fetchImpl: spy }))).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    'robots.txt %i fails closed with a typed persistent-stop signal',
    async (status) => {
      const html = loadFixture('open-seats.html');
      const { response, cancel } = cancellableResponse(status);
      const spy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('robots.txt')) return response;
        return new Response(html, { status: 200 });
      });

      const error = await fetchClass(CK, { fetchImpl: spy }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({
        kind: 'source-forbidden',
        status,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels an unread robots.txt 5xx body before failing closed', async () => {
    const { response, cancel } = cancellableResponse(503);
    const spy = vi.fn().mockResolvedValue(response);

    await expect(fetchClass(CK, { fetchImpl: spy })).rejects.toBeInstanceOf(FetchError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('can convert a transient robots failure to parser-broke only under the explicit legacy policy', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('robots unavailable'));

    const result = await fetchClass(CK, {
      fetchImpl: spy,
      onNetworkError: 'return-broke',
    });

    expect(result).toMatchObject({
      kind: 'parser-broke',
      classKey: CK,
      detail: expect.stringContaining('robots.txt:'),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('D9: a robots.txt 404 means crawling allowed — the class page IS fetched', async () => {
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');
    let callCount = 0;
    const spy = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('robots.txt')) return new Response('', { status: 404 });
      return new Response(html, { status: 200 });
    });
    const result = await fetchClass(CK, { fetchImpl: spy });
    // robots 404 = no rules apply = ALLOWED → the class page is fetched + parsed.
    expect(isSeatState(result)).toBe(true);
    expect(callCount).toBe(2);
  });

  it('the robots fixtures drive the allow/disallow decision deterministically', async () => {
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');

    // allow-all → class page fetched.
    __clearRobotsCacheForTests();
    const allow = fakeWithRobots(loadFixture('robots-allow-all.txt'), html);
    expect(isSeatState(await fetchClass(CK, { fetchImpl: allow }))).toBe(true);

    // disallow /content/ → skipped (parser-broke).
    __clearRobotsCacheForTests();
    const disallow = fakeWithRobots(loadFixture('robots-disallow-content.txt'), html);
    expect(
      isParserBroke(
        await fetchClass(CK, {
          fetchImpl: disallow,
          onNetworkError: 'return-broke',
        }),
      ),
    ).toBe(true);
  });

  it.each(['robots-comment-midgroup.txt', 'robots-multi-agent.txt'])(
    'honors grouped rules in %s',
    async (fixture) => {
      const html = loadFixture('open-seats.html');
      const spy = fakeWithRobots(loadFixture(fixture), html);

      const result = await fetchClass(CK, {
        fetchImpl: spy,
        onNetworkError: 'return-broke',
      });

      expect(isParserBroke(result)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps rules in the same group across an empty line', async () => {
    const html = loadFixture('open-seats.html');
    const spy = fakeWithRobots('User-agent: *\n\nDisallow: /content/', html);

    const result = await fetchClass(CK, {
      fetchImpl: spy,
      onNetworkError: 'return-broke',
    });

    expect(result).toMatchObject({ kind: 'parser-broke', classKey: CK });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('uses the longest matching rule and lets a more-specific Allow override Disallow', async () => {
    const html = loadFixture('open-seats.html');
    const robotsTxt = [
      'User-agent: *',
      'Disallow: /content/',
      'Allow: /content/2026-fall-compsci-189-',
    ].join('\n');
    const spy = fakeWithRobots(robotsTxt, html);

    const result = await fetchClass(CK, { fetchImpl: spy });

    expect(isSeatState(result)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('supports wildcard rules with an end-of-path anchor', async () => {
    const html = loadFixture('open-seats.html');

    const matching = fakeWithRobots('User-agent: *\nDisallow: /content/*-001$', html);
    expect(
      isParserBroke(
        await fetchClass(CK, {
          fetchImpl: matching,
          onNetworkError: 'return-broke',
        }),
      ),
    ).toBe(true);
    expect(matching).toHaveBeenCalledTimes(1);

    __clearRobotsCacheForTests();
    const nonMatching = fakeWithRobots('User-agent: *\nDisallow: /content/*-189$', html);
    expect(isSeatState(await fetchClass(CK, { fetchImpl: nonMatching }))).toBe(true);
    expect(nonMatching).toHaveBeenCalledTimes(2);
  });

  it('handles a wildcard-heavy policy deterministically without dynamic regular expressions', async () => {
    const html = loadFixture('open-seats.html');
    const wildcardHeavyPattern = `/content/${'*a'.repeat(900)}z$`;
    const spy = fakeWithRobots(`User-agent: *\nDisallow: ${wildcardHeavyPattern}`, html);

    const result = await fetchClass(CK, { fetchImpl: spy });

    expect(isSeatState(result)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a robots wildcard pattern exceeds the bounded parser limit', async () => {
    const html = loadFixture('open-seats.html');
    const oversizedPattern = `/content/${'*'.repeat(2049)}`;
    const spy = fakeWithRobots(`User-agent: *\nDisallow: ${oversizedPattern}`, html);

    await expect(fetchClass(CK, { fetchImpl: spy })).rejects.toMatchObject({
      name: 'FetchError',
      detail: expect.stringContaining('policy exceeds parser safety bounds'),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('uses a matching product-agent group instead of the wildcard group', async () => {
    process.env.FETCH_USER_AGENT = 'berkeley-seat-sniper/1 (contact: ops@example.com)';
    const html = loadFixture('open-seats.html');
    const robotsTxt = [
      'User-agent: *',
      'Disallow: /content/',
      '',
      'User-agent: berkeley-seat-sniper',
      'Allow: /content/',
    ].join('\n');
    const spy = fakeWithRobots(robotsTxt, html);

    const result = await fetchClass(CK, { fetchImpl: spy });

    expect(isSeatState(result)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('extracts the leading product token from a contactable User-Agent without a version', async () => {
    process.env.FETCH_USER_AGENT = 'SeatSniper (https://ops.berkeley.edu/bot)';
    const html = loadFixture('open-seats.html');
    const robotsTxt = [
      'User-agent: *',
      'Disallow: /content/',
      '',
      'User-agent: SeatSniper',
      'Allow: /content/',
    ].join('\n');
    const spy = fakeWithRobots(robotsTxt, html);

    expect(isSeatState(await fetchClass(CK, { fetchImpl: spy }))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ignores nonstandard records between consecutive User-agent records', async () => {
    process.env.FETCH_USER_AGENT = 'SeatSniper/1 (https://ops.berkeley.edu/bot)';
    const html = loadFixture('open-seats.html');
    const robotsTxt = [
      'User-agent: SeatSniper',
      'Sitemap: https://classes.berkeley.edu/sitemap.xml',
      'User-agent: OtherBot',
      'Disallow: /content/',
    ].join('\n');
    const spy = fakeWithRobots(robotsTxt, html);

    expect(
      isParserBroke(
        await fetchClass(CK, {
          fetchImpl: spy,
          onNetworkError: 'return-broke',
        }),
      ),
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('decodes percent-encoded unreserved octets before matching rules', async () => {
    const html = loadFixture('open-seats.html');
    const spy = fakeWithRobots('User-agent: *\nDisallow: /content/2026%2Dfall', html);

    expect(
      isParserBroke(
        await fetchClass(CK, {
          fetchImpl: spy,
          onNetworkError: 'return-broke',
        }),
      ),
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled robots.txt response body and fails closed', async () => {
    process.env.FETCH_TIMEOUT_MS = '10';
    const html = loadFixture('open-seats.html');
    const stalledRobots = {
      status: 200,
      text: () => new Promise<string>(() => undefined),
    } as Response;
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('robots.txt')) return stalledRobots;
      return new Response(html, { status: 200 });
    });

    const error = await fetchClass(CK, { fetchImpl: spy }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((error as FetchError).detail).toContain('timed out');
  });

  it('bounds robots.txt bytes before parsing rules', async () => {
    process.env.FETCH_MAX_BODY_BYTES = '16';
    const spy = fakeWithRobots('User-agent: *\nAllow: /\n', loadFixture('open-seats.html'));

    await expect(fetchClass(CK, { fetchImpl: spy })).rejects.toMatchObject({
      name: 'FetchError',
      detail: expect.stringContaining('robots.txt:'),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// URL construction (security — never from page content)
// ---------------------------------------------------------------------------

describe('fetchClass — URL always derived from classKey, never from page content', () => {
  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
  });

  it('the fetch URL contains the canonical classKey path segment', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const html = loadFixture('open-seats.html');
    const spy = fakeHttp200(html);
    await fetchClass(CK, { fetchImpl: spy });
    const [calledUrl] = spy.mock.calls[0] as [string];
    expect(calledUrl).toContain(CK);
    expect(calledUrl).toContain('classes.berkeley.edu/content/');
  });

  it('fetchClass never throws — all errors surface as ParseResult or typed FetchError', async () => {
    process.env.RESPECT_ROBOTS = '0';
    // Even a catastrophic synchronous throw from fetchImpl is caught.
    const spy = vi.fn().mockImplementation(() => {
      throw new TypeError('synthetic crash');
    });
    const result = await fetchClass(CK, {
      fetchImpl: spy,
      onNetworkError: 'return-broke',
    });
    expect(isParserBroke(result)).toBe(true);
  });
});
