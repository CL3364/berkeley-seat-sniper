/**
 * Integration tests — API ↔ DB (AC-1, AC-2, AC-2b, AC-7, AC-8).
 *
 * Stack: createApp(makeRepo(makeTestDb())) — a real Hono app backed by a fresh
 * in-process PGlite instance per describe block. No port binding, no real
 * network, no real mail. TOKEN_SECRET is set in beforeEach.
 *
 * app.request() returns `Response | Promise<Response>`; we normalize through
 * Promise.resolve() so every helper returns Promise<Response> cleanly.
 *
 * AC-3..AC-6 require worker/scraper/notify lanes (not yet landed) and are
 * stubbed as TODO comments at the bottom.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { makeTestDb, makeRepo } from '../../src/db';
import { createApp } from '../../src/server/app';
import { mintToken } from '../../src/server/token';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

const CK_189 = '2026-fall-compsci-189-001-lec-001' as const;
const CK_61A = '2026-fall-compsci-61a-001-lec-001' as const;
const CK_110 = '2026-spring-math-110-001-lec-001' as const;
const VALID_EMAIL = 'student@berkeley.edu';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppHandle = ReturnType<typeof createApp>;

/** Fire a request against the Hono app without binding a port. */
async function req(
  app: AppHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  // app.request returns Response | Promise<Response>; normalize to Promise.
  return Promise.resolve(app.request(new Request(url, init)));
}

async function json<T = unknown>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

/** Create a fresh isolated app + PGlite DB for one describe block. */
async function makeTestApp(): Promise<{ app: AppHandle }> {
  const db = await makeTestDb();
  return { app: createApp(makeRepo(db)) };
}

// ---------------------------------------------------------------------------
// AC-1: Subscribe → manage roundtrip (FR-1, FR-2)
// ---------------------------------------------------------------------------

describe('AC-1: subscribe → manage roundtrip', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('POST /api/subscriptions returns 201 with subscriberId, token, and watches', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(res.status).toBe(201);

    const body = await json<Record<string, unknown>>(res);
    expect(typeof body.subscriberId).toBe('string');
    expect(body.subscriberId).toBeTruthy();
    expect(typeof body.token).toBe('string');
    expect(body.token).toBeTruthy();
    expect(body.watches).toEqual([CK_189]);
  });

  it('the token from 201 lets GET return 200 with email and watches (AC-1 core)', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(createRes.status).toBe(201);
    const created = await json<{ token: string; watches: string[] }>(createRes);

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    expect(manageRes.status).toBe(200);

    const managed = await json<{ email: string; watches: string[] }>(manageRes);
    expect(managed.email).toBe(VALID_EMAIL);
    expect(managed.watches).toEqual([CK_189]);
  });

  it('subscribing with a class URL normalizes to the canonical key', async () => {
    const urlInput = `https://classes.berkeley.edu/content/${CK_189}`;
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [urlInput],
    });
    expect(res.status).toBe(201);
    const body = await json<{ watches: string[] }>(res);
    expect(body.watches).toEqual([CK_189]);
  });

  it('subscribing with a human code normalizes to the canonical key', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: ['2026 Fall COMPSCI 189 001 LEC 001'],
    });
    expect(res.status).toBe(201);
    const body = await json<{ watches: string[] }>(res);
    expect(body.watches).toEqual([CK_189]);
  });

  it('subscribing with multiple class keys returns all watches in 201 and manage view', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189, CK_61A],
    });
    expect(createRes.status).toBe(201);
    const created = await json<{ token: string; watches: string[] }>(createRes);
    expect(new Set(created.watches)).toEqual(new Set([CK_189, CK_61A]));

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = await json<{ watches: string[] }>(manageRes);
    expect(new Set(managed.watches)).toEqual(new Set([CK_189, CK_61A]));
  });

  it('POST .../watches adds a new watch and GET reflects it', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    const addRes = await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_61A,
    });
    expect(addRes.status).toBe(200);
    const added = await json<{ watches: string[] }>(addRes);
    expect(added.watches).toContain(CK_61A);
    expect(added.watches).toContain(CK_189);

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = await json<{ watches: string[] }>(manageRes);
    expect(managed.watches).toContain(CK_61A);
  });

  it('DELETE .../watches/:classKey removes that watch and GET no longer shows it', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189, CK_61A],
    });
    const created = await json<{ token: string }>(createRes);

    const delRes = await req(
      app,
      'DELETE',
      `/api/subscriptions/${created.token}/watches/${CK_189}`,
    );
    expect(delRes.status).toBe(204);

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = await json<{ watches: string[] }>(manageRes);
    expect(managed.watches).not.toContain(CK_189);
    expect(managed.watches).toContain(CK_61A);
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

  it('failed POST creates no subscriber row — a valid POST after it succeeds with 201', async () => {
    // If the bad request created a row, the good one would hit 409.
    await req(app, 'POST', '/api/subscriptions', {
      email: 'not-valid@',
      classKeys: [CK_189],
    });
    const goodRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(goodRes.status).toBe(201);
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

  it('missing email field returns 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', { classKeys: [CK_189] });
    expect(res.status).toBe(400);
  });

  it('missing classKeys field returns 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', { email: VALID_EMAIL });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AC-2b: Duplicate email → 409 conflict; existing subscription unchanged
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

  it('second POST with the same email returns 409 conflict', async () => {
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('conflict');
  });

  it('409 response body is the bare {error} envelope — no token, subscriberId, or watches', async () => {
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    const body = await json<Record<string, unknown>>(res);
    // Must have the error envelope.
    expect(body.error).toBeDefined();
    // Must NOT expose subscription fields.
    expect(body.token).toBeUndefined();
    expect(body.subscriberId).toBeUndefined();
    expect(body.watches).toBeUndefined();
  });

  it('409 response message does not contain the subscriber email', async () => {
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    const body = await json<{ error: { message: string } }>(res);
    expect(body.error.message).not.toContain(VALID_EMAIL);
    expect(body.error.message).not.toContain('berkeley.edu');
  });

  it('the first subscription is unchanged after a 409 — original token still works', async () => {
    const firstRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const first = await json<{ token: string; watches: string[] }>(firstRes);

    // Attempt duplicate.
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });

    // Original token still retrieves original subscription unchanged.
    const manageRes = await req(app, 'GET', `/api/subscriptions/${first.token}`);
    expect(manageRes.status).toBe(200);
    const managed = await json<{ email: string; watches: string[] }>(manageRes);
    expect(managed.email).toBe(VALID_EMAIL);
    expect(managed.watches).toEqual([CK_189]);
  });

  it('duplicate watch add via manage endpoint returns 409', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    const addRes = await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_189,
    });
    expect(addRes.status).toBe(409);
    const body = await json<{ error: { code: string } }>(addRes);
    expect(body.error.code).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// AC-7: Unsubscribe → subsequent opening sends nothing; GET returns 404
