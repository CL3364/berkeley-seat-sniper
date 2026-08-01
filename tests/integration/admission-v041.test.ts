import { createECDH } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SubscriberCapacityError,
  getSubscriberByEmail,
  mailOutbox,
  makeTestDb,
  subscribers,
  suppressEmail,
  watches,
} from '../../src/db';
import { PILOT_INVITE_CODE_HEADER, type PushKeys } from '../../src/shared/api';
import type { ClassKey } from '../../src/shared/class-key';
import {
  ADMISSION_RETRY_AFTER_SECONDS,
  ADMISSION_UNAVAILABLE_MESSAGE,
  RECOVERY_INTERNAL_ERROR_MESSAGE,
  apiError,
} from '../../src/shared/errors';
import { readAdmissionPolicy, type AdmissionPolicy } from '../../src/server/admission';
import {
  createApp,
  validateServerRuntimeConfig,
  type AppRuntimeOptions,
} from '../../src/server/app';
import { MemoryRateLimiter } from '../../src/server/rate-limit';
import { makeServerRepo } from '../../src/server/repo';
import { mintToken } from '../../src/server/token';

const TOKEN_SECRET = 'admission-v041-test-token-secret-at-least-32-characters';
const PILOT_INVITE = 'A'.repeat(43);
const CK_A = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const CK_B = '2026-fall-compsci-61a-001-lec-001' as ClassKey;
const CREATE_BODY = {
  email: 'pilot-member@berkeley.edu',
  classKeys: [CK_A],
};
const PUSH_ECDH = createECDH('prime256v1');
PUSH_ECDH.setPrivateKey(Buffer.alloc(32, 0x51));
const VALID_PUSH_KEYS: PushKeys = {
  p256dh: PUSH_ECDH.getPublicKey().toString('base64url'),
  auth: 'AAAAAAAAAAAAAAAAAAAAAA',
};

let originalAdmissionMode: string | undefined;
let originalPilotInvite: string | undefined;

beforeEach(() => {
  originalAdmissionMode = process.env.ADMISSION_MODE;
  originalPilotInvite = process.env.PILOT_INVITE_CODE;
  process.env.TOKEN_SECRET = TOKEN_SECRET;
  delete process.env.ADMISSION_MODE;
  delete process.env.PILOT_INVITE_CODE;
});

afterEach(() => {
  delete process.env.TOKEN_SECRET;
  if (originalAdmissionMode === undefined) delete process.env.ADMISSION_MODE;
  else process.env.ADMISSION_MODE = originalAdmissionMode;
  if (originalPilotInvite === undefined) delete process.env.PILOT_INVITE_CODE;
  else process.env.PILOT_INVITE_CODE = originalPilotInvite;
  vi.restoreAllMocks();
});

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

function policy(mode: 'closed' | 'pilot' | 'public'): AdmissionPolicy {
  return readAdmissionPolicy({
    ADMISSION_MODE: mode,
    ...(mode === 'pilot' ? { PILOT_INVITE_CODE: PILOT_INVITE } : {}),
  });
}

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function denialTuple(response: Response): Promise<readonly unknown[]> {
  return [
    response.status,
    response.headers.get('content-type'),
    response.headers.get('retry-after'),
    await response.text(),
  ] as const;
}

