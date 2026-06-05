/**
 * Unit tests for fetchClass — spec FR-6, FR-7, AC-6.
 *
 * No real network calls. All tests inject a fake `fetchImpl` via FetchOptions
 * so the live Berkeley site is never touched. The kill-switch and robots.txt
 * paths are exercised by controlling env vars and the fake fetcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchClass, FetchError } from '../../src/scraper/fetch';
import { isParserBroke, isSeatState } from '../../src/shared/seat-state';
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

// ---------------------------------------------------------------------------
// Kill-switch (AC-6, FR-7)
// ---------------------------------------------------------------------------

describe('fetchClass — KILL_SWITCH=1 (AC-6)', () => {
  beforeEach(() => {
    process.env.KILL_SWITCH = '1';
  });

  afterEach(() => {
    delete process.env.KILL_SWITCH;
  });

  it('returns parser-broke when KILL_SWITCH=1 (AC-6)', async () => {
    // fetchImpl must never be called — pass a spy that will fail the test if invoked.
    const spy = vi.fn();
    const result = await fetchClass(CK, { fetchImpl: spy });
    expect(isParserBroke(result)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parser-broke detail mentions the kill-switch', async () => {
    const result = await fetchClass(CK, { fetchImpl: vi.fn() });
    if (!isParserBroke(result)) throw new Error('expected parser-broke');
    expect(result.detail.toLowerCase()).toContain('kill');
  });

  it('classKey is preserved in the parser-broke result', async () => {
    const result = await fetchClass(CK, { fetchImpl: vi.fn() });
    if (!isParserBroke(result)) throw new Error('expected parser-broke');
    expect(result.classKey).toBe(CK);
  });
});

// ---------------------------------------------------------------------------
// Successful parse with open-seats fixture
// ---------------------------------------------------------------------------

describe('fetchClass — successful parse with open-seats fixture', () => {
  afterEach(() => {
    delete process.env.KILL_SWITCH;
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

  it('non-200 HTTP response with onNetworkError="return-broke" returns parser-broke', async () => {
    process.env.RESPECT_ROBOTS = '0';
    const result = await fetchClass(CK, {
      fetchImpl: fakeHttpStatus(404),
      onNetworkError: 'return-broke',
    });
    expect(isParserBroke(result)).toBe(true);
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
});

// ---------------------------------------------------------------------------
// robots.txt (FR-7)
// ---------------------------------------------------------------------------

describe('fetchClass — robots.txt compliance (FR-7)', () => {
  afterEach(() => {
    delete process.env.RESPECT_ROBOTS;
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

  it('Disallowed path in robots.txt returns parser-broke (not a hard error)', async () => {
    delete process.env.RESPECT_ROBOTS;
    const robotsTxt = 'User-agent: *\nDisallow: /content/';
    const html = loadFixture('open-seats.html');
    const spy = fakeWithRobots(robotsTxt, html);
    const result = await fetchClass(CK, { fetchImpl: spy });
    expect(isParserBroke(result)).toBe(true);
    // Class page should NOT have been fetched after robots.txt said no.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('robots.txt fetch failure is fail-open — the class page is still fetched', async () => {
    delete process.env.RESPECT_ROBOTS;
    const html = loadFixture('open-seats.html');
    let callCount = 0;
    const spy = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('robots.txt')) throw new Error('robots.txt unreachable');
      return new Response(html, { status: 200 });
    });
    const result = await fetchClass(CK, { fetchImpl: spy });
    // Fail-open: the class page was still fetched despite the robots error.
    expect(isSeatState(result)).toBe(true);
    expect(callCount).toBe(2);
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
