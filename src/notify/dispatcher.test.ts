import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassKey } from '../shared/class-key';
import { createMailDispatcher } from './dispatcher';
import { createNoopTransport } from './transports/noop';
import { createFakePushTransport } from './transports/push';
import type {
  MailDispatchJob,
  ProviderOutcome,
  PushDeps,
  Transport,
  TransportMessage,
} from './types';

const CLASS_KEY = '2030-fall-compsci-189-001-lec-001' as ClassKey;
const CREATED_AT = new Date('2030-07-01T12:00:00.000Z');
const OPENED_AT = new Date('2030-07-01T12:01:00.000Z');
const TOKEN_SECRET = 'dispatcher-test-secret-at-least-32-characters';

function job(kind: MailDispatchJob['kind'], suffix: string = kind): MailDispatchJob {
  const alert = kind === 'alert';
  return {
    id: `job-${suffix}`,
    claimToken: `claim-${suffix}`,
    kind,
    subscriberId: kind === 'operator' ? null : `subscriber-${suffix}`,
    email: kind === 'operator' ? null : `${suffix}@berkeley.edu`,
    subscriberConfirmed: kind === 'operator' ? null : kind !== 'confirmation',
    classKey: alert ? CLASS_KEY : null,
    openedAt: alert ? new Date(OPENED_AT) : null,
    reason: alert ? 'seats-open' : null,
    attempts: 1,
    expiresAt: alert ? new Date(OPENED_AT.getTime() + 60 * 60_000) : null,
    providerIdempotencyKey: `seat-sniper/${kind}/${suffix}`,
    payload: alert ? { openSeats: 2 } : kind === 'operator' ? { detail: 'test' } : {},
    createdAt: new Date(CREATED_AT),
  };
}

function recordingTransport(outcome: ProviderOutcome): Transport & {
  messages: TransportMessage[];
} {
  const messages: TransportMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push({
        ...message,
        ...(message.headers ? { headers: { ...message.headers } } : {}),
      });
      return outcome;
    },
  };
}

beforeEach(() => {
  process.env.TOKEN_SECRET = TOKEN_SECRET;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-07-01T12:02:00.000Z'));
});

afterEach(() => {
  delete process.env.TOKEN_SECRET;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startup token-minter safety', () => {
  it.each([
    ['missing', undefined],
    ['short', 'short'],
  ] as const)(
    'rejects an injected unbranded real transport with a %s default TOKEN_SECRET',
    (_name, secret) => {
      if (secret === undefined) delete process.env.TOKEN_SECRET;
      else process.env.TOKEN_SECRET = secret;

      expect(() =>
        createMailDispatcher({
          transport: recordingTransport({
            status: 'success',
            acceptedAt: new Date(),
          }),
          push: null,
        }),
      ).toThrow(/TOKEN_SECRET/);
    },
  );

  it('accepts an injected unbranded real transport with a strong default TOKEN_SECRET', () => {
    expect(() =>
      createMailDispatcher({
        transport: recordingTransport({
          status: 'success',
          acceptedAt: new Date(),
        }),
        push: null,
      }),
    ).not.toThrow();
  });

  it('keeps the explicitly branded noop transport exempt from the startup probe', () => {
    delete process.env.TOKEN_SECRET;

    expect(() =>
      createMailDispatcher({
        transport: createNoopTransport(),
        push: null,
      }),
    ).not.toThrow();
  });

  it('lets an explicit token minter own the seam and invokes it only for a job', async () => {
    delete process.env.TOKEN_SECRET;
    const transport = recordingTransport({
      status: 'success',
      acceptedAt: new Date(),
    });
    const mintToken = vi.fn((subscriberId: string, issuedAt: Date) => {
      return `injected-${subscriberId}-${issuedAt.toISOString()}`;
    });

    const dispatcher = createMailDispatcher({
      transport,
      appBaseUrl: 'https://seats.example.com',
      isSuppressed: async () => false,
      mintToken,
      push: null,
    });
    expect(mintToken).not.toHaveBeenCalled();

    await expect(
      dispatcher.dispatch(job('confirmation', 'injected-minter')),
    ).resolves.toMatchObject({
      status: 'success',
    });
    expect(mintToken).toHaveBeenCalledOnce();
    expect(mintToken).toHaveBeenCalledWith('subscriber-injected-minter', CREATED_AT);
    expect(transport.messages[0]?.body).toContain('injected-subscriber-injected-minter');
  });

  it('maps an explicit token-minter failure to retryable without provider egress', async () => {
    delete process.env.TOKEN_SECRET;
    const transport = recordingTransport({
      status: 'success',
      acceptedAt: new Date(),
    });
    const dispatcher = createMailDispatcher({
      transport,
      isSuppressed: async () => false,
      mintToken: () => {
        throw new Error('injected minter unavailable');
      },
      push: null,
    });

    await expect(dispatcher.dispatch(job('manage-link', 'minter-failure'))).resolves.toEqual({
      status: 'retryable',
      errorCode: 'token_mint_failed',
    });
    expect(transport.messages).toHaveLength(0);
  });
});

