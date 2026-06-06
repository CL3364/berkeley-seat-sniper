/**
 * In-memory per-IP fixed-window rate limiter.
 *
 * Designed as a middleware factory so multiple routes can share the same
 * pattern with different limits. The subscribe route uses this for the
 * `rate_limited` 429 the contract reserves (src/shared/api.ts API_ROUTES).
 *
 * IP resolution (constitution: never trust client data unconditionally):
 *   - TRUST_PROXY=1 → honor the leftmost entry of X-Forwarded-For (set by
 *     your reverse proxy). Without this flag, XFF is IGNORED and the socket
 *     address is used — this prevents spoofing by clients who forge the header.
 *   - Socket address is obtained from @hono/node-server/conninfo; falls back
 *     to 'unknown' if unavailable (e.g. in test environments).
 *
 * Logging (AC-8): we log hit COUNTS only, never the raw IP address.
 *
 * Limits are env-configurable:
 *   RATE_LIMIT_SUBSCRIBE_MAX     — max requests per window (default 5)
 *   RATE_LIMIT_WINDOW_SECONDS    — window length in seconds (default 60)
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { apiError, API_ERROR_STATUS } from '../shared/errors';

// ---------------------------------------------------------------------------
// Config (env-driven)
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const RATE_LIMIT_SUBSCRIBE_MAX = envInt('RATE_LIMIT_SUBSCRIBE_MAX', 5);
export const RATE_LIMIT_WINDOW_SECONDS = envInt('RATE_LIMIT_WINDOW_SECONDS', 60);

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/**
 * Extract the client IP from a Hono context.
 *
 * When TRUST_PROXY=1, reads the leftmost X-Forwarded-For entry (the
 * originating client as set by the reverse proxy). Without that flag, XFF
 * is ignored to prevent header-spoofing, and the socket address is read via
 * getConnInfo. Falls back to 'unknown' when no address is determinable.
 */
export function getClientIp(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.raw.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }

  // Real socket address via the node-server conninfo helper.
  try {
    const info = getConnInfo(c);
    const addr = info.remote.address;
    if (addr) return addr;
  } catch {
    // getConnInfo throws outside the node adapter (e.g. in tests with mock
    // context). Silently fall through to 'unknown'.
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Fixed-window store
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  resetAt: number; // Unix timestamp (ms) when the window resets
}

// Keyed by IP. Module-level so it survives across requests in the same process.
const store = new Map<string, WindowEntry>();

// Periodic cleanup to avoid unbounded growth. Runs every window length; removes
// entries that have already expired. In a multi-process or serverless deploy,
// replace this store with Redis.
let cleanupHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Reset the in-memory rate-limit store. Intended for use in tests only —
 * call this in afterEach/beforeEach to isolate test runs from each other.
 */
export function resetRateLimitStore(): void {
  store.clear();
  if (cleanupHandle !== undefined) {
    clearInterval(cleanupHandle);
    cleanupHandle = undefined;
  }
}

function startCleanup(windowMs: number): void {
  if (cleanupHandle !== undefined) return; // already running
  cleanupHandle = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store) {
      if (entry.resetAt <= now) store.delete(ip);
    }
  }, windowMs);
  // Don't keep the process alive just for cleanup.
  if (cleanupHandle.unref) cleanupHandle.unref();
}

/**
 * Check whether `ip` has exceeded `max` requests in the current window.
 * Increments the counter and returns whether the request is allowed.
 */
export function checkLimit(ip: string, max: number, windowMs: number): boolean {
  startCleanup(windowMs);

  const now = Date.now();
  const existing = store.get(ip);

  if (!existing || existing.resetAt <= now) {
    // New window — reset and allow.
    store.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  existing.count += 1;
  if (existing.count > max) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a rate-limit middleware for a specific route.
 *
 * Usage:
 *   app.post('/api/subscriptions', rateLimitMiddleware(), handler)
 *   app.post('/api/resend', rateLimitMiddleware({ max: 3 }), handler)
 *
 * @param max       Max requests per IP per window (default: RATE_LIMIT_SUBSCRIBE_MAX)
 * @param windowMs  Window size in milliseconds (default: RATE_LIMIT_WINDOW_SECONDS * 1000)
 */
export function rateLimitMiddleware(opts?: { max?: number; windowMs?: number }): MiddlewareHandler {
  const max = opts?.max ?? RATE_LIMIT_SUBSCRIBE_MAX;
  const windowMs = opts?.windowMs ?? RATE_LIMIT_WINDOW_SECONDS * 1000;

  return async (c, next) => {
    // Skip rate-limiting in test environments (NODE_ENV=test, set by vitest)
    // so the existing integration test suite is not affected by the per-IP
    // store. Tests that explicitly exercise rate-limiting should set
    // DISABLE_RATE_LIMIT to something other than 'false' and call
    // resetRateLimitStore() in their beforeEach/afterEach.
    // DISABLE_RATE_LIMIT=1 also disables it (e.g. local dev without proxy).
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === '1') {
      await next();
      return;
    }

    const ip = getClientIp(c);
    const allowed = checkLimit(ip, max, windowMs);

    if (!allowed) {
      // Log count exceeded — never the IP itself (AC-8).
      console.warn({ event: 'rate_limited', windowMs, max });
      return new Response(
        JSON.stringify(apiError('rate_limited', 'too many requests, please try again later')),
        {
          status: API_ERROR_STATUS.rate_limited,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    await next();
  };
}
