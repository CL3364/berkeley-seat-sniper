/**
 * Integration tests — API ↔ DB (v0.4 contract).
 *
 * Stack: createApp(makeServerRepo(makeTestDb())) — a real Hono app backed by a
 * fresh in-process PGlite instance per describe block. After each API request,
 * the harness claims the durable mail jobs, dispatches them through the noop
 * provider, and claim-fence-completes them so emailed links land in an
 * inspectable outbox (FR-8/FR-17). No port binding or real network/mail.
 * TOKEN_SECRET is set in beforeEach.
 *
 * Double opt-in (D3 / FR-9): POST /api/subscriptions now returns
 * 202 { status: 'pending' } with NO token and NO subscriberId in the body — the
 * manage/confirm token travels ONLY by email. Tests that need a token extract it
 * from the confirmation email's `?confirm=<token>` line in the noop outbox
 * (spec §4 pinned link format), exactly as a real subscriber would.
 *
 * ACs covered here: AC-1, AC-2, AC-2b, AC-7, AC-8, AC-10 (confirm idempotency),
 * AC-11 (resend non-enumeration), AC-12 (rate limits), AC-13 (webhook signature
 * + suppression end-to-end), AC-16c (push 409 while Pending), plus the token
 * auth 401/404 paths and the vapid-public-key route.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createECDH, createHmac } from 'node:crypto';
import {
  addWatch,
  cancelClaimedMailJob,
  claimMailJobs,
  completeMailJob,
  deadLetterMailJob,
  deferMailJob,
  makeTestDb,
  confirmSubscriber,
  isSuppressed,
  getSubscriberByEmail,
  listPushSubscriptions,
  mailOutbox,
  SubscriberNotFoundError,
  subscribers,
  UniqueSectionCapacityError,
  upsertClassState,
  watches,
} from '../../src/db';
import type { Db } from '../../src/db';
import type { ClassKey } from '../../src/shared/class-key';
import type { WatchFreshness } from '../../src/shared/api';
import { makeServerRepo } from '../../src/server/repo';
import { createApp } from '../../src/server/app';
import { readAdmissionPolicy } from '../../src/server/admission';
import type { NotifierPort, NotifierLinkInput } from '../../src/server/notifier-port';
import {
  MemoryRateLimiter,
  type RateLimiter,
  type RateLimitConfig,
} from '../../src/server/rate-limit';
import { mintToken } from '../../src/server/token';
import { createMailDispatcher, createNoopTransport } from '../../src/notify';
import type { MailDispatcher, OutboxEntry } from '../../src/notify';

// ---------------------------------------------------------------------------
// Constants — only reserved/example or Berkeley test addresses, never a real inbox.
// ---------------------------------------------------------------------------

const TEST_TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';
const WEBHOOK_KEY = Buffer.from('webhook-test-secret-at-least-32-bytes-long');
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString('base64')}`;
const VALID_PUSH_KEYS = {
  p256dh: 'BL7ELU24fJTAlH5Kyl8N6BDCac8u8li_U5PIwG963MOvdYs9s7LSzj8x_7v7RFdLZ9Eap50PiiyF5K0TDAis7t0',
  auth: 'AAAAAAAAAAAAAAAAAAAAAA',
} as const;
// Derive a deterministic throwaway pair at test startup instead of committing a
// private-key-shaped literal that secret scanners cannot distinguish from a real
// deployment credential.
const TEST_VAPID_ECDH = createECDH('prime256v1');
TEST_VAPID_ECDH.setPrivateKey(Buffer.alloc(32, 0x42));
const TEST_VAPID_PUBLIC_KEY = TEST_VAPID_ECDH.getPublicKey().toString('base64url');
const TEST_VAPID_PRIVATE_KEY = TEST_VAPID_ECDH.getPrivateKey().toString('base64url');

const CK_189 = '2026-fall-compsci-189-001-lec-001' as const;
const CK_61A = '2026-fall-compsci-61a-001-lec-001' as const;
const CK_110 = '2026-spring-math-110-001-lec-001' as const;
const VALID_EMAIL = 'student@berkeley.edu';
const PUBLIC_ADMISSION = readAdmissionPolicy({ ADMISSION_MODE: 'public' });
const UNOBSERVED_DASHBOARD = {
  displayName: null,
  openSeats: null,
  enrolled: null,
  capacity: null,
  waitlisted: null,
  waitlistMax: null,
  waitlistOpen: null,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppHandle = ReturnType<typeof createApp>;
const postRequestHooks = new WeakMap<AppHandle, () => Promise<void>>();

/** Fire a request against the Hono app without binding a port. */
async function req(
  app: AppHandle,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  } else if (headers) {
    init.headers = headers;
  }
  // app.request returns Response | Promise<Response>; normalize to Promise.
  const response = await Promise.resolve(app.request(new Request(url, init)));
  await postRequestHooks.get(app)?.();
  return response;
}

async function json<T = unknown>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

/**
 * Build the durable dispatcher and a legacy port that must remain unused.
 * Suppression is checked against the same isolated DB at dispatch time.
 */
function makeOutboxPort(db: Db): { port: NotifierPort; notifier: MailDispatcher } {
  const notifier = createMailDispatcher({
    transport: createNoopTransport(),
    isSuppressed: (email) => isSuppressed(db, email),
    push: null,
  });
  const port: NotifierPort = {
    async sendConfirmation(_input: NotifierLinkInput): Promise<void> {
      throw new Error('v0.4 API must enqueue confirmation mail');
    },
    async sendManageLink(_input: NotifierLinkInput): Promise<void> {
      throw new Error('v0.4 API must enqueue manage-link mail');
    },
  };
  return { port, notifier };
}

interface TestApp {
  app: AppHandle;
  db: Db;
  notifier: MailDispatcher;
  rateLimiter: MemoryRateLimiter;
  drainMail(): Promise<void>;
}

async function drainMail(db: Db, notifier: MailDispatcher): Promise<void> {
  for (;;) {
    const jobs = await claimMailJobs(db, { limit: 100 });
    if (jobs.length === 0) return;
    const results = await notifier.dispatchBatch(jobs);
    for (const job of jobs) {
      const result = results.find((entry) => entry.jobId === job.id)?.result;
      if (!result) throw new Error(`dispatcher omitted result for ${job.id}`);
      if (result.status === 'success') {
        await completeMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          providerMessageId: result.providerMessageId,
          providerAcceptedAt: result.acceptedAt,
        });
      } else if (result.status === 'suppressed') {
        await cancelClaimedMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          reason: 'suppressed',
        });
      } else if (result.status === 'permanent') {
        await deadLetterMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          errorCode: result.errorCode,
        });
      } else {
        await deferMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          availableAt: new Date(Date.now() + 60_000),
          errorCode: result.errorCode,
        });
        throw new Error(`unexpected retryable test-mail outcome: ${result.errorCode}`);
      }
    }
  }
}

/** Create a fresh isolated app + PGlite DB + durable noop dispatcher. */
async function makeTestApp(
  options: {
    rateLimiter?: MemoryRateLimiter;
    rateLimitConfig?: RateLimitConfig;
  } = {},
): Promise<TestApp> {
  const db = await makeTestDb();
  const { port, notifier } = makeOutboxPort(db);
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter();
  const app = createApp(makeServerRepo(db), port, {
    admissionPolicy: PUBLIC_ADMISSION,
    rateLimiter,
    rateLimitConfig: options.rateLimitConfig,
    remoteAddress: () => '127.0.0.1',
  });
  const drain = () => drainMail(db, notifier);
  postRequestHooks.set(app, drain);
  return { app, db, notifier, rateLimiter, drainMail: drain };
}

