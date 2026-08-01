/**
 * Shared fixed-window abuse limiting (FR-11 / AC-22).
 *
 * Production uses one Redis counter namespace for every API instance. The
 * increment + first-window expiry operation is a single Lua script so two
 * processes cannot both admit the same over-limit request. Development and
 * tests may inject/use the in-memory implementation; production refuses to
 * construct an implicit memory fallback.
 *
 * Counter keys contain only SHA-256 digests. Raw client addresses and subscriber
 * email addresses therefore never enter Redis, heap keys, logs, or metrics.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createClient, type RedisClientType } from 'redis';
import { apiError, API_ERROR_STATUS } from '../shared/errors';

export const PROXY_SECRET_HEADER = 'x-seat-sniper-proxy-secret';
const PROXY_SECRET_MIN_LENGTH = 32;
const PROXY_SECRET_MAX_LENGTH = 256;
const SHA256_DIGEST_BYTES = 32;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Production accepts only the connected Redis implementation. */
  readonly backend?: 'memory' | 'redis' | 'test';
  consume(
    scope: 'email' | 'ip',
    identifier: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision>;
  healthCheck(): Promise<void>;
}

export interface RateLimitConfig {
  subscribeMax: number;
  subscribeWindowSeconds: number;
  emailMax: number;
  emailWindowSeconds: number;
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function readRateLimitConfig(): RateLimitConfig {
  return {
    subscribeMax: envPositiveInteger('RATE_LIMIT_SUBSCRIBE_MAX', 5),
    subscribeWindowSeconds: envPositiveInteger('RATE_LIMIT_WINDOW_SECONDS', 60),
    emailMax: envPositiveInteger('RATE_LIMIT_EMAIL_MAX', 3),
    emailWindowSeconds: envPositiveInteger('RATE_LIMIT_EMAIL_WINDOW_SECONDS', 900),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface MemoryWindow {
  count: number;
  resetAtMs: number;
}

/** Deterministic test/dev limiter; never selected implicitly in production. */
export class MemoryRateLimiter implements RateLimiter {
  readonly backend = 'memory' as const;
  private readonly windows = new Map<string, MemoryWindow>();

  async consume(
    scope: 'email' | 'ip',
    identifier: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const key = `${scope}:${digest(identifier)}`;
    const existing = this.windows.get(key);
    if (!existing || existing.resetAtMs <= now) {
      this.windows.set(key, { count: 1, resetAtMs: now + windowSeconds * 1_000 });
      return { allowed: true, retryAfterSeconds: windowSeconds };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= max,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1_000)),
    };
  }

  async healthCheck(): Promise<void> {
    return Promise.resolve();
  }

  reset(): void {
    this.windows.clear();
  }
}

class PermissiveTestRateLimiter implements RateLimiter {
  readonly backend = 'test' as const;
  async consume(
    _scope: 'email' | 'ip',
    _identifier: string,
    _max: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    return { allowed: true, retryAfterSeconds: windowSeconds };
  }

  async healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export class RedisRateLimiter implements RateLimiter {
  readonly backend = 'redis' as const;

  constructor(private readonly client: RedisClientType) {}

  async consume(
    scope: 'email' | 'ip',
    identifier: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const key = `seat-sniper:rate-limit:${scope}:${digest(identifier)}`;
    const result = await this.client.sendCommand([
      'EVAL',
      INCREMENT_WITH_EXPIRY_SCRIPT,
      '1',
      key,
      String(windowSeconds * 1_000),
    ]);
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== 'number' ||
      typeof result[1] !== 'number'
    ) {
      throw new Error('Redis returned an invalid rate-limit result');
    }
    return {
      allowed: result[0] <= max,
      retryAfterSeconds: Math.max(1, Math.ceil(result[1] / 1_000)),
    };
  }

  async healthCheck(): Promise<void> {
    const result = await this.client.ping();
    if (result !== 'PONG') throw new Error('Redis readiness probe failed');
  }
}

export interface RedisRateLimiterHandle {
  limiter: RedisRateLimiter;
  close(): Promise<void>;
}

/** Connect and verify the production Redis dependency before binding a port. */
export async function connectRedisRateLimiter(redisUrl: string): Promise<RedisRateLimiterHandle> {
  const normalized = redisUrl.trim();
  if (!normalized) throw new Error('REDIS_URL must not be empty');

  const client = createClient({
    url: normalized,
    socket: {
      connectTimeout: envPositiveInteger('REDIS_CONNECT_TIMEOUT_MS', 5_000),
      reconnectStrategy: false,
    },
  });
  // An explicit listener prevents node-redis from treating a later connection
  // fault as an unhandled EventEmitter error. Do not log the error message: it
  // can embed a credential-bearing URL.
  client.on('error', (error: Error) => {
    console.error({ event: 'redis_error', errorName: error.constructor.name });
  });
  await client.connect();
  const limiter = new RedisRateLimiter(client);
  await limiter.healthCheck();
  return {
    limiter,
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}

const defaultMemoryRateLimiter = new MemoryRateLimiter();
const permissiveTestRateLimiter = new PermissiveTestRateLimiter();

/**
 * Resolve the implicit limiter for app construction.
 *
 * Tests normally inject a limiter. Keeping a process-local default outside
 * production preserves a frictionless local server while making a missing
 * REDIS_URL/Redis injection a startup error in production.
 */
export function defaultRateLimiter(): RateLimiter {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('a connected Redis rate limiter is required in production');
  }
  if (process.env.NODE_ENV === 'test') return permissiveTestRateLimiter;
  return defaultMemoryRateLimiter;
}

function socketAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address || null;
  } catch {
    return null;
  }
}

