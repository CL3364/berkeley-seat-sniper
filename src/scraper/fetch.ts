/**
 * Fetch a Berkeley class page and delegate to `parseClassPage`. Handles network
 * errors, timeouts, non-200 responses, the kill-switch, and robots.txt compliance.
 *
 * Security (untrusted input):
 *   - The URL is constructed ONLY from the canonical classKey — never from page
 *     content or any runtime string derived from fetched HTML.
 *   - We never follow redirects to URLs found in the page body.
 *   - The User-Agent is read from the environment, not from fetched content.
 *
 * Conduct (constitution §"Scraping & monitor conduct"):
 *   - One call to `fetchClass` = one HTTP GET for one class. Fan-out is the
 *     worker's responsibility; this function never loops over subscribers.
 *   - Kill-switch: `KILL_SWITCH=1` makes the function a no-op, returning a
 *     parser-broke signal rather than performing any outbound fetch.
 *   - User-Agent is read from `process.env.FETCH_USER_AGENT` (must identify
 *     the operator with a contactable address; set this in the environment).
 *   - Timeout is read from `process.env.FETCH_TIMEOUT_MS` (default 10 s).
 *   - robots.txt: `RESPECT_ROBOTS=0` disables the check (for dev); any other
 *     value or absence enables it. A disallowed path returns parser-broke so
 *     the worker backs off cleanly.
 *
 * Error model: `fetchClass` never throws. Network errors and non-200 responses
 * are surfaced as a `FetchError` (typed, thrown by the internal `doFetch` helper)
 * which is caught and converted to either a `parser-broke`-style ParseResult OR
 * re-thrown as a `FetchError` for the worker to handle with backoff. The exact
 * behavior is documented on `FetchOptions.onNetworkError`.
 */

import { parseClassPage } from './parse';
import type { ClassKey } from '../shared/class-key';
import type { ParseResult } from '../shared/seat-state';

/** Base URL for public Berkeley class pages (never derived from page content). */
const BERKELEY_CLASS_BASE = 'https://classes.berkeley.edu/content/';

/** robots.txt path for the domain (static constant — not fetched from page). */
const ROBOTS_TXT_URL = 'https://classes.berkeley.edu/robots.txt';

/**
 * Typed error thrown when a network-level or HTTP-level failure occurs.
 * The worker catches this to apply exponential backoff.
 */
export class FetchError extends Error {
  /** HTTP status code, or 0 for network/timeout failures. */
  readonly status: number;
  /** Short operator-safe description. No raw response body, no PII. */
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`FetchError(${status}): ${detail}`);
    this.name = 'FetchError';
    this.status = status;
    this.detail = detail;
  }
}

/** Dependency-injected fetch implementation type. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** Options accepted by `fetchClass`. */
export interface FetchOptions {
  /**
   * Fetch implementation to use. Defaults to the global `fetch`. Inject a stub
   * in tests so the network is never touched.
   */
  fetchImpl?: FetchImpl;

  /**
   * How to surface a network/HTTP failure to the caller:
   *   - `'return-broke'` (default): catch any FetchError and return it as a
   *     parser-broke ParseResult. The worker receives a clean ParseResult union.
   *   - `'throw'`: rethrow FetchError so the worker can apply its own backoff
   *     policy and choose its own retry timing.
   */
  onNetworkError?: 'return-broke' | 'throw';
}

/**
 * Fetch the public Berkeley class page for `classKey` and parse it.
 *
 * The URL is built as `https://classes.berkeley.edu/content/<classKey>` — always
 * from the canonical key, never from page content (security: no SSRF via
 * attacker-controlled content).
 *
 * Returns a `ParseResult`: either a `SeatState` on success or a `ParserBroke`
 * on any failure (parse error, network error when `onNetworkError='return-broke'`,
 * kill-switch active, robots.txt disallowed).
 *
 * Throws `FetchError` only when `onNetworkError='throw'` is set.
 *
 * @param classKey  Canonical class key. URL is derived solely from this value.
 * @param opts      Optional overrides for testability and error policy.
 */