describe('AC-25 fail-closed subscriber admission', () => {
  it('makes absent/default closed and explicit closed byte-identical', async () => {
    const db = await makeTestDb();
    const repo = makeServerRepo(db);
    const defaultClosed = createApp(repo, undefined, {
      ...runtime(policy('closed')),
      admissionPolicy: undefined,
    });
    const explicitClosed = createApp(repo, undefined, runtime(policy('closed')));

    const tuples = await Promise.all(
      [defaultClosed, explicitClosed].map(async (app) =>
        denialTuple(await request(app, 'POST', '/api/subscriptions', CREATE_BODY)),
      ),
    );

    expect(tuples[0]).toEqual(tuples[1]);
    expect(tuples[0]).toEqual([
      503,
      'application/json',
      String(ADMISSION_RETRY_AFTER_SECONDS),
      JSON.stringify(apiError('admission_unavailable', ADMISSION_UNAVAILABLE_MESSAGE)),
    ]);
    expect(await db.select().from(subscribers)).toHaveLength(0);
  });

  it('makes every pilot bearer/full denial byte-identical', async () => {
    const db = await makeTestDb();
    const base = makeServerRepo(db, {
      maxUniqueSections: 96,
      maxSubscribers: 100,
    });
    const pilotRuntime = runtime(policy('pilot'));
    const pilot = createApp(base, undefined, pilotRuntime);
    const full = createApp(
      {
        ...base,
        async createSubscriber(): Promise<never> {
          throw new SubscriberCapacityError(100);
        },
      },
      undefined,
      pilotRuntime,
    );

    const cases: Array<{ app: ReturnType<typeof createApp>; header?: string }> = [
      { app: pilot },
      { app: pilot, header: 'B'.repeat(43) },
      { app: pilot, header: `${'A'.repeat(31)}=` },
      { app: pilot, header: 'A'.repeat(257) },
      { app: full, header: PILOT_INVITE },
    ];
    const tuples = await Promise.all(
      cases.map(async ({ app, header }) =>
        denialTuple(
          await request(app, 'POST', '/api/subscriptions', CREATE_BODY, {
            ...(header === undefined ? {} : { [PILOT_INVITE_CODE_HEADER]: header }),
          }),
        ),
      ),
    );

    expect(new Set(tuples.map((tuple) => JSON.stringify(tuple))).size).toBe(1);
    expect(tuples[0]).toEqual([
      503,
      'application/json',
      String(ADMISSION_RETRY_AFTER_SECONDS),
      JSON.stringify(apiError('admission_unavailable', ADMISSION_UNAVAILABLE_MESSAGE)),
    ]);
    expect(await db.select().from(subscribers)).toHaveLength(0);
  });

  it('admits the correct pilot bearer without persisting or logging it', async () => {
    const db = await makeTestDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp(
      makeServerRepo(db, { maxUniqueSections: 96, maxSubscribers: 100 }),
      undefined,
      runtime(policy('pilot')),
    );

    const response = await request(app, 'POST', '/api/subscriptions', CREATE_BODY, {
      [PILOT_INVITE_CODE_HEADER]: PILOT_INVITE,
    });

    expect(response.status).toBe(202);
    const durableState = JSON.stringify(
      {
        subscribers: await db.select().from(subscribers),
        watches: await db.select().from(watches),
        outbox: await db.select().from(mailOutbox),
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(durableState).not.toContain(PILOT_INVITE);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
      PILOT_INVITE,
    );
    expect(await response.text()).not.toContain(PILOT_INVITE);
  });

  it('public ignores even a malformed oversized invite header', async () => {
    const db = await makeTestDb();
    const app = createApp(makeServerRepo(db), undefined, runtime(policy('public')));

    const response = await request(app, 'POST', '/api/subscriptions', CREATE_BODY, {
      [PILOT_INVITE_CODE_HEADER]: 'not-base64url='.repeat(40),
    });

    expect(response.status).toBe(202);
    expect(await db.select().from(subscribers)).toHaveLength(1);
  });

  it('fails startup for invalid mode or a missing/malformed/out-of-range pilot secret', () => {
    for (const env of [
      { ADMISSION_MODE: 'PUBLIC' },
      { ADMISSION_MODE: 'pilot' },
      { ADMISSION_MODE: 'pilot', PILOT_INVITE_CODE: 'A'.repeat(31) },
      { ADMISSION_MODE: 'pilot', PILOT_INVITE_CODE: `${'A'.repeat(31)}=` },
      { ADMISSION_MODE: 'pilot', PILOT_INVITE_CODE: 'A'.repeat(257) },
    ]) {
      process.env.ADMISSION_MODE = env.ADMISSION_MODE;
      if ('PILOT_INVITE_CODE' in env && env.PILOT_INVITE_CODE !== undefined) {
        process.env.PILOT_INVITE_CODE = env.PILOT_INVITE_CODE;
      } else {
        delete process.env.PILOT_INVITE_CODE;
      }
      expect(() => validateServerRuntimeConfig()).toThrow();
    }
  });
});

describe('closed mode preserves every existing-subscriber route', () => {
  it('keeps resend, confirm, manage/watch, push, and both unsubscribe routes available', async () => {
    const db = await makeTestDb();
    const repo = makeServerRepo(db);
    const first = await repo.createSubscriber('closed-first@berkeley.edu', [CK_A]);
    const second = await repo.createSubscriber('closed-second@berkeley.edu', [CK_A]);
    const firstToken = mintToken(first.id);
    const secondToken = mintToken(second.id);
    const app = createApp(repo, undefined, runtime(policy('closed')));

    expect(
      (
        await request(app, 'POST', '/api/subscriptions/resend', {
          email: 'closed-first@berkeley.edu',
        })
      ).status,
    ).toBe(202);
    expect(
      (await request(app, 'POST', `/api/subscriptions/${firstToken}/confirm`, {})).status,
    ).toBe(200);
    expect((await request(app, 'GET', `/api/subscriptions/${firstToken}`)).status).toBe(200);
    expect(
      (
        await request(app, 'POST', `/api/subscriptions/${firstToken}/watches`, {
          classKey: CK_B,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          app,
          'DELETE',
          `/api/subscriptions/${firstToken}/watches/${encodeURIComponent(CK_B)}`,
        )
      ).status,
    ).toBe(204);

    const endpoint = 'https://push.example.com/closed-route-test';
    expect(
      (
        await request(app, 'POST', `/api/subscriptions/${firstToken}/push`, {
          endpoint,
          keys: VALID_PUSH_KEYS,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app, 'DELETE', `/api/subscriptions/${firstToken}/push`, {
          endpoint,
        })
      ).status,
    ).toBe(204);
    expect(
      (await request(app, 'POST', `/api/subscriptions/${firstToken}/unsubscribe`)).status,
    ).toBe(204);
    expect((await request(app, 'DELETE', `/api/subscriptions/${secondToken}`)).status).toBe(204);
    expect(await getSubscriberByEmail(db, 'closed-first@berkeley.edu')).toBeUndefined();
    expect(await getSubscriberByEmail(db, 'closed-second@berkeley.edu')).toBeUndefined();
  });
});

describe('AC-11 recovery dependency faults stay non-enumerating', () => {
  it('returns one generic 500 for Pending, Confirmed, unknown, and suppressed addresses', async () => {
    const db = await makeTestDb();
    const base = makeServerRepo(db);
    await base.createSubscriber('recovery-known@berkeley.edu', [CK_A]);
    const confirmed = await base.createSubscriber('recovery-confirmed@berkeley.edu', [CK_A]);
    expect(await base.confirmSubscriber(confirmed.id)).toBe('confirmed');
    await base.createSubscriber('recovery-suppressed@berkeley.edu', [CK_B]);
    await suppressEmail(db, 'recovery-suppressed@berkeley.edu', 'complaint');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi
      .spyOn(db, 'execute')
      .mockRejectedValue(new Error('injected durable enqueue failure'));
    const app = createApp(base, undefined, runtime(policy('closed')));
    const addresses = [
      'recovery-known@berkeley.edu',
      'recovery-confirmed@berkeley.edu',
      'recovery-unknown@berkeley.edu',
      'recovery-suppressed@berkeley.edu',
    ];

    const tuples = await Promise.all(
      addresses.map(async (email) => {
        const response = await request(app, 'POST', '/api/subscriptions/resend', { email });
        return [response.status, response.headers.get('content-type'), await response.text()];
      }),
    );

    expect(new Set(tuples.map((tuple) => JSON.stringify(tuple))).size).toBe(1);
    expect(tuples[0]).toEqual([
      500,
      'application/json',
      JSON.stringify(apiError('internal_error', RECOVERY_INTERNAL_ERROR_MESSAGE)),
    ]);
    expect(execute).toHaveBeenCalledTimes(addresses.length);
    const serializedLogs = JSON.stringify(log.mock.calls);
    for (const email of addresses) expect(serializedLogs).not.toContain(email);
  });
});
