import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubscriberCapacityError } from '../db';
import { PILOT_INVITE_CODE_HEADER, type PushKeys, type SuppressionReason } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import {
  ADMISSION_RETRY_AFTER_SECONDS,
  ADMISSION_UNAVAILABLE_MESSAGE,
  RECOVERY_INTERNAL_ERROR_MESSAGE,
  apiError,
} from '../shared/errors';
import {
  admissionAllowsCreate,
  readAdmissionPolicy,
  subscriberLimitForAdmission,
  type AdmissionPolicy,
} from './admission';
import { createApp, type AppRuntimeOptions, type SubscriptionRepo } from './app';
import { MemoryRateLimiter } from './rate-limit';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const VALID_INVITE = 'A'.repeat(43);
const VALID_BODY = {
  email: 'pilot-user@berkeley.edu',
  classKeys: [CLASS_KEY],
};

function policy(mode: 'closed' | 'pilot' | 'public', invite = VALID_INVITE): AdmissionPolicy {
  return readAdmissionPolicy({
    ADMISSION_MODE: mode,
    ...(mode === 'pilot' ? { PILOT_INVITE_CODE: invite } : {}),
  });
}

function repo(overrides: Partial<SubscriptionRepo> = {}): SubscriptionRepo {
  return {
    async createSubscriber(_email, classKeys) {
      return {
        id: 'subscriber-id',
        watches: classKeys,
        watchFreshness: classKeys.map((classKey) => ({
          classKey,
          source: 'public-class-page' as const,
          lastCheckedAt: null,
          sourceStale: true,
          displayName: null,
          openSeats: null,
          enrolled: null,
          capacity: null,
          waitlisted: null,
          waitlistMax: null,
          openReserved: null,
          waitlistOpen: null,
        })),
      };
    },
    async getSubscriberById() {
      return null;
    },
    async addWatch(_subscriberId, classKey) {
      return {
        watches: [classKey],
        watchFreshness: [
          {
            classKey,
            source: 'public-class-page',
            lastCheckedAt: null,
            sourceStale: true,
            displayName: null,
            openSeats: null,
            enrolled: null,
            capacity: null,
            waitlisted: null,
            waitlistMax: null,
            openReserved: null,
            waitlistOpen: null,
          },
        ],
      };
    },
    async removeWatch() {},
    async deleteSubscriber() {},
    async confirmSubscriber() {
      return 'already_confirmed';
    },
    async suppressEmail(_email: string, _reason: SuppressionReason) {},
    async upsertPushSubscription(_subscriberId: string, _endpoint: string, _keys: PushKeys) {},
    async deletePushSubscriptionForSubscriber() {
      return 0;
    },
    async enqueueResendMailByEmail() {
      return { enqueued: false };
    },
    ...overrides,
  };
}