describe('durable retry payloads', () => {
  it.each(['alert', 'confirmation', 'manage-link'] as const)(
    'reproduces byte-identical %s mail after a delayed retry',
    async (kind) => {
      const transport = recordingTransport({
        status: 'retryable',
        errorCode: 'provider_unavailable',
      });
      const makeDispatcher = () =>
        createMailDispatcher({
          transport,
          appBaseUrl: 'https://seats.example.com',
          isSuppressed: async () => false,
          push: null,
        });
      const durableJob = job(kind);

      expect((await makeDispatcher().dispatch(durableJob)).status).toBe('retryable');
      vi.advanceTimersByTime(10 * 60_000);
      expect((await makeDispatcher().dispatch({ ...durableJob, attempts: 2 })).status).toBe(
        'retryable',
      );

      expect(transport.messages).toHaveLength(2);
      expect(transport.messages[1]).toEqual(transport.messages[0]);
      expect(transport.messages[0]?.idempotencyKey).toBe(durableJob.providerIdempotencyKey);
    },
  );

  it('passes the durable timestamp to an injected token minter on every retry', async () => {
    const transport = recordingTransport({
      status: 'retryable',
      errorCode: 'provider_unavailable',
    });
    const mintToken = vi.fn((subscriberId: string, issuedAt: Date) => {
      return `${subscriberId}-${issuedAt.toISOString()}`;
    });
    const dispatcher = createMailDispatcher({
      transport,
      appBaseUrl: 'https://seats.example.com',
      isSuppressed: async () => false,
      mintToken,
      push: null,
    });
    const durableJob = job('manage-link', 'custom-minter');

    await dispatcher.dispatch(durableJob);
    vi.advanceTimersByTime(5 * 60_000);
    await dispatcher.dispatch({ ...durableJob, attempts: 2 });

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(mintToken.mock.calls[0]?.[1]).toEqual(CREATED_AT);
    expect(mintToken.mock.calls[1]?.[1]).toEqual(CREATED_AT);
    expect(transport.messages[1]).toEqual(transport.messages[0]);
  });

  it('sends claimed Alerts individually with each durable provider key', async () => {
    const sent: TransportMessage[] = [];
    const sendBatch = vi.fn();
    const transport: Transport & { sendBatch: typeof sendBatch } = {
      sendBatch,
      async send(message) {
        sent.push(message);
        return { status: 'success', acceptedAt: new Date() };
      },
    };
    const dispatcher = createMailDispatcher({
      transport,
      appBaseUrl: 'https://seats.example.com',
      isSuppressed: async () => false,
      mintToken: () => 'stable-test-token',
      push: null,
    });
    const jobs = [job('alert', 'individual-a'), job('alert', 'individual-b')];

    const results = await dispatcher.dispatchBatch(jobs);

    expect(results.map((item) => item.result.status)).toEqual(['success', 'success']);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(sent.map((message) => message.idempotencyKey)).toEqual(
      jobs.map((item) => item.providerIdempotencyKey),
    );
  });
});

describe('independent best-effort push', () => {
  it.each([
    { status: 'retryable', errorCode: 'provider_unavailable' } as const,
    {
      status: 'rate-limited',
      errorCode: 'provider_rate_limited',
      retryAfterMs: 2_000,
    } as const,
    { status: 'permanent', errorCode: 'provider_http_422' } as const,
  ])('attempts push when email finishes as $status', async (providerOutcome) => {
    const pushTransport = createFakePushTransport();
    const push: PushDeps = {
      transport: pushTransport,
      async listPushSubscriptions() {
        return [
          {
            endpoint: 'https://push.example.com/subscription',
            keys: { p256dh: 'p256dh', auth: 'auth' },
          },
        ];
      },
      async deletePushSubscriptionIfMatches() {},
    };
    const dispatcher = createMailDispatcher({
      transport: recordingTransport(providerOutcome),
      appBaseUrl: 'https://seats.example.com',
      isSuppressed: async () => false,
      mintToken: () => 'stable-test-token',
      push,
    });

    const result = await dispatcher.dispatch(job('alert', providerOutcome.status));

    expect(result.status).toBe(providerOutcome.status);
    expect(result.pushCompletion).toBeDefined();
    expect(await result.pushCompletion).toBe(1);
    expect(pushTransport.sent).toHaveLength(1);
  });

  it('attempts push even when the suppression lookup makes email retryable', async () => {
    const pushTransport = createFakePushTransport();
    const dispatcher = createMailDispatcher({
      transport: recordingTransport({
        status: 'success',
        acceptedAt: new Date(),
      }),
      isSuppressed: async () => {
        throw new Error('suppression unavailable');
      },
      mintToken: () => 'stable-test-token',
      push: {
        transport: pushTransport,
        async listPushSubscriptions() {
          return [
            {
              endpoint: 'https://push.example.com/subscription',
              keys: { p256dh: 'p256dh', auth: 'auth' },
            },
          ];
        },
        async deletePushSubscriptionIfMatches() {},
      },
    });

    const result = await dispatcher.dispatch(job('alert', 'suppression-retry'));

    expect(result.status).toBe('retryable');
    expect(await result.pushCompletion).toBe(1);
    expect(pushTransport.sent).toHaveLength(1);
  });

  it('does not wait for a hanging push before returning the email outcome', async () => {
    let releasePush!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const dispatcher = createMailDispatcher({
      transport: recordingTransport({
        status: 'retryable',
        errorCode: 'provider_unavailable',
      }),
      appBaseUrl: 'https://seats.example.com',
      isSuppressed: async () => false,
      mintToken: () => 'stable-test-token',
      push: {
        transport: {
          enabled: true,
          async send() {
            await blocked;
            return { ok: true, gone: false };
          },
        },
        async listPushSubscriptions() {
          return [
            {
              endpoint: 'https://push.example.com/subscription',
              keys: { p256dh: 'p256dh', auth: 'auth' },
            },
          ];
        },
        async deletePushSubscriptionIfMatches() {},
      },
    });

    const result = await dispatcher.dispatch(job('alert', 'hanging-push'));
    expect(result.status).toBe('retryable');

    releasePush();
    expect(await result.pushCompletion).toBe(1);
  });
});