function fakeRedisLimiter(): RateLimiter {
  const memory = new MemoryRateLimiter();
  return {
    backend: 'redis',
    consume: (...args) => memory.consume(...args),
    healthCheck: () => memory.healthCheck(),
  };
}

/** Extract the `?confirm=<token>` token from the latest confirmation entry. */
function confirmTokenFromOutbox(outbox: OutboxEntry[], to: string): string {
  const entry = [...outbox].reverse().find((e) => e.kind === 'confirmation' && e.to === to);
  if (!entry) throw new Error('no confirmation entry for address');
  const m = entry.body.match(/[?&]confirm=([^\s&]+)/);
  if (!m) throw new Error('confirmation body has no ?confirm= link');
  return decodeURIComponent(m[1]);
}

/**
 * Subscribe then confirm, returning the verified manage token (extracted from the
 * confirmation email's `?confirm=` link, exactly as a real subscriber would). The
 * confirm token IS the manage token (one token type, spec §4), so it drives the
 * manage/watch/unsubscribe routes too.
 */
async function subscribeAndConfirm(
  t: TestApp,
  email: string,
  classKeys: string[],
): Promise<string> {
  const createRes = await req(t.app, 'POST', '/api/subscriptions', { email, classKeys });
  expect(createRes.status).toBe(202);
  const token = confirmTokenFromOutbox(t.notifier.outbox, email);
  const confirmRes = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});
  expect(confirmRes.status).toBe(200);
  return token;
}

/**
 * Sign a webhook body with the Svix scheme used by verifyResendWebhook.
 *
 * The svix-timestamp MUST be current: verifyResendWebhook enforces a 5-minute
 * replay window (WEBHOOK_TIMESTAMP_TOLERANCE_MS in src/server/webhook-signature.ts),
 * so a hardcoded historical timestamp is (correctly) rejected out-of-tolerance
 * before the HMAC is even checked. Sign with `now` so the signature — not the
 * clock — is what the AC-13a suppression path exercises.
 */
function signWebhook(rawBody: string): Record<string, string> {
  const id = 'msg_test_1';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = createHmac('sha256', WEBHOOK_KEY).update(signedContent).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${sig}`,
  };
}

// ---------------------------------------------------------------------------
// AC-1: Subscribe → confirm → manage roundtrip (FR-1, FR-2, FR-9)
// ---------------------------------------------------------------------------

describe('AC-1: subscribe → confirm → manage roundtrip', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('AC-1: POST /api/subscriptions returns 202 {status:pending} with NO token and NO subscriberId', async () => {
    const res = await req(t.app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(res.status).toBe(202);

    const body = await json<Record<string, unknown>>(res);
    expect(body.status).toBe('pending');
    // The 202 body NEVER carries a token, subscriberId, or watch list (D3).
    expect(body.token).toBeUndefined();
    expect(body.subscriberId).toBeUndefined();
    expect(body.watches).toBeUndefined();
  });

  it('AC-1: subscribe dispatches exactly one confirmation entry to that address with the confirm link', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });

    const confirmations = t.notifier.outbox.filter(
      (e) => e.kind === 'confirmation' && e.to === VALID_EMAIL,
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].body).toMatch(/[?&]confirm=/);
  });

  it('AC-1: extracting the confirm token and confirming returns 200 {status:confirmed}', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);

    const confirmRes = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});
    expect(confirmRes.status).toBe(200);
    const body = await json<{ status: string }>(confirmRes);
    expect(body.status).toBe('confirmed');
  });

  it('AC-1: after confirm, GET with that token shows confirmed:true and lists the watch', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);

    const manageRes = await req(t.app, 'GET', `/api/subscriptions/${token}`);
    expect(manageRes.status).toBe(200);
    const managed = await json<{
      email: string;
      confirmed: boolean;
      watches: string[];
      watchFreshness: WatchFreshness[];
    }>(manageRes);
    expect(managed.email).toBe(VALID_EMAIL);
    expect(managed.confirmed).toBe(true);
    expect(managed.watches).toEqual([CK_189]);
    expect(managed.watchFreshness).toEqual([
      {
        classKey: CK_189,
        source: 'public-class-page',
        lastCheckedAt: null,
        sourceStale: true,
        ...UNOBSERVED_DASHBOARD,
      },
    ]);
  });

  it('AC-1: GET before confirm shows confirmed:false (manage view can prompt to confirm)', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);

    const manageRes = await req(t.app, 'GET', `/api/subscriptions/${token}`);
    expect(manageRes.status).toBe(200);
    const managed = await json<{
      confirmed: boolean;
      watches: string[];
      watchFreshness: WatchFreshness[];
    }>(manageRes);
    expect(managed.confirmed).toBe(false);
    expect(managed.watches).toEqual([CK_189]);
    expect(managed.watchFreshness).toEqual([
      {
        classKey: CK_189,
        source: 'public-class-page',
        lastCheckedAt: null,
        sourceStale: true,
        ...UNOBSERVED_DASHBOARD,
      },
    ]);
  });

  it('subscribing with a class URL normalizes to the canonical key (visible after confirm)', async () => {
    const urlInput = `https://classes.berkeley.edu/content/${CK_189}`;
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [urlInput]);
    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toEqual([CK_189]);
  });

  it('subscribing with a human code normalizes to the canonical key', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, ['2026 Fall COMPSCI 189 001 LEC 001']);
    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toEqual([CK_189]);
  });

  it('subscribing with multiple class keys lists all watches in the manage view', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189, CK_61A]);
    const managed = await json<{
      watches: string[];
      watchFreshness: Array<{ classKey: string }>;
    }>(await req(t.app, 'GET', `/api/subscriptions/${token}`));
    expect(new Set(managed.watches)).toEqual(new Set([CK_189, CK_61A]));
    expect(managed.watchFreshness.map((entry) => entry.classKey)).toEqual(managed.watches);
  });

  it('AC-18: an observed class returns public-source time and a fresh flag', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await upsertClassState(t.db, {
      classKey: CK_189 as ClassKey,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: 'COMPSCI 189 001 - LEC 001',
      lastEnrolled: 347,
      lastCapacity: 350,
      lastWaitlisted: 100,
      lastWaitlistMax: 100,
      sourceFreshUntil: new Date(Date.now() + 60_000),
    });

    const managed = await json<{
      watchFreshness: WatchFreshness[];
    }>(await req(t.app, 'GET', `/api/subscriptions/${token}`));

    expect(managed.watchFreshness).toHaveLength(1);
    expect(managed.watchFreshness[0]).toMatchObject({
      classKey: CK_189,
      source: 'public-class-page',
      sourceStale: false,
      displayName: 'COMPSCI 189 001 - LEC 001',
      openSeats: 0,
      enrolled: 347,
      capacity: 350,
      waitlisted: 100,
      waitlistMax: 100,
      waitlistOpen: false,
    });
    expect(managed.watchFreshness[0].lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('POST .../watches adds a new watch and GET reflects it', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);

    const addRes = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_61A,
    });
    expect(addRes.status).toBe(200);
    const added = await json<{
      watches: string[];
      watchFreshness: Array<{ classKey: string; sourceStale: boolean }>;
    }>(addRes);
    expect(added.watches).toContain(CK_61A);
    expect(added.watches).toContain(CK_189);
    expect(added.watchFreshness.map((entry) => entry.classKey)).toEqual(added.watches);
    expect(added.watchFreshness.find((entry) => entry.classKey === CK_61A)?.sourceStale).toBe(true);

    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toContain(CK_61A);
  });

  it('DELETE .../watches/:classKey removes that watch and GET no longer shows it', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189, CK_61A]);

    const delRes = await req(t.app, 'DELETE', `/api/subscriptions/${token}/watches/${CK_189}`);
    expect(delRes.status).toBe(204);

    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).not.toContain(CK_189);
    expect(managed.watches).toContain(CK_61A);
  });

  it('AC-14 (revive-on-readd): re-adding a class revives it and lists it again (200)', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    // Retire the class via the worker repo (simulating a class-gone cycle).
    const { retireWatchesForClass } = await import('../../src/db');
    const retired = await retireWatchesForClass(t.db, CK_189 as ClassKey);
    expect(retired).toBe(1);

    // The retired watch no longer lists.
    const before = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(before.watches).not.toContain(CK_189);

    // Re-adding the same class REVIVES the watch (200), and it lists again.
    const addRes = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_189,
    });
    expect(addRes.status).toBe(200);
    const added = await json<{ watches: string[] }>(addRes);
    expect(added.watches).toContain(CK_189);
  });
});