function runtime(admissionPolicy: AdmissionPolicy): AppRuntimeOptions {
  return {
    admissionPolicy,
    rateLimiter: new MemoryRateLimiter(),
    rateLimitConfig: {
      subscribeMax: 1_000,
      subscribeWindowSeconds: 60,
      emailMax: 1_000,
      emailWindowSeconds: 900,
    },
    remoteAddress: () => '127.0.0.1',
  };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function canonicalAdmissionTuple(response: Response): Promise<unknown[]> {
  return [
    response.status,
    response.headers.get('retry-after'),
    response.headers.get('content-type'),
    await response.text(),
  ];
}

afterEach(() => {
  delete process.env.ADMISSION_MODE;
  delete process.env.PILOT_INVITE_CODE;
});

describe('admission configuration and digest comparison', () => {
  it('defaults closed, accepts only the three modes, and requires a valid pilot secret', () => {
    expect(readAdmissionPolicy({}).mode).toBe('closed');
    expect(readAdmissionPolicy({ ADMISSION_MODE: 'closed' }).mode).toBe('closed');
    expect(readAdmissionPolicy({ ADMISSION_MODE: 'public' }).mode).toBe('public');
    expect(() => readAdmissionPolicy({ ADMISSION_MODE: '' })).toThrow(/ADMISSION_MODE/);
    expect(() => readAdmissionPolicy({ ADMISSION_MODE: 'PUBLIC' })).toThrow(/ADMISSION_MODE/);
    expect(() => readAdmissionPolicy({ ADMISSION_MODE: ' pilot ' })).toThrow(/ADMISSION_MODE/);
    expect(() => readAdmissionPolicy({ ADMISSION_MODE: 'pilot' })).toThrow(/PILOT_INVITE_CODE/);
    expect(() =>
      readAdmissionPolicy({
        ADMISSION_MODE: 'pilot',
        PILOT_INVITE_CODE: 'A'.repeat(31),
      }),
    ).toThrow(/PILOT_INVITE_CODE/);
    expect(() =>
      readAdmissionPolicy({
        ADMISSION_MODE: 'pilot',
        PILOT_INVITE_CODE: `${'A'.repeat(31)}=`,
      }),
    ).toThrow(/PILOT_INVITE_CODE/);
    expect(() =>
      readAdmissionPolicy({
        ADMISSION_MODE: 'pilot',
        PILOT_INVITE_CODE: 'A'.repeat(257),
      }),
    ).toThrow(/PILOT_INVITE_CODE/);
  });

  it('retains only a SHA-256 digest and selects the fixed cap only for pilot', () => {
    const pilot = policy('pilot');
    expect(pilot.pilotInviteDigest).toBeInstanceOf(Buffer);
    expect(pilot.pilotInviteDigest).toHaveLength(32);
    expect(JSON.stringify(pilot)).not.toContain(VALID_INVITE);
    expect(subscriberLimitForAdmission(pilot)).toBe(100);
    expect(subscriberLimitForAdmission(policy('closed'))).toBeUndefined();
    expect(subscriberLimitForAdmission(policy('public'))).toBeUndefined();
  });

  it('uses a timing-safe digest decision and bounds malformed candidate work', () => {
    const pilot = policy('pilot');
    expect(admissionAllowsCreate(pilot, VALID_INVITE)).toBe(true);
    expect(admissionAllowsCreate(pilot, 'B'.repeat(43))).toBe(false);
    expect(admissionAllowsCreate(pilot, null)).toBe(false);
    expect(admissionAllowsCreate(pilot, `${'A'.repeat(31)}=`)).toBe(false);
    expect(admissionAllowsCreate(pilot, 'A'.repeat(257))).toBe(false);
    expect(admissionAllowsCreate(policy('closed'), VALID_INVITE)).toBe(false);
    expect(admissionAllowsCreate(policy('public'), 'A'.repeat(10_000))).toBe(true);
  });
});

describe('new subscriber admission boundary', () => {
  it('returns one byte-identical canonical denial for closed, pilot bearer, and full-cap cases', async () => {
    const deniedResponses = await Promise.all([
      post(
        createApp(repo(), undefined, runtime(policy('closed'))),
        '/api/subscriptions',
        VALID_BODY,
        { [PILOT_INVITE_CODE_HEADER]: VALID_INVITE },
      ),
      post(
        createApp(repo(), undefined, runtime(policy('pilot'))),
        '/api/subscriptions',
        VALID_BODY,
      ),
      post(
        createApp(repo(), undefined, runtime(policy('pilot'))),
        '/api/subscriptions',
        VALID_BODY,
        { [PILOT_INVITE_CODE_HEADER]: 'B'.repeat(43) },
      ),
      post(
        createApp(repo(), undefined, runtime(policy('pilot'))),
        '/api/subscriptions',
        VALID_BODY,
        { [PILOT_INVITE_CODE_HEADER]: `${'A'.repeat(31)}=` },
      ),
      post(
        createApp(repo(), undefined, runtime(policy('pilot'))),
        '/api/subscriptions',
        VALID_BODY,
        { [PILOT_INVITE_CODE_HEADER]: 'A'.repeat(257) },
      ),
      post(
        createApp(
          repo({
            async createSubscriber() {
              throw new SubscriberCapacityError(100);
            },
          }),
          undefined,
          runtime(policy('pilot')),
        ),
        '/api/subscriptions',
        VALID_BODY,
        { [PILOT_INVITE_CODE_HEADER]: VALID_INVITE },
      ),
    ]);

    const tuples = await Promise.all(deniedResponses.map(canonicalAdmissionTuple));
    expect(new Set(tuples.map((tuple) => JSON.stringify(tuple))).size).toBe(1);
    expect(tuples[0]).toEqual([
      503,
      String(ADMISSION_RETRY_AFTER_SECONDS),
      'application/json',
      JSON.stringify(apiError('admission_unavailable', ADMISSION_UNAVAILABLE_MESSAGE)),
    ]);
  });

  it('admits the correct pilot bearer without passing it to persistence', async () => {
    const createSubscriber = vi.fn(repo().createSubscriber);
    const app = createApp(repo({ createSubscriber }), undefined, runtime(policy('pilot')));
    const response = await post(app, '/api/subscriptions', VALID_BODY, {
      [PILOT_INVITE_CODE_HEADER]: VALID_INVITE,
    });

    expect(response.status).toBe(202);
    expect(createSubscriber).toHaveBeenCalledTimes(1);
    expect(createSubscriber.mock.calls[0]).toHaveLength(2);
    expect(JSON.stringify(createSubscriber.mock.calls)).not.toContain(VALID_INVITE);
  });

  it('ignores the invite header in public and leaves recovery available while closed', async () => {
    const publicResponse = await post(
      createApp(repo(), undefined, runtime(policy('public'))),
      '/api/subscriptions',
      VALID_BODY,
      { [PILOT_INVITE_CODE_HEADER]: 'A'.repeat(1_000) },
    );
    expect(publicResponse.status).toBe(202);

    const resend = await post(
      createApp(repo(), undefined, runtime(policy('closed'))),
      '/api/subscriptions/resend',
      { email: VALID_BODY.email },
      { [PILOT_INVITE_CODE_HEADER]: 'not-consulted' },
    );
    expect(resend.status).toBe(202);
    await expect(resend.json()).resolves.toEqual({ status: 'sent' });
  });
});

describe('recovery persistence failure', () => {
  it('returns the canonical generic 500 without logging the address', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp(
      repo({
        async enqueueResendMailByEmail() {
          throw new Error('persistence failed');
        },
      }),
      undefined,
      runtime(policy('closed')),
    );

    const responses = await Promise.all([
      post(app, '/api/subscriptions/resend', {
        email: 'known@berkeley.edu',
      }),
      post(app, '/api/subscriptions/resend', {
        email: 'unknown@berkeley.edu',
      }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([500, 500]);
    expect(new Set(bodies)).toEqual(
      new Set([JSON.stringify(apiError('internal_error', RECOVERY_INTERNAL_ERROR_MESSAGE))]),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('known@berkeley.edu');
    expect(JSON.stringify(log.mock.calls)).not.toContain('unknown@berkeley.edu');
  });
});