function stripIpv4MappedPrefix(address: string): string {
  return address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
}

/** Only a private/loopback direct peer is eligible to be the trusted Caddy hop. */
export function isPrivateProxyAddress(rawAddress: string): boolean {
  const address = stripIpv4MappedPrefix(rawAddress.trim().toLowerCase());
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  if (family === 6) {
    return address === '::1' || address.startsWith('fc') || address.startsWith('fd');
  }
  return false;
}

export interface ClientIpOptions {
  trustProxy?: boolean;
  /**
   * SHA-256 digest of the shared Caddy→API hop secret. The raw secret is
   * reduced to this fixed-size value at startup and never retained by request
   * middleware.
   */
  proxySecretDigest?: Buffer | null;
  /**
   * Test/adapter hook. Production leaves this unset and reads the direct socket
   * peer from @hono/node-server.
   */
  remoteAddress?(c: Context): string | null;
}

export interface ProxyTrustPolicy {
  trustProxy: boolean;
  proxySecretDigest: Buffer | null;
}

function validProxySecret(value: string): boolean {
  return (
    value.length >= PROXY_SECRET_MIN_LENGTH &&
    value.length <= PROXY_SECRET_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function proxySecretDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Parse the authenticated proxy-hop boundary once at startup.
 *
 * Production must use the bundled authenticated Caddy hop. Standalone
 * development defaults to direct-socket identity and ignores all forwarding
 * headers.
 */
export function readProxyTrustPolicy(env: NodeJS.ProcessEnv = process.env): ProxyTrustPolicy {
  const rawTrustProxy = env.TRUST_PROXY?.trim();
  if (
    rawTrustProxy !== undefined &&
    rawTrustProxy !== '' &&
    rawTrustProxy !== '0' &&
    rawTrustProxy !== '1'
  ) {
    throw new Error('TRUST_PROXY must be exactly 0 or 1');
  }

  const trustProxy = rawTrustProxy === '1';
  if (env.NODE_ENV === 'production' && !trustProxy) {
    throw new Error('TRUST_PROXY=1 is required in production');
  }
  if (!trustProxy) {
    return { trustProxy: false, proxySecretDigest: null };
  }

  const secret = env.PROXY_HEADER_SECRET?.trim();
  if (!secret || !validProxySecret(secret)) {
    throw new Error(
      'PROXY_HEADER_SECRET must be a 32-256 character unpadded base64url value when TRUST_PROXY=1',
    );
  }
  return {
    trustProxy: true,
    proxySecretDigest: proxySecretDigest(secret),
  };
}

function hasAuthenticatedProxyHop(headers: Headers, expectedDigest: Buffer | null | undefined) {
  if (!expectedDigest || expectedDigest.byteLength !== SHA256_DIGEST_BYTES) return false;
  const candidate = headers.get(PROXY_SECRET_HEADER) ?? '';
  const validCandidate = validProxySecret(candidate);
  const candidateDigest = proxySecretDigest(validCandidate ? candidate : '');
  const matches = timingSafeEqual(expectedDigest, candidateDigest);
  return validCandidate && matches;
}

/**
 * Resolve a client address without trusting attacker-supplied forwarding data.
 * X-Forwarded-For is honored only when TRUST_PROXY is enabled, the direct
 * socket peer is private, AND Caddy supplied the authenticated hop header.
 * A private source address alone is deliberately insufficient.
 */
export function getClientIp(c: Context, options: ClientIpOptions = {}): string {
  const directAddress = (options.remoteAddress?.(c) ?? socketAddress(c))?.trim() || null;
  if (
    options.trustProxy &&
    directAddress &&
    isPrivateProxyAddress(directAddress) &&
    hasAuthenticatedProxyHop(c.req.raw.headers, options.proxySecretDigest)
  ) {
    const forwarded = c.req.raw.headers.get('x-forwarded-for');
    const clientAddress = forwarded?.split(',').at(-1)?.trim();
    if (clientAddress && isIP(stripIpv4MappedPrefix(clientAddress)) !== 0) {
      return stripIpv4MappedPrefix(clientAddress);
    }
  }
  return directAddress ? stripIpv4MappedPrefix(directAddress) : 'unknown';
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify(apiError('rate_limited', 'too many requests, please try again later')),
    {
      status: API_ERROR_STATUS.rate_limited,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
      },
    },
  );
}

export interface IpRateLimitMiddlewareOptions extends ClientIpOptions {
  limiter: RateLimiter;
  max: number;
  windowSeconds: number;
}

export function rateLimitMiddleware(options: IpRateLimitMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.DISABLE_RATE_LIMIT === '1') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DISABLE_RATE_LIMIT=1 is forbidden in production');
      }
      await next();
      return;
    }

    const decision = await options.limiter.consume(
      'ip',
      getClientIp(c, options),
      options.max,
      options.windowSeconds,
    );
    if (!decision.allowed) {
      console.warn({
        event: 'rate_limited',
        scope: 'ip',
        windowSeconds: options.windowSeconds,
        max: options.max,
      });
      return rateLimitedResponse(decision.retryAfterSeconds);
    }
    await next();
  };
}

/** Apply the normalized-email window without ever retaining the raw address. */
export async function checkEmailLimit(
  limiter: RateLimiter,
  email: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  if (process.env.DISABLE_RATE_LIMIT === '1') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DISABLE_RATE_LIMIT=1 is forbidden in production');
    }
    return { allowed: true, retryAfterSeconds: windowSeconds };
  }
  return limiter.consume('email', email, max, windowSeconds);
}

/** Backward-compatible test reset; both scopes share this one test/dev store. */
export function resetRateLimitStore(): void {
  defaultMemoryRateLimiter.reset();
}