// ---------------------------------------------------------------------------
// AC-10: Confirm is idempotent (FR-9)
// ---------------------------------------------------------------------------

describe('AC-10: confirm twice → 200 both times, timestamp set once, no extra email', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-10: confirming twice with the same token returns 200 {status:confirmed} both times', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);

    const first = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});
    const second = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await json<{ status: string }>(first)).status).toBe('confirmed');
    expect((await json<{ status: string }>(second)).status).toBe('confirmed');
  });

  it('AC-10: the second confirm sends no additional email (outbox stays at one confirmation)', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);
    const outboxBefore = t.notifier.outbox.length;

    await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});
    await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});

    // Confirm sends no mail at all (the confirm email was the subscribe side effect).
    expect(t.notifier.outbox.length).toBe(outboxBefore);
  });

  it('AC-10: confirmSubscriber flips exactly once — second db call reports already confirmed', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);
    await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {});

    // Re-running the underlying idempotent setter must NOT re-flip (timestamp set once).
    const { getSubscriberByEmail } = await import('../../src/db');
    const sub = await getSubscriberByEmail(t.db, VALID_EMAIL);
    expect(sub).toBeDefined();
    const reFlip = await confirmSubscriber(t.db, sub!.id);
    expect(reFlip).toBe('already_confirmed');
  });

  it('confirm with a garbage token returns 401 token_invalid', async () => {
    const res = await req(t.app, 'POST', '/api/subscriptions/garbage-token/confirm', {});
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('token_invalid');
  });

  it('confirm with a valid signature but missing subscriber returns 404 not_found', async () => {
    const forged = mintToken('non-existent-id');
    const res = await req(t.app, 'POST', `/api/subscriptions/${forged}/confirm`, {});
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('not_found');
  });

  it('rejects a headerless cross-site confirm POST without mutating Pending state', async () => {
    await req(t.app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);

    const rejected = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`);
    expect(rejected.status).toBe(400);

    const managed = await json<{ confirmed: boolean }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.confirmed).toBe(false);
  });

  it('rejects a non-empty confirmation body declared outside the route contract', async () => {
    const t = await makeTestApp();
    await req(t.app, 'POST', '/api/subscriptions', {
      email: 'confirm-body@berkeley.edu',
      classKeys: [CK_189],
    });
    const token = confirmTokenFromOutbox(t.notifier.outbox, 'confirm-body@berkeley.edu');

    const result = await req(t.app, 'POST', `/api/subscriptions/${token}/confirm`, {
      unexpected: true,
    });
    expect(result.status).toBe(400);

    const subscriber = await getSubscriberByEmail(t.db, 'confirm-body@berkeley.edu');
    expect(subscriber?.confirmedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2: Invalid email → 400, no subscriber row created (FR-1)
// ---------------------------------------------------------------------------

describe('AC-2: invalid email → 400 validation_error, no row created', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('invalid email returns 400 with validation_error code', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: 'not-an-email',
      classKeys: [CK_189],
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('validation_error');
  });

  it('invalid email response includes fields.email for inline error display (AC-2)', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: 'bad@@email',
      classKeys: [CK_189],
    });
    const body = await json<{ error: { fields?: Record<string, string> } }>(res);
    expect(body.error.fields?.email).toBeTruthy();
  });

  it.each([
    'student@example.edu',
    'student@gmail.com',
    'student@sub.berkeley.edu',
    'student@berkeley.edu.example.com',
    'student@notberkeley.edu',
  ])('rejects an ineligible subscriber domain without creating a row: %s', async (email) => {
    const rejected = await req(app, 'POST', '/api/subscriptions', {
      email,
      classKeys: [CK_189],
    });
    expect(rejected.status).toBe(400);
    expect((await json<{ error: { code: string } }>(rejected)).error.code).toBe('validation_error');
  });

  it('rejects plus-addresses and still accepts their normalized base address', async () => {
    const rejected = await req(app, 'POST', '/api/subscriptions', {
      email: '  Student+SeatAlerts@BERKELEY.EDU ',
      classKeys: [CK_189],
    });
    expect(rejected.status).toBe(400);
    expect((await json<{ error: { code: string } }>(rejected)).error.code).toBe('validation_error');

    const acceptedBase = await req(app, 'POST', '/api/subscriptions', {
      email: '  Student@BERKELEY.EDU ',
      classKeys: [CK_189],
    });
    expect(acceptedBase.status).toBe(202);
  });

  it('failed POST creates no subscriber row — a valid POST after it returns 202', async () => {
    // If the bad request created a row, the good one would hit 409.
    await req(app, 'POST', '/api/subscriptions', {
      email: 'not-valid@',
      classKeys: [CK_189],
    });
    const goodRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(goodRes.status).toBe(202);
  });

  it('empty classKeys array returns 400 validation_error', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [],
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('validation_error');
  });

  it('classKey with no term returns 400 (never invents a term)', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: ['COMPSCI 189 LEC 001'],
    });
    expect(res.status).toBe(400);
  });

  it('classKey with unknown season "winter" returns 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: ['2026 winter compsci 189 001 lec 001'],
    });
    expect(res.status).toBe(400);
  });

  it.each([
    '2026 Fall COMPSCI 10 999L LAB 999L',
    '2026 Fall INFO 295 001 COL 001',
    '2026 Fall DATA 100 001 GRP 001',
    '2026 Fall PHYSICS 7A 001 SLF 001',
    '2026 Fall MATH 1A 001 TUT 001',
  ])('accepts a bounded real catalog class shape: %s', async (classKey) => {
    const local = await makeTestApp();
    const res = await req(local.app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [classKey],
    });
    expect(res.status).toBe(202);
  });

  it('oversized canonical components return 400 instead of reaching PostgreSQL', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [`2026-fall-${'x'.repeat(33)}-189-001-lec-001`],
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('validation_error');
  });

  it('non-JSON body returns 400', async () => {
    const res = await Promise.resolve(
      app.request(
        new Request('http://localhost/api/subscriptions', {
          method: 'POST',
          body: 'not json',
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('valid JSON carried as text/plain is rejected before creating a row', async () => {
    const rejected = await req(
      app,
      'POST',
      '/api/subscriptions',
      { email: VALID_EMAIL, classKeys: [CK_189] },
      { 'Content-Type': 'text/plain' },
    );
    expect(rejected.status).toBe(400);

    const accepted = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(accepted.status).toBe(202);
  });

  it('does not opt cross-origin preflights into CORS', async () => {
    const res = await Promise.resolve(
      app.request(
        new Request('http://localhost/api/subscriptions', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        }),
      ),
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('missing email field returns 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', { classKeys: [CK_189] });
    expect(res.status).toBe(400);
  });

  it('missing classKeys field returns 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', { email: VALID_EMAIL });
    expect(res.status).toBe(400);
  });
});

describe('v0.4 API resource-boundary errors', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-21: rejects a general JSON body above 64 KiB before parsing with canonical 413', async () => {
    const oversizedBody = JSON.stringify({
      email: `${'x'.repeat(65_536)}@berkeley.edu`,
      classKeys: [CK_189],
    });
    const res = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/subscriptions', {
          method: 'POST',
          body: oversizedBody,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    expect(res.status).toBe(413);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('payload_too_large');
  });

  it('defensively maps an unexpected create capacity error to canonical 503', async () => {
    const baseRepo = makeServerRepo(t.db);
    const capacityRepo = {
      ...baseRepo,
      async createSubscriber(): Promise<never> {
        throw new UniqueSectionCapacityError(96);
      },
    };
    const { port } = makeOutboxPort(t.db);
    const capacityApp = createApp(capacityRepo, port, {
      admissionPolicy: PUBLIC_ADMISSION,
    });

    const res = await req(capacityApp, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('capacity_exceeded');
  });
});

// ---------------------------------------------------------------------------
// AC-2b: Duplicate email → 409 conflict; constant-shaped envelope only
// ---------------------------------------------------------------------------

describe('AC-2b: duplicate email → 409 conflict, no token/subscriberId leaked', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-2b: second POST with the same email returns 409 conflict', async () => {
    await req(app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('conflict');
  });

  it('AC-2b: 409 body is the bare {error} envelope — no token, subscriberId, or watches', async () => {
    await req(app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    const body = await json<Record<string, unknown>>(res);
    expect(body.error).toBeDefined();
    expect(body.token).toBeUndefined();
    expect(body.subscriberId).toBeUndefined();
    expect(body.watches).toBeUndefined();
  });

  it('AC-2b: 409 message does not contain the subscriber email', async () => {
    await req(app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    const body = await json<{ error: { message: string } }>(res);
    expect(body.error.message).not.toContain(VALID_EMAIL);
    expect(body.error.message).not.toContain('example.edu');
  });

  it('AC-2b: the existing subscription is unchanged after a 409 (no merge)', async () => {
    const t = await makeTestApp();
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);

    // Attempt duplicate with a different class — must NOT merge CK_61A.
    await req(t.app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });

    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toEqual([CK_189]);
  });

  it('duplicate watch add via manage endpoint returns 409', async () => {
    const t = await makeTestApp();
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);

    const addRes = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_189,
    });
    expect(addRes.status).toBe(409);
    const body = await json<{ error: { code: string } }>(addRes);
    expect(body.error.code).toBe('conflict');
  });

  it('rejects five watches at the create contract boundary', async () => {
    const t = await makeTestApp();
    const classKeys = Array.from(
      { length: 5 },
      (_, index) => `2026-fall-compsci-${String(index + 100).padStart(3, '0')}-001-lec-001`,
    );

    const result = await req(t.app, 'POST', '/api/subscriptions', {
      email: 'watch-create-cap@berkeley.edu',
      classKeys,
    });

    expect(result.status).toBe(400);
    expect((await json<{ error: { code: string } }>(result)).error.code).toBe('validation_error');
    expect(await t.db.select().from(subscribers)).toHaveLength(0);
    expect(await t.db.select().from(watches)).toHaveLength(0);
    expect(await t.db.select().from(mailOutbox)).toHaveLength(0);
  });

  it('enforces the four-live-watch cap on post-confirmation additions', async () => {
    const initial = Array.from(
      { length: 4 },
      (_, index) => `2026-fall-compsci-${String(index + 100).padStart(3, '0')}-001-lec-001`,
    );
    const t = await makeTestApp();
    const token = await subscribeAndConfirm(t, 'watch-cap@berkeley.edu', initial);

    const overCap = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: '2026-fall-compsci-999-001-lec-001',
    });
    expect(overCap.status).toBe(409);
    expect(overCap.headers.get('retry-after')).toBeNull();
    expect((await json<{ error: { code: string } }>(overCap)).error.code).toBe(
      'watch_limit_reached',
    );

    const duplicate = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: initial[0],
    });
    expect(duplicate.status).toBe(409);
    expect((await json<{ error: { code: string } }>(duplicate)).error.code).toBe('conflict');

    const removed = await req(t.app, 'DELETE', `/api/subscriptions/${token}/watches/${initial[0]}`);
    expect(removed.status).toBe(204);
    const addedAfterRemoval = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: '2026-fall-compsci-999-001-lec-001',
    });
    expect(addedAfterRemoval.status).toBe(200);

    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toHaveLength(4);
  });

  it('serializes concurrent additions at the four-watch boundary', async () => {
    const initial = Array.from(
      { length: 3 },
      (_, index) => `2026-fall-compsci-${String(index + 100).padStart(3, '0')}-001-lec-001`,
    );
    const t = await makeTestApp();
    const token = await subscribeAndConfirm(t, 'watch-cap-race@berkeley.edu', initial);

    const results = await Promise.all([
      req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
        classKey: '2026-fall-compsci-998-001-lec-001',
      }),
      req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
        classKey: '2026-fall-compsci-999-001-lec-001',
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const rejected = results.find((result) => result.status === 409);
    expect(rejected).toBeDefined();
    expect((await json<{ error: { code: string } }>(rejected!)).error.code).toBe(
      'watch_limit_reached',
    );

    const managed = await json<{ watches: string[] }>(
      await req(t.app, 'GET', `/api/subscriptions/${token}`),
    );
    expect(managed.watches).toHaveLength(4);
  });

  it('rejects an oversized add-watch key before persistence', async () => {
    const t = await makeTestApp();
    const token = await subscribeAndConfirm(t, 'oversized-add@berkeley.edu', [CK_189]);
    const result = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: `2026-fall-${'x'.repeat(33)}-189-001-lec-001`,
    });
    expect(result.status).toBe(400);
  });

  it('maps a subscriber deleted before the locked add transaction to not-found', async () => {
    const db = await makeTestDb();
    await expect(addWatch(db, 'deleted-before-add', CK_189 as ClassKey)).rejects.toBeInstanceOf(
      SubscriberNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-11: Resend is non-enumerating (FR-10)
// ---------------------------------------------------------------------------

describe('AC-11: resend → identical 202 body for known and unknown; outbox only for known', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-11: resend for known and unknown both return byte-identical 202 {status:sent}', async () => {
    // Seed a confirmed subscriber.
    await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);

    const knownRes = await req(t.app, 'POST', '/api/subscriptions/resend', { email: VALID_EMAIL });
    const unknownRes = await req(t.app, 'POST', '/api/subscriptions/resend', {
      email: 'nobody@berkeley.edu',
    });
    expect(knownRes.status).toBe(202);
    expect(unknownRes.status).toBe(202);
    expect(await knownRes.text()).toBe(await unknownRes.text());
  });

  it('AC-11: resend for a CONFIRMED address sends exactly one manage-link entry', async () => {
    await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    const before = t.notifier.outbox.filter((e) => e.kind === 'manage-link').length;

    await req(t.app, 'POST', '/api/subscriptions/resend', { email: VALID_EMAIL });

    // Resend dispatches FIRE-AND-FORGET (kills the timing oracle), so the outbox
    // entry lands AFTER the 202 returns — poll until it appears rather than
    // reading synchronously. Asserting `=== before + 1` (not `>=`) still enforces
    // "exactly one" manage-link entry to that address.
    await vi.waitFor(
      () => {
        const manageLinks = t.notifier.outbox.filter(
          (e) => e.kind === 'manage-link' && e.to === VALID_EMAIL,
        );
        expect(manageLinks.length).toBe(before + 1);
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it('AC-11: resend for a PENDING address sends exactly one confirmation entry', async () => {
    // Subscribe but do NOT confirm — Pending.
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const confirmsBefore = t.notifier.outbox.filter((e) => e.kind === 'confirmation').length;

    await req(t.app, 'POST', '/api/subscriptions/resend', { email: VALID_EMAIL });

    // Fire-and-forget resend: the confirmation lands after the 202, so poll.
    // `=== confirmsBefore + 1` still asserts exactly one extra confirmation.
    await vi.waitFor(
      () => {
        const confirms = t.notifier.outbox.filter(
          (e) => e.kind === 'confirmation' && e.to === VALID_EMAIL,
        );
        // One from subscribe + one from resend-while-Pending.
        expect(confirms.length).toBe(confirmsBefore + 1);
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it('AC-11: resend for an UNKNOWN address sends nothing (outbox has no entry for it)', async () => {
    // Seed a CONFIRMED control whose resend we CAN observe landing. Because
    // resend is fire-and-forget, a synchronous zero-read right after the 202 is
    // vacuous (nothing has dispatched yet). So we fire the unknown resend, then a
    // control resend, and wait until the control's manage-link lands — proving
    // the dispatch pipeline has actually run — before asserting the unknown
    // address STILL has no outbox entry. That makes "no send" a meaningful claim.
    const control = 'control@berkeley.edu';
    await subscribeAndConfirm(t, control, [CK_189]);

    await req(t.app, 'POST', '/api/subscriptions/resend', { email: 'unknown@berkeley.edu' });
    await req(t.app, 'POST', '/api/subscriptions/resend', { email: control });

    await vi.waitFor(
      () => {
        const controlLinks = t.notifier.outbox.filter(
          (e) => e.kind === 'manage-link' && e.to === control,
        );
        expect(controlLinks.length).toBe(1);
      },
      { timeout: 2000, interval: 20 },
    );

    const entries = t.notifier.outbox.filter((e) => e.to === 'unknown@berkeley.edu');
    expect(entries).toHaveLength(0);
  });

  it('resend with a malformed email shape returns 400 validation_error', async () => {
    const res = await req(t.app, 'POST', '/api/subscriptions/resend', { email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('validation_error');
  });

  it('rejects a +tag recovery identity while accepting the corresponding base address', async () => {
    const tagged = await req(t.app, 'POST', '/api/subscriptions/resend', {
      email: 'student+recovery@berkeley.edu',
    });
    expect(tagged.status).toBe(400);
    expect((await json<{ error: { code: string } }>(tagged)).error.code).toBe('validation_error');

    const base = await req(t.app, 'POST', '/api/subscriptions/resend', {
      email: 'student@berkeley.edu',
    });
    expect(base.status).toBe(202);
  });

  it('rejects text/plain JSON without dispatching a recovery message', async () => {
    const before = t.notifier.outbox.length;
    const res = await req(
      t.app,
      'POST',
      '/api/subscriptions/resend',
      { email: VALID_EMAIL },
      { 'Content-Type': 'text/plain' },
    );
    expect(res.status).toBe(400);
    expect(t.notifier.outbox).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// AC-12: Rate limits — per-email on resend, per-IP on subscribe (FR-11)
//
// Every app receives a fresh asynchronous MemoryRateLimiter, matching the
// production Redis contract without sharing windows between tests.
// ---------------------------------------------------------------------------

describe('AC-12: rate limits return 429 rate_limited; under-limit succeeds', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-12: exceeding the per-email window on resend returns 429 rate_limited', async () => {
    // Per-email default MAX is 3 — the 4th resend for one address trips it.
    const email = 'limited@berkeley.edu';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await req(t.app, 'POST', '/api/subscriptions/resend', { email })).status);
    }
    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses[3]).toBe(429);

    const overLimit = await req(t.app, 'POST', '/api/subscriptions/resend', { email });
    expect(overLimit.status).toBe(429);
    expect((await json<{ error: { code: string } }>(overLimit)).error.code).toBe('rate_limited');
  });

  it('AC-12: under the per-email limit, resend still succeeds (guard against false-429)', async () => {
    const res = await req(t.app, 'POST', '/api/subscriptions/resend', {
      email: 'fine@berkeley.edu',
    });
    expect(res.status).toBe(202);
  });

  it('AC-12: exceeding the per-IP window on subscribe returns 429 rate_limited', async () => {
    // Per-IP subscribe default MAX is 5 — the 6th create from one IP trips it.
    // Distinct emails so the per-EMAIL limiter (default 3) does not fire first.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await req(t.app, 'POST', '/api/subscriptions', {
        email: `ip-${i}@berkeley.edu`,
        classKeys: [CK_189],
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);

    const overLimit = await req(t.app, 'POST', '/api/subscriptions', {
      email: 'ip-over@berkeley.edu',
      classKeys: [CK_189],
    });
    expect(overLimit.status).toBe(429);
    expect((await json<{ error: { code: string } }>(overLimit)).error.code).toBe('rate_limited');
  });

  it('push enable shares the per-IP request budget', async () => {
    const token = await subscribeAndConfirm(t, 'push-rate@berkeley.edu', [CK_189]);
    t.rateLimiter.reset();

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
        endpoint: `https://push.example.com/rate/${i}`,
        keys: VALID_PUSH_KEYS,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201]);

    const overLimit = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
      endpoint: 'https://push.example.com/rate/5',
      keys: VALID_PUSH_KEYS,
    });
    expect(overLimit.status).toBe(429);
    expect((await json<{ error: { code: string } }>(overLimit)).error.code).toBe('rate_limited');
  });

  it('does not apply the public per-IP request budget to token-scoped watch additions', async () => {
    const token = await subscribeAndConfirm(t, 'watch-rate@berkeley.edu', [CK_189]);
    t.rateLimiter.reset();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const classKey = `2026-fall-compsci-${String(i + 300).padStart(3, '0')}-001-lec-001`;
      const res = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
        classKey,
      });
      statuses.push(res.status);
      const removed = await req(t.app, 'DELETE', `/api/subscriptions/${token}/watches/${classKey}`);
      expect(removed.status).toBe(204);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('rejected simple cross-site media types do not consume the IP budget', async () => {
    for (let i = 0; i < 8; i++) {
      const rejected = await req(
        t.app,
        'POST',
        '/api/subscriptions',
        { email: `cross-site-${i}@berkeley.edu`, classKeys: [CK_189] },
        { 'Content-Type': 'text/plain' },
      );
      expect(rejected.status).toBe(400);
    }

    const valid = await req(t.app, 'POST', '/api/subscriptions', {
      email: 'cross-site-control@berkeley.edu',
      classKeys: [CK_189],
    });
    expect(valid.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// AC-13: Resend webhook signature + suppression end-to-end (FR-12)
// ---------------------------------------------------------------------------

describe('AC-13: webhook signature + suppression', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.DISABLE_RATE_LIMIT;
  });

  it('AC-13b: a bad signature returns 401 signature_invalid and suppresses nothing', async () => {
    const target = 'bounce@berkeley.edu';
    const rawBody = JSON.stringify({
      type: 'email.bounced',
      data: { to: target, bounce: { type: 'Permanent' } },
    });
    // Use a CURRENT timestamp so the request passes the replay window and the
    // rejection is provably about the (garbage) signature — not the clock.
    const res = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: {
            'Content-Type': 'application/json',
            'svix-id': 'msg_test_1',
            'svix-timestamp': Math.floor(Date.now() / 1000).toString(),
            'svix-signature': 'v1,not-a-valid-signature',
          },
        }),
      ),
    );
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('signature_invalid');
    // Nothing suppressed (AC-13b).
    expect(await isSuppressed(t.db, target)).toBe(false);
  });

  it('AC-13b: a stale svix-timestamp is rejected 401 (replay window) even with a valid HMAC', async () => {
    // Locks in the 5-minute replay guard (WEBHOOK_TIMESTAMP_TOLERANCE_MS): a
    // captured, correctly-HMAC-signed request replayed hours later must NOT be
    // honored. We compute a VALID signature over a stale timestamp, so the ONLY
    // thing rejecting it is the replay window — the response still surfaces as
    // signature_invalid (callers map every non-ok verify result to that), and
    // nothing is suppressed.
    const target = 'replay@berkeley.edu';
    const staleTs = '1700000000'; // Nov 2023 — far outside the 5-minute window.
    const rawBody = JSON.stringify({
      type: 'email.bounced',
      data: { to: target, bounce: { type: 'Permanent' } },
    });
    const signedContent = `msg_test_1.${staleTs}.${rawBody}`;
    const sig = createHmac('sha256', WEBHOOK_KEY).update(signedContent).digest('base64');
    const res = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: {
            'Content-Type': 'application/json',
            'svix-id': 'msg_test_1',
            'svix-timestamp': staleTs,
            'svix-signature': `v1,${sig}`,
          },
        }),
      ),
    );
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('signature_invalid');
    expect(await isSuppressed(t.db, target)).toBe(false);
  });

  it('AC-13b: a missing signature header returns 401 signature_invalid', async () => {
    const rawBody = JSON.stringify({ type: 'email.complained', data: { to: 'x@berkeley.edu' } });
    const res = await req(t.app, 'POST', '/api/webhooks/resend', undefined);
    expect(res.status).toBe(401);
    // (req with no body sends no svix headers → missing_headers → 401.)
    void rawBody;
  });

  it('AC-13c: accepts exactly 32,768 raw bytes into signature/parse handling', async () => {
    const rawBody = 'x'.repeat(32_768);
    const signed = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );
    expect(signed.status).toBe(204);

    const missingSignature = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    expect(missingSignature.status).toBe(401);
  });

  it.each(['good', 'bad', 'missing'] as const)(
    'AC-13c: rejects 32,769 raw bytes before %s signature handling without logging untrusted data',
    async (signatureKind) => {
      const rawBody = `UNTRUSTED-SENTINEL${'x'.repeat(32_769 - 'UNTRUSTED-SENTINEL'.length)}`;
      const rawSignature = 'v1,UNTRUSTED-SIGNATURE-SENTINEL';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (signatureKind === 'good') Object.assign(headers, signWebhook(rawBody));
      if (signatureKind === 'bad') {
        Object.assign(headers, {
          'svix-id': 'msg_oversized',
          'svix-timestamp': Math.floor(Date.now() / 1_000).toString(),
          'svix-signature': rawSignature,
        });
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      const response = await Promise.resolve(
        t.app.request(
          new Request('http://localhost/api/webhooks/resend', {
            method: 'POST',
            body: rawBody,
            headers,
          }),
        ),
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: {
          code: 'payload_too_large',
          message: 'request body exceeds the 32 KiB limit',
        },
      });
      const logs = JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...info.mock.calls]);
      expect(logs).toContain('payload_too_large');
      expect(logs).not.toContain('UNTRUSTED-SENTINEL');
      expect(logs).not.toContain('UNTRUSTED-SIGNATURE-SENTINEL');
      expect(logs).not.toContain('msg_oversized');
    },
  );

  it('AC-13a: a correctly-signed hard-bounce returns 204 and suppresses the address', async () => {
    const target = 'bounce@berkeley.edu';
    const rawBody = JSON.stringify({
      type: 'email.bounced',
      data: { to: target, bounce: { type: 'Permanent' } },
    });
    // Send the EXACT rawBody we signed — req() would re-serialize and break the
    // signature, so build the Request directly.
    const signed = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );
    expect(signed.status).toBe(204);
    expect(await isSuppressed(t.db, target)).toBe(true);
  });

  it('AC-13a: a correctly-signed complaint returns 204 and suppresses the address', async () => {
    const target = 'complaint@berkeley.edu';
    const rawBody = JSON.stringify({ type: 'email.complained', data: { to: target } });
    const signed = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );
    expect(signed.status).toBe(204);
    expect(await isSuppressed(t.db, target)).toBe(true);
  });

  it('returns 5xx when a signed suppression cannot be persisted so Resend retries', async () => {
    const target = 'retry-complaint@berkeley.edu';
    const repo = makeServerRepo(t.db);
    const { port } = makeOutboxPort(t.db);
    const failingApp = createApp(
      {
        ...repo,
        async suppressEmail() {
          throw new Error('database unavailable');
        },
      },
      port,
    );
    const rawBody = JSON.stringify({ type: 'email.complained', data: { to: target } });
    const res = await Promise.resolve(
      failingApp.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );

    expect(res.status).toBe(500);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('internal_error');
    expect(await isSuppressed(t.db, target)).toBe(false);
  });

  it('AC-13a: after suppression, confirmation/manage-link sends to that address are withheld; resend still 202', async () => {
    // Subscribe + confirm a subscriber, then suppress their address via webhook.
    const target = 'suppressme@berkeley.edu';
    await subscribeAndConfirm(t, target, [CK_189]);
    const outboxAfterSubscribe = t.notifier.outbox.filter((e) => e.to === target).length;

    const rawBody = JSON.stringify({ type: 'email.complained', data: { to: target } });
    const signed = await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );
    expect(signed.status).toBe(204);
    expect(await isSuppressed(t.db, target)).toBe(true);

    // Resend still returns 202 (non-enumerating, FR-10) but the notifier withholds
    // the manage-link mail for the suppressed address (no new outbox entry).
    const resend = await req(t.app, 'POST', '/api/subscriptions/resend', { email: target });
    expect(resend.status).toBe(202);
    const outboxAfterResend = t.notifier.outbox.filter((e) => e.to === target).length;
    expect(outboxAfterResend).toBe(outboxAfterSubscribe);
  });

  it.each(['Temporary', 'transient', 'soft'])(
    'AC-13: a %s bounce is NOT suppressed',
    async (bounceType) => {
      const target = 'soft@berkeley.edu';
      const rawBody = JSON.stringify({
        type: 'email.bounced',
        data: { to: target, bounce: { type: bounceType } },
      });
      const signed = await Promise.resolve(
        t.app.request(
          new Request('http://localhost/api/webhooks/resend', {
            method: 'POST',
            body: rawBody,
            headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
          }),
        ),
      );
      expect(signed.status).toBe(204);
      expect(await isSuppressed(t.db, target)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// AC-7: Unsubscribe → token no longer manages; one-click POST works too
// ---------------------------------------------------------------------------

describe('AC-7: unsubscribe → token invalid for manage; subscriber + watches gone', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('AC-7: DELETE /api/subscriptions/:token returns 204', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    const delRes = await req(t.app, 'DELETE', `/api/subscriptions/${token}`);
    expect(delRes.status).toBe(204);
  });

  it('AC-7: GET with the same token after unsubscribe returns 404 not_found', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await req(t.app, 'DELETE', `/api/subscriptions/${token}`);

    const manageRes = await req(t.app, 'GET', `/api/subscriptions/${token}`);
    expect(manageRes.status).toBe(404);
    expect((await json<{ error: { code: string } }>(manageRes)).error.code).toBe('not_found');
  });

  it('AC-7: the RFC 8058 one-click POST unsubscribe also removes the subscriber (204)', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    // The one-click target accepts and ignores its body.
    const oneClick = await req(
      t.app,
      'POST',
      `/api/subscriptions/${token}/unsubscribe`,
      'List-Unsubscribe=One-Click',
    );
    expect(oneClick.status).toBe(204);

    const manageRes = await req(t.app, 'GET', `/api/subscriptions/${token}`);
    expect(manageRes.status).toBe(404);
  });

  it('after unsubscribe, re-subscribing with the same email creates a fresh subscription (202)', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await req(t.app, 'DELETE', `/api/subscriptions/${token}`);

    const secondRes = await req(t.app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    expect(secondRes.status).toBe(202);
  });

  it('POST watches with the old token after unsubscribe returns 404', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await req(t.app, 'DELETE', `/api/subscriptions/${token}`);

    const addRes = await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, {
      classKey: CK_61A,
    });
    expect(addRes.status).toBe(404);
  });

  it('a second DELETE with the same token returns 404 (row already gone)', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await req(t.app, 'DELETE', `/api/subscriptions/${token}`);
    const again = await req(t.app, 'DELETE', `/api/subscriptions/${token}`);
    expect(again.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC-16c: Push registration is rejected (409) while Pending; push routes
// ---------------------------------------------------------------------------

describe('AC-16c: push enable requires Confirmed; vapid-public-key route', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    t = await makeTestApp({
      rateLimitConfig: {
        subscribeMax: 100,
        subscribeWindowSeconds: 60,
        emailMax: 100,
        emailWindowSeconds: 900,
      },
    });
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  const pushBody = {
    endpoint: 'https://push.example.com/endpoint/abc',
    keys: VALID_PUSH_KEYS,
  };

  it('AC-16c: a PENDING subscriber registering push gets 409 conflict (confirm first)', async () => {
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    const token = confirmTokenFromOutbox(t.notifier.outbox, VALID_EMAIL);

    const res = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, pushBody);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('conflict');
  });

  it('AC-16c: a CONFIRMED subscriber registering push gets 201 enabled', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    const res = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, pushBody);
    expect(res.status).toBe(201);
    expect((await json<{ status: string }>(res)).status).toBe('enabled');
  });

  it('push register is an idempotent upsert — re-registering the same endpoint is 201', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    await req(t.app, 'POST', `/api/subscriptions/${token}/push`, pushBody);
    const again = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, pushBody);
    expect(again.status).toBe(201);
  });

  it('caps one subscriber at five push endpoints while preserving idempotent re-registration', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    for (let i = 0; i < 5; i++) {
      const res = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
        endpoint: `https://push.example.com/cap/${i}`,
        keys: VALID_PUSH_KEYS,
      });
      expect(res.status).toBe(201);
    }

    const sixth = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
      endpoint: 'https://push.example.com/cap/5',
      keys: VALID_PUSH_KEYS,
    });
    expect(sixth.status).toBe(409);
    expect((await json<{ error: { code: string } }>(sixth)).error.code).toBe('conflict');

    const refreshExisting = await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
      endpoint: 'https://push.example.com/cap/0',
      keys: VALID_PUSH_KEYS,
    });
    expect(refreshExisting.status).toBe(201);
  });

  it('cannot delete an endpoint after another subscriber takes ownership', async () => {
    const firstEmail = 'first-owner@berkeley.edu';
    const secondEmail = 'second-owner@berkeley.edu';
    const firstToken = await subscribeAndConfirm(t, firstEmail, [CK_189]);
    const secondToken = await subscribeAndConfirm(t, secondEmail, [CK_61A]);
    const endpoint = 'https://push.example.com/reassigned';

    await req(t.app, 'POST', `/api/subscriptions/${firstToken}/push`, {
      endpoint,
      keys: VALID_PUSH_KEYS,
    });
    await req(t.app, 'POST', `/api/subscriptions/${secondToken}/push`, {
      endpoint,
      keys: VALID_PUSH_KEYS,
    });
    const staleOwnerDelete = await req(t.app, 'DELETE', `/api/subscriptions/${firstToken}/push`, {
      endpoint,
    });
    expect(staleOwnerDelete.status).toBe(204);

    const second = await getSubscriberByEmail(t.db, secondEmail);
    expect(second).toBeDefined();
    const remaining = await listPushSubscriptions(t.db, second!.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe(endpoint);
  });

  it('DELETE push for an unknown endpoint is idempotent (204)', async () => {
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189]);
    const res = await req(t.app, 'DELETE', `/api/subscriptions/${token}/push`, {
      endpoint: 'https://push.example.com/never-registered',
    });
    expect(res.status).toBe(204);
  });

  it('push register with a bad token returns 401', async () => {
    const res = await req(t.app, 'POST', '/api/subscriptions/garbage/push', pushBody);
    expect(res.status).toBe(401);
  });

  it('vapid-public-key returns null when VAPID is unconfigured', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await req(t.app, 'GET', '/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect((await json<{ publicKey: string | null }>(res)).publicKey).toBeNull();
  });

  it('vapid-public-key returns the key string when VAPID is configured', async () => {
    process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC_KEY;
    const { port } = makeOutboxPort(t.db);
    const configuredApp = createApp(makeServerRepo(t.db), port);
    const res = await req(configuredApp, 'GET', '/api/push/vapid-public-key');
    expect((await json<{ publicKey: string | null }>(res)).publicKey).toBe(TEST_VAPID_PUBLIC_KEY);
  });

  it('vapid-public-key returns null while the configured signing worker is unavailable', async () => {
    process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC_KEY;
    const { port } = makeOutboxPort(t.db);
    const configuredApp = createApp(makeServerRepo(t.db), port, {
      isPushOperational: () => false,
    });
    const res = await req(configuredApp, 'GET', '/api/push/vapid-public-key');
    expect((await json<{ publicKey: string | null }>(res)).publicKey).toBeNull();
  });

  it('mismatched VAPID key pairs fail app construction', () => {
    process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
    const { port } = makeOutboxPort(t.db);
    expect(() => createApp(makeServerRepo(t.db), port)).toThrow(/matching P-256 pair/);
  });

  it('partial VAPID configuration fails app construction', () => {
    process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE_KEY;
    const { port } = makeOutboxPort(t.db);
    expect(() => createApp(makeServerRepo(t.db), port)).toThrow(/without VAPID_PUBLIC_KEY/);
  });
});

