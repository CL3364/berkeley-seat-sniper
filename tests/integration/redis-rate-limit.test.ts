import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { connectRedisRateLimiter } from '../../src/server/rate-limit';

const testRedisUrl = process.env.TEST_REDIS_URL?.trim();
const realRedisIt = testRedisUrl ? it : it.skip;

describe('real Redis rate-limit integration (optional)', () => {
  realRedisIt(
    'shares atomic windows across connections and preserves them across an API-process restart',
    async () => {
      if (!testRedisUrl) return;
      const identifier = `integration-${randomUUID()}@berkeley.edu`;
      const first = await connectRedisRateLimiter(testRedisUrl);
      const second = await connectRedisRateLimiter(testRedisUrl);
      let restarted: Awaited<ReturnType<typeof connectRedisRateLimiter>> | undefined;

      try {
        expect((await first.limiter.consume('email', identifier, 2, 2)).allowed).toBe(true);
        expect((await second.limiter.consume('email', identifier, 2, 2)).allowed).toBe(true);
        await first.close();

        restarted = await connectRedisRateLimiter(testRedisUrl);
        const limited = await restarted.limiter.consume('email', identifier, 2, 2);
        expect(limited.allowed).toBe(false);
        expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        await second.limiter.healthCheck();
        await restarted.limiter.healthCheck();
      } finally {
        await first.close();
        await second.close();
        await restarted?.close();
      }
    },
    20_000,
  );
});