export async function fetchClass(
  classKey: ClassKey,
  opts: FetchOptions = {},
): Promise<ParseResult> {
  const { fetchImpl = fetch, onNetworkError = 'return-broke' } = opts;

  // --- Kill-switch ------------------------------------------------------------
  if (process.env.KILL_SWITCH === '1') {
    return {
      kind: 'parser-broke',
      classKey,
      detail: 'kill-switch active: outbound fetch suppressed',
    };
  }

  // Build the target URL from the canonical key ONLY — never from page content.
  // The classKey has already been validated against CLASS_KEY_PATTERN, so it
  // only contains [a-z0-9-] — safe to interpolate directly into the URL path.
  const targetUrl = `${BERKELEY_CLASS_BASE}${classKey}`;

  // --- robots.txt check -------------------------------------------------------
  const respectRobots = process.env.RESPECT_ROBOTS !== '0';
  if (respectRobots) {
    const robotsResult = await checkRobots(targetUrl, fetchImpl);
    if (!robotsResult.allowed) {
      return {
        kind: 'parser-broke',
        classKey,
        detail: `robots.txt disallows this path: ${robotsResult.reason}`,
      };
    }
  }

  // --- Fetch the class page ---------------------------------------------------
  try {
    const html = await doFetch(targetUrl, classKey, fetchImpl);
    return parseClassPage(html, classKey);
  } catch (err) {
    if (err instanceof FetchError) {
      if (onNetworkError === 'throw') throw err;
      return {
        kind: 'parser-broke',
        classKey,
        detail: err.detail,
      };
    }
    // Unexpected non-FetchError — wrap it so the caller always sees a typed result
    // (or a typed throw), never an unhandled rejection with internals.
    const detail = err instanceof Error ? sanitizeDetail(err.message) : 'unexpected fetch error';
    const wrapped = new FetchError(0, detail);
    if (onNetworkError === 'throw') throw wrapped;
    return { kind: 'parser-broke', classKey, detail };
  }
}

// --- Internal helpers ---------------------------------------------------------

/**
 * Perform the actual HTTP GET with User-Agent and timeout. Returns the response
 * body as text on HTTP 200. Throws `FetchError` on any other outcome.
 *
 * This is the only place an outbound request is made. It accepts only a URL
 * constructed by `fetchClass` from the canonical key — never a URL from page
 * content.
 */
async function doFetch(url: string, classKey: ClassKey, fetchImpl: FetchImpl): Promise<string> {
  const timeoutMs = parseTimeoutMs(process.env.FETCH_TIMEOUT_MS, 10_000);
  const userAgent =
    process.env.FETCH_USER_AGENT ?? 'berkeley-seat-sniper/1 (contact: operator@example.com)';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    // AbortError = timeout; other = network failure.
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    throw new FetchError(
      0,
      isTimeout
        ? `request timed out after ${timeoutMs}ms for ${classKey}`
        : `network error for ${classKey}: ${sanitizeDetail(err instanceof Error ? err.message : String(err))}`,
    );
  }
  clearTimeout(timer);

  if (response.status !== 200) {
    throw new FetchError(response.status, `non-200 response (${response.status}) for ${classKey}`);
  }

  return response.text();
}

/**
 * Minimalist robots.txt check. Fetches the file once per call (caching is the
 * worker's responsibility — it controls poll cadence). Parses only `Disallow`
 * directives for `User-agent: *` and the specific user-agent. Returns
 * `{ allowed: true }` on any fetch error (fail-open: prefer a polite retry
 * over silently dropping a real opening). The path checked is the class content
 * path, not any URL derived from page content.
 */
async function checkRobots(
  targetUrl: string,
  fetchImpl: FetchImpl,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const targetPath = new URL(targetUrl).pathname;

  let robotsTxt: string;
  try {
    const resp = await fetchImpl(ROBOTS_TXT_URL, {
      method: 'GET',
      headers: {
        'User-Agent':
          process.env.FETCH_USER_AGENT ?? 'berkeley-seat-sniper/1 (contact: operator@example.com)',
      },
    });
    if (!resp.ok) return { allowed: true }; // fail-open on non-200
    robotsTxt = await resp.text();
  } catch {
    return { allowed: true }; // fail-open on network error
  }

  const userAgent = (process.env.FETCH_USER_AGENT ?? '').split('/')[0].toLowerCase();
  const disallowedPaths = parseRobotsTxt(robotsTxt, userAgent);

  for (const disallowed of disallowedPaths) {
    if (disallowed && targetPath.startsWith(disallowed)) {
      return { allowed: false, reason: `path matches Disallow: ${disallowed}` };
    }
  }
  return { allowed: true };
}

/**
 * Extract Disallow paths from robots.txt for the given agent name and `*`.
 * Pure string parsing — no evaluation of page content, no URL construction
 * from parsed lines beyond the static `ROBOTS_TXT_URL` already used.
 */
function parseRobotsTxt(content: string, agentName: string): string[] {
  const disallowed: string[] = [];
  let applies = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') {
      applies = false;
      continue;
    }
    const [field, ...rest] = line.split(':');
    if (!field) continue;
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase() === agentName;
    } else if (key === 'disallow' && applies && value) {
      disallowed.push(value);
    }
  }

  return disallowed;
}

/** Parse the FETCH_TIMEOUT_MS env var, returning `fallback` on invalid input. */
function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Truncate and strip control characters from an error message so it is safe
 * to embed in a short operator `detail` string. Never includes raw HTML body.
 */
function sanitizeDetail(msg: string): string {
  // Strip C0 control characters and DEL using Unicode category Cc.
  // Using \p{Cc} avoids embedding literal control-character ranges in the regex.
  return msg.replace(/\p{Cc}/gu, '').slice(0, 120);
}