describe('v0.3.3 server startup configuration probes', () => {
  let db: Db;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    db = await makeTestDb();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    delete process.env.MAIL_TRANSPORT;
    delete process.env.MAIL_PROVIDER;
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.DISABLE_RATE_LIMIT;
    delete process.env.NODE_ENV;
    delete process.env.NOOP_OUTBOX_FILE;
  });

  it('fails before serving when a real transport has no usable TOKEN_SECRET', () => {
    delete process.env.TOKEN_SECRET;
    process.env.MAIL_TRANSPORT = 'real';
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

    expect(() => createApp(makeServerRepo(db))).toThrow(/TOKEN_SECRET/);
  });

  it('forbids the noop transport in production before serving', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAIL_TRANSPORT = 'noop';
    delete process.env.RESEND_WEBHOOK_SECRET;

    expect(() =>
      createApp(makeServerRepo(db), undefined, { rateLimiter: fakeRedisLimiter() }),
    ).toThrow(/MAIL_TRANSPORT=real/);
  });

  it('rejects the rate-limit escape hatch in production but permits it in development', () => {
    process.env.DISABLE_RATE_LIMIT = '1';
    process.env.NODE_ENV = 'production';
    expect(() => createApp(makeServerRepo(db))).toThrow(/DISABLE_RATE_LIMIT/);

    process.env.NODE_ENV = 'development';
    expect(() => createApp(makeServerRepo(db))).not.toThrow();
  });

  it('fails before serving when Resend webhook verification is unconfigured', () => {
    process.env.MAIL_TRANSPORT = 'real';
    process.env.MAIL_PROVIDER = 'resend';
    delete process.env.RESEND_WEBHOOK_SECRET;

    expect(() => createApp(makeServerRepo(db))).toThrow(/RESEND_WEBHOOK_SECRET/);
  });

  it.each(['whsec_', 'whsec_!!!!', 'short', 'a-long-bare-secret-that-must-not-be-reinterpreted'])(
    'fails before serving when the webhook HMAC key is weak or malformed: %s',
    (secret) => {
      process.env.MAIL_TRANSPORT = 'real';
      process.env.MAIL_PROVIDER = 'resend';
      process.env.RESEND_WEBHOOK_SECRET = secret;

      expect(() => createApp(makeServerRepo(db))).toThrow(/RESEND_WEBHOOK_SECRET/);
    },
  );

  it('accepts the canonical 24-byte whsec_ shape issued by Svix', () => {
    process.env.MAIL_TRANSPORT = 'real';
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.alloc(24, 0x33).toString('base64')}`;

    expect(() => createApp(makeServerRepo(db))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Token auth: 401 on bad/malformed token; 404 on valid token + missing subscriber
// ---------------------------------------------------------------------------

describe('Token auth — 401 / 404 paths', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('GET with garbage token returns 401 token_invalid', async () => {
    const res = await req(app, 'GET', '/api/subscriptions/garbage-token');
    expect(res.status).toBe(401);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('token_invalid');
  });

  it('GET with tampered signature returns 401', async () => {
    const res = await req(app, 'GET', '/api/subscriptions/validpayload.badsig');
    expect(res.status).toBe(401);
  });

  it('mintToken for a non-existent id gives 404 on GET (valid sig, missing row)', async () => {
    const forgedToken = mintToken('non-existent-id');
    const res = await req(app, 'GET', `/api/subscriptions/${forgedToken}`);
    expect(res.status).toBe(404);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('not_found');
  });

  it('POST watches with bad token returns 401', async () => {
    const res = await req(app, 'POST', '/api/subscriptions/bad-token/watches', {
      classKey: CK_189,
    });
    expect(res.status).toBe(401);
  });

  it('DELETE unsubscribe with garbage token returns 401', async () => {
    const res = await req(app, 'DELETE', '/api/subscriptions/garbage');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-8: No subscriber email, token, or push endpoint/key in any log line
// ---------------------------------------------------------------------------

describe('AC-8: structured logs contain no subscriber email, token, or push creds', () => {
  let t: TestApp;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
    t = await makeTestApp();
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it('AC-8: full subscribe→confirm→manage→push→webhook→unsubscribe flow logs no email/token/endpoint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const pushEndpoint = 'https://push.example.com/endpoint/secret-creds';
    const token = await subscribeAndConfirm(t, VALID_EMAIL, [CK_189, CK_61A]);

    await req(t.app, 'GET', `/api/subscriptions/${token}`);
    await req(t.app, 'POST', `/api/subscriptions/${token}/watches`, { classKey: CK_110 });
    await req(t.app, 'POST', `/api/subscriptions/${token}/push`, {
      endpoint: pushEndpoint,
      keys: VALID_PUSH_KEYS,
    });
    await req(t.app, 'DELETE', `/api/subscriptions/${token}/watches/${CK_189}`);

    // Suppression webhook path (recipient address must never be logged).
    const rawBody = JSON.stringify({ type: 'email.complained', data: { to: VALID_EMAIL } });
    await Promise.resolve(
      t.app.request(
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          body: rawBody,
          headers: { 'Content-Type': 'application/json', ...signWebhook(rawBody) },
        }),
      ),
    );

    await req(t.app, 'DELETE', `/api/subscriptions/${token}`);

    const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls];
    for (const call of allCalls) {
      const s = JSON.stringify(call);
      expect(s, `log line leaks email: ${s}`).not.toContain(VALID_EMAIL);
      expect(s, `log line leaks domain: ${s}`).not.toContain('example.edu');
      expect(s, `log line leaks token: ${s}`).not.toContain(token);
      expect(s, `log line leaks push endpoint: ${s}`).not.toContain(pushEndpoint);
      expect(s, `log line leaks push key: ${s}`).not.toContain(VALID_PUSH_KEYS.p256dh);
      expect(s, `log line leaks push key: ${s}`).not.toContain(VALID_PUSH_KEYS.auth);
    }
  });

  it('AC-8: a 409 duplicate-email rejection produces no log line with the email', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_189] });
    await req(t.app, 'POST', '/api/subscriptions', { email: VALID_EMAIL, classKeys: [CK_61A] });

    for (const call of [...logSpy.mock.calls, ...errSpy.mock.calls]) {
      const s = JSON.stringify(call);
      expect(s).not.toContain(VALID_EMAIL);
      expect(s).not.toContain('example.edu');
    }
  });
});