// ---------------------------------------------------------------------------

describe('AC-7: unsubscribe → token invalid for manage; subscriber + watches gone', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('DELETE /api/subscriptions/:token returns 204', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    const delRes = await req(app, 'DELETE', `/api/subscriptions/${created.token}`);
    expect(delRes.status).toBe(204);
  });

  it('GET with the same token after unsubscribe returns 404 not_found', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);

    // Token is still cryptographically valid but subscriber row is gone.
    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    expect(manageRes.status).toBe(404);
    const body = await json<{ error: { code: string } }>(manageRes);
    expect(body.error.code).toBe('not_found');
  });

  it('after unsubscribe, re-subscribing with the same email creates a fresh subscription (AC-7)', async () => {
    // Unsubscribe removes the row, so the same email can subscribe again cleanly.
    const firstRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const first = await json<{ token: string }>(firstRes);

    await req(app, 'DELETE', `/api/subscriptions/${first.token}`);

    const secondRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    expect(secondRes.status).toBe(201);
    const second = await json<{ watches: string[] }>(secondRes);
    expect(second.watches).toEqual([CK_61A]);
  });

  it('POST watches with the old token after unsubscribe returns 404', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);

    const addRes = await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_61A,
    });
    // Token verifies OK but subscriber row is gone → 404.
    expect(addRes.status).toBe(404);
  });

  it('a second DELETE with the same token returns 404 (idempotent delete / row already gone)', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = await json<{ token: string }>(createRes);

    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);
    const again = await req(app, 'DELETE', `/api/subscriptions/${created.token}`);
    expect(again.status).toBe(404);
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
// AC-8: No subscriber email or full watch list in any log line
// ---------------------------------------------------------------------------

describe('AC-8: structured logs contain no subscriber email or full watch list', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('full AC-1 + AC-7 roundtrip produces no log line containing the subscriber email', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Subscribe.
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189, CK_61A],
    });
    const created = await json<{ token: string }>(createRes);

    // Manage view.
    await req(app, 'GET', `/api/subscriptions/${created.token}`);

    // Add a watch.
    await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_110,
    });

    // Remove a watch.
    await req(app, 'DELETE', `/api/subscriptions/${created.token}/watches/${CK_189}`);

    // Unsubscribe.
    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);

    // Verify all captured log arguments.
    const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls];
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized, `log line contains subscriber email: ${serialized}`).not.toContain(
        VALID_EMAIL,
      );
      expect(serialized, `log line contains email domain: ${serialized}`).not.toContain(
        'berkeley.edu',
      );
    }
  });

  it('a 409 duplicate-email rejection produces no log line with the email', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });

    for (const call of [...logSpy.mock.calls, ...errSpy.mock.calls]) {
      const s = JSON.stringify(call);
      expect(s).not.toContain(VALID_EMAIL);
      expect(s).not.toContain('berkeley.edu');
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3..AC-6: stubs — require worker/scraper/notify lanes (not yet landed)
// ---------------------------------------------------------------------------

// TODO(AC-3): fixture 0→>0 → every subscriber notified exactly once via noop outbox.
//   import { runPollCycle } from '../../src/worker/...'
//   import { createNotifier } from '../../src/notify'
//   import { parseClassPage } from '../../src/scraper/parse'
//   Pattern: seed subscriber via makeTestDb + makeRepo, run one cycle with a fake
//   fetchClass returning parseClassPage(readFixture('open-seats.html'), classKey),
//   assert notifier.outbox has exactly 1 entry with kind='subscriber'.
//
// TODO(AC-4): second poll with seats still >0 → no new notification (dedupe / FR-5).
//   Pattern: run two cycles with the same open-seats fixture, assert outbox.length stays 1.
//
// TODO(AC-5): changed-shape fixture → parser-broke operator alert + zero subscriber
//   notifications + class_state row NOT overwritten.
//   Pattern: feed changed-shape.html fixture, assert outbox has 1 entry kind='operator'
//   and zero kind='subscriber', and class_state for the key is undefined.
//
// TODO(AC-6): KILL_SWITCH=1 → poll cycle performs no outbound fetch.
//   Pattern: spy on the fetchImpl passed to fetchClass (or on globalThis.fetch),
//   set process.env.KILL_SWITCH='1', run cycle, assert spy was never called.
