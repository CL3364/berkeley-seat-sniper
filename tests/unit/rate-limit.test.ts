import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import {
  MemoryRateLimiter,
  PROXY_SECRET_HEADER,
  RedisRateLimiter,
  getClientIp,
  isPrivateProxyAddress,
  readProxyTrustPolicy,
} from '../../src/server/rate-limit';

class AtomicRedisClientFake {
  readonly windows = new Map<string, { count: number; expiresAt: number }>();
  readonly commands: string[][] = [];
  now = 1_000;
  pingReply = 'PONG';

  async sendCommand(command: string[]): Promise<unknown> {
    this.commands.push(command);
    const key = command[3];
    const windowMs = Number(command[4]);
    if (command[0] !== 'EVAL' || !key || !Number.isSafeInteger(windowMs)) {
      throw new Error('unexpected fake Redis command');
    }
    let window = this.windows.get(key);
    if (!window || window.expiresAt <= this.now) {
      window = { count: 0, expiresAt: this.now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return [window.count, window.expiresAt - this.now];
  }

  async ping(): Promise<string> {
    return this.pingReply;
  }
}

describe('atomic rate-limit backends', () => {
  it('shares one Redis window across limiter instances without storing the raw identifier', async () => {
    const client = new AtomicRedisClientFake();
    const first = new RedisRateLimiter(client as never);
    const second = new RedisRateLimiter(client as never);
    const email = 'private-person@berkeley.edu';

    expect(await first.consume('email', email, 2, 60)).toEqual({
      allowed: true,
      retryAfterSeconds: 60,
    });
    expect(await second.consume('email', email, 2, 60)).toEqual({
      allowed: true,
      retryAfterSeconds: 60,
    });
    expect(await first.consume('email', email, 2, 60)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    const wire = JSON.stringify(client.commands);
    expect(wire).not.toContain(email);
    expect([...client.windows.keys()]).toEqual([
      expect.stringMatching(/^seat-sniper:rate-limit:email:[a-f0-9]{64}$/),
    ]);
  });

  it('keeps the first expiry, reports remaining whole seconds, and starts a new window after TTL', async () => {
    const client = new AtomicRedisClientFake();
    const limiter = new RedisRateLimiter(client as never);

    await limiter.consume('ip', '192.0.2.10', 1, 10);
    client.now += 2_500;
    expect(await limiter.consume('ip', '192.0.2.10', 1, 10)).toEqual({
      allowed: false,
      retryAfterSeconds: 8,
    });
    client.now += 7_500;
    expect(await limiter.consume('ip', '192.0.2.10', 1, 10)).toEqual({
      allowed: true,
      retryAfterSeconds: 10,
    });
  });

  it('fails closed on malformed Redis script results or an unhealthy ping', async () => {
    const malformed = {
      sendCommand: async () => ['1', 60_000],
      ping: async () => 'PONG',
    };
    const malformedLimiter = new RedisRateLimiter(malformed as never);
    await expect(malformedLimiter.consume('ip', '192.0.2.20', 1, 60)).rejects.toThrow(
      /invalid rate-limit result/,
    );

    const unhealthy = new AtomicRedisClientFake();
    unhealthy.pingReply = 'NOPE';
    await expect(new RedisRateLimiter(unhealthy as never).healthCheck()).rejects.toThrow(
      /readiness probe failed/,
    );
  });

  it('provides isolated deterministic memory windows for local tests', async () => {
    const limiter = new MemoryRateLimiter();
    expect((await limiter.consume('ip', '203.0.113.5', 1, 60)).allowed).toBe(true);
    expect((await limiter.consume('ip', '203.0.113.5', 1, 60)).allowed).toBe(false);
    limiter.reset();
    expect((await limiter.consume('ip', '203.0.113.5', 1, 60)).allowed).toBe(true);
  });
});

describe('trusted Caddy client-address boundary', () => {
  const proxySecret = 'proxy-secret-for-tests-is-at-least-32-chars';
  const proxyPolicy = readProxyTrustPolicy({
    TRUST_PROXY: '1',
    PROXY_HEADER_SECRET: proxySecret,
  });

  async function resolveAddress(options: {
    direct: string | null;
    forwarded?: string;
    trustProxy: boolean;
    proxySecretValues?: string[];
  }): Promise<string> {
    const app = new Hono();
    app.get('/', (c) =>
      c.text(
        getClientIp(c, {
          trustProxy: options.trustProxy,
          proxySecretDigest: proxyPolicy.proxySecretDigest,
          remoteAddress: () => options.direct,
        }),
      ),
    );
    const headers = new Headers();
    if (options.forwarded) headers.set('X-Forwarded-For', options.forwarded);
    for (const secret of options.proxySecretValues ?? []) {
      headers.append(PROXY_SECRET_HEADER, secret);
    }
    const response = await app.request(
      new Request('http://localhost/', {
        headers,
      }),
    );
    return response.text();
  }

  it('honors only a valid authenticated proxy header from a private direct peer', async () => {
    await expect(
      resolveAddress({
        direct: '172.18.0.4',
        forwarded: '198.51.100.10, 203.0.113.20',
        trustProxy: true,
        proxySecretValues: [proxySecret],
      }),
    ).resolves.toBe('203.0.113.20');
    await expect(
      resolveAddress({
        direct: '198.51.100.2',
        forwarded: '203.0.113.20',
        trustProxy: true,
        proxySecretValues: [proxySecret],
      }),
    ).resolves.toBe('198.51.100.2');
    await expect(
      resolveAddress({
        direct: '172.18.0.4',
        forwarded: '203.0.113.20',
        trustProxy: false,
        proxySecretValues: [proxySecret],
      }),
    ).resolves.toBe('172.18.0.4');
  });

  it.each([
    ['missing', []],
    ['wrong', ['different-proxy-secret-at-least-32-chars']],
    ['malformed', ['short']],
    ['duplicate', [proxySecret, proxySecret]],
  ])('ignores forwarded identity for a %s proxy secret header', async (_name, values) => {
    await expect(
      resolveAddress({
        direct: '172.18.0.4',
        forwarded: '203.0.113.20',
        trustProxy: true,
        proxySecretValues: values,
      }),
    ).resolves.toBe('172.18.0.4');
  });

  it('falls back for malformed forwarding data and normalizes mapped IPv4', async () => {
    await expect(
      resolveAddress({
        direct: '::ffff:172.18.0.4',
        forwarded: 'not-an-ip',
        trustProxy: true,
        proxySecretValues: [proxySecret],
      }),
    ).resolves.toBe('172.18.0.4');
    await expect(
      resolveAddress({
        direct: null,
        forwarded: '203.0.113.20',
        trustProxy: true,
        proxySecretValues: [proxySecret],
      }),
    ).resolves.toBe('unknown');
  });

  it('accepts only private, loopback, or link-local peers as proxy candidates', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.10.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fd00::1',
      '::ffff:172.18.0.4',
    ]) {
      expect(isPrivateProxyAddress(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '172.15.255.255',
      '172.32.0.1',
      '198.51.100.2',
      '2001:db8::1',
      'not-an-ip',
    ]) {
      expect(isPrivateProxyAddress(address), address).toBe(false);
    }
  });
});
