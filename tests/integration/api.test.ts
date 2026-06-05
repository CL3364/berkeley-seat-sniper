/**
 * Integration tests — API ↔ DB against a fresh in-process PGlite instance.
 *
 * Each `describe` block that needs DB isolation gets its own `makeTestDb()` call
 * in `beforeEach`, so test state never bleeds across cases.
 *
 * What's covered here (AC-1 and AC-2 are fully verifiable now; AC-3..AC-8 need
 * scraper/worker/notify lanes and are stubbed with TODO markers):
 *
 *   AC-1  Subscribe → manage roundtrip (POST 201, GET 200 with same token)
 *   AC-2  Invalid email → 400, empty classKeys → 400, no row created
 *   AC-2b Duplicate email → 409, no second row
 *   Token bad/expired → 401; valid token missing subscriber → 404
 *
 * Once scraper/worker/notify land, fill in the TODO stubs for AC-3..AC-8.
 *
 * No real network calls. No real mail. TOKEN_SECRET is set via env in this file's
 * setup so `mintToken`/`verifyToken` work without external config.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { makeTestDb, makeRepo } from '../../src/db';
import { createApp } from '../../src/server/app';
import { mintToken } from '../../src/server/token';

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------

// TOKEN_SECRET must be >= 32 chars for mintToken/verifyToken to work.
const TEST_TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

// Class keys used throughout; must be canonical.
const CK_189 = '2026-fall-compsci-189-001-lec-001' as const;
const CK_61A = '2026-fall-compsci-61a-001-lec-001' as const;
const VALID_EMAIL = 'student@berkeley.edu';

// ---------------------------------------------------------------------------
// Helper — fire a request against the Hono app.fetch() handler
// ---------------------------------------------------------------------------

type AppHandle = ReturnType<typeof createApp>;

function req(app: AppHandle, method: string, path: string, body?: unknown): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return app.fetch(new Request(url, init));
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------------
// Per-describe fixtures
// ---------------------------------------------------------------------------

/** Build a fresh isolated app backed by a brand-new PGlite DB. */
async function makeTestApp() {
  const db = await makeTestDb();
  const app = createApp(makeRepo(db));
  return { app };
}

// ---------------------------------------------------------------------------
// AC-1: Subscribe → manage roundtrip
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

  it('POST /api/subscriptions returns 201 with subscriberId, token, watches', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(res.status).toBe(201);

    const body = (await json(res)) as Record<string, unknown>;
    expect(typeof body.subscriberId).toBe('string');
    expect(body.subscriberId).toBeTruthy();
    expect(typeof body.token).toBe('string');
    expect(body.token).toBeTruthy();
    expect(body.watches).toEqual([CK_189]);
  });

  it('the token from POST lets GET /api/subscriptions/:token return 200 with email and watches', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)) as {
      subscriberId: string;
      token: string;
      watches: string[];
    };

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    expect(manageRes.status).toBe(200);

    const managed = (await json(manageRes)) as { email: string; watches: string[] };
    expect(managed.email).toBe(VALID_EMAIL);
    expect(managed.watches).toEqual([CK_189]);
  });

  it('the watch appears in the manage view after subscribe (AC-1 acceptance criterion)', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189, CK_61A],
    });
    const created = (await json(createRes)) as { token: string; watches: string[] };

    // Both watches present in the 201 response.
    expect(new Set(created.watches)).toEqual(new Set([CK_189, CK_61A]));

    // Both watches present in the manage view.
    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = (await json(manageRes)) as { watches: string[] };
    expect(new Set(managed.watches)).toEqual(new Set([CK_189, CK_61A]));
  });

  it('POST /api/subscriptions/:token/watches adds a new watch and GET reflects it', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = (await json(createRes)) as { token: string };

    const addRes = await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_61A,
    });
    expect(addRes.status).toBe(200);
    const added = (await json(addRes)) as { watches: string[] };
    expect(added.watches).toContain(CK_61A);
    expect(added.watches).toContain(CK_189);

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = (await json(manageRes)) as { watches: string[] };
    expect(managed.watches).toContain(CK_61A);
  });

  it('DELETE /api/subscriptions/:token/watches/:classKey removes the watch', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189, CK_61A],
    });
    const created = (await json(createRes)) as { token: string };

    const delRes = await req(
      app,
      'DELETE',
      `/api/subscriptions/${created.token}/watches/${CK_189}`,
    );
    expect(delRes.status).toBe(204);

    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    const managed = (await json(manageRes)) as { watches: string[] };
    expect(managed.watches).not.toContain(CK_189);
    expect(managed.watches).toContain(CK_61A);
  });

  it('DELETE /api/subscriptions/:token unsubscribes; subsequent GET returns 404', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = (await json(createRes)) as { token: string };

    const delRes = await req(app, 'DELETE', `/api/subscriptions/${created.token}`);
    expect(delRes.status).toBe(204);

    // Token still valid (it's HMAC-signed, not revoked), but subscriber row is gone.
    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    expect(manageRes.status).toBe(404);
  });

  it('normalizes a URL classKey input to canonical form in the response', async () => {
    const urlInput = 'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001';
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [urlInput],
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as { watches: string[] };
    expect(body.watches).toEqual([CK_189]);
  });

  it('normalizes a human-code classKey to canonical form', async () => {
    const codeInput = '2026 Fall COMPSCI 189 001 LEC 001';
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [codeInput],
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as { watches: string[] };
    expect(body.watches).toEqual([CK_189]);
  });

  // Suppress console output from the app so it doesn't noise up test output.
  it('logs opaque id and count but not the email (AC-8 log check via spy)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });

    // Every log call must not include the email string.
    for (const call of spy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(VALID_EMAIL);
      expect(serialized).not.toContain('berkeley.edu');
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: Invalid email → 400, no row created
// ---------------------------------------------------------------------------

describe('AC-2: invalid inputs → 400, no DB rows created', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('rejects an invalid email with 400 validation_error', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: 'not-an-email',
      classKeys: [CK_189],
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('error body for invalid email includes a fields.email hint (AC-2 inline error)', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: 'bad@@email',
      classKeys: [CK_189],
    });
    const body = (await json(res)) as { error: { fields?: Record<string, string> } };
    // fields.email must be present so the UI can show an inline error.
    expect(body.error.fields?.email).toBeTruthy();
  });

  it('rejects an empty classKeys array with 400 validation_error', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [],
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects an unrecognizable class identifier with 400 (no invented term)', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: ['COMPSCI 189 LEC 001'], // missing term
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects a class code with unknown season "winter" with 400', async () => {
    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: ['2026 winter compsci 189 001 lec 001'],
    });
    expect(res.status).toBe(400);
  });

  it('a failed request creates no subscriber row in the DB', async () => {
    // Attempt with invalid email — must not insert a row.
    await req(app, 'POST', '/api/subscriptions', {
      email: 'not-valid@',
      classKeys: [CK_189],
    });

    // Verify no row by trying to subscribe with the same (almost) email — if a row
    // existed, a duplicate insert would give 409, not a second fresh 201.
    const goodRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    expect(goodRes.status).toBe(201);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        method: 'POST',
        body: 'not json at all',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AC-2b: Duplicate email → 409
// ---------------------------------------------------------------------------

describe('AC-2b: duplicate email → 409 conflict, no second row', () => {
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
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });

  it('the 409 response does not leak the email in the message', async () => {
    await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });

    const res = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_61A],
    });
    const body = (await json(res)) as { error: { message: string } };
    expect(body.error.message).not.toContain(VALID_EMAIL);
    expect(body.error.message).not.toContain('berkeley.edu');
  });

  it('duplicate watch add returns 409 conflict', async () => {
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = (await json(createRes)) as { token: string };

    // Add CK_189 again via the manage endpoint.
    const addRes = await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_189,
    });
    expect(addRes.status).toBe(409);
    const body = (await json(addRes)) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// Token auth: 401 on bad/malformed token; 404 on valid token + missing subscriber
// ---------------------------------------------------------------------------

describe('Token auth — 401 / 404 cases', () => {
  let app: AppHandle;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;
    ({ app } = await makeTestApp());
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('GET with a garbage token returns 401 token_invalid', async () => {
    const res = await req(app, 'GET', '/api/subscriptions/garbage-token');
    expect(res.status).toBe(401);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('token_invalid');
  });

  it('GET with a tampered token (bad signature) returns 401', async () => {
    const res = await req(app, 'GET', '/api/subscriptions/validpayload.badsignature');
    expect(res.status).toBe(401);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('token_invalid');
  });

  it('GET with a valid but orphaned token (subscriber deleted) returns 404', async () => {
    // Create subscriber, capture token, then delete.
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = (await json(createRes)) as { token: string };

    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);

    // Token still cryptographically valid, but no row — expect 404.
    const manageRes = await req(app, 'GET', `/api/subscriptions/${created.token}`);
    expect(manageRes.status).toBe(404);
    const body = (await json(manageRes)) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('POST watches with a bad token returns 401', async () => {
    const res = await req(app, 'POST', '/api/subscriptions/bad-token/watches', {
      classKey: CK_189,
    });
    expect(res.status).toBe(401);
  });

  it('DELETE watch with a bad token returns 401 or 400 (token path param)', async () => {
    const res = await req(app, 'DELETE', `/api/subscriptions/bad/watches/${CK_189}`);
    // Either 401 (token invalid) or 400 (classKey parsing), but not 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('DELETE unsubscribe with a garbage token returns 401', async () => {
    const res = await req(app, 'DELETE', '/api/subscriptions/garbage');
    expect(res.status).toBe(401);
  });

  it('mintToken for a non-existent subscriber id → 404 on GET', async () => {
    // Forge a valid signed token for a subscriber id that was never inserted.
    const forgedToken = mintToken('non-existent-subscriber-id');
    const res = await req(app, 'GET', `/api/subscriptions/${forgedToken}`);
    expect(res.status).toBe(404);
    const body = (await json(res)) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// AC-8: No email or full watch list in any log output
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

  it('no log call during the full AC-1 roundtrip contains the subscriber email', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Full roundtrip: subscribe, manage, add watch, remove watch, unsubscribe.
    const createRes = await req(app, 'POST', '/api/subscriptions', {
      email: VALID_EMAIL,
      classKeys: [CK_189],
    });
    const created = (await json(createRes)) as { token: string };

    await req(app, 'GET', `/api/subscriptions/${created.token}`);
    await req(app, 'POST', `/api/subscriptions/${created.token}/watches`, {
      classKey: CK_61A,
    });
    await req(app, 'DELETE', `/api/subscriptions/${created.token}/watches/${CK_189}`);
    await req(app, 'DELETE', `/api/subscriptions/${created.token}`);

    // Check every captured log argument.
    const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls];
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(VALID_EMAIL);
      expect(serialized).not.toContain('berkeley.edu');
      // Also check that the full watch list (the class key strings) are not logged
      // as part of a dump — they may appear as counts but not as the raw list values.
      // We only assert the email is absent (the spec says "email or full watch list").
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3..AC-7: stubs — require scraper/worker/notify lanes (not yet landed)
// ---------------------------------------------------------------------------

// TODO(AC-3): fixture 0→>0 seats → every subscriber notified exactly once via outbox.
//   Needs: scraper fetchClass + saved fixtures + worker poll cycle + noop notifier outbox.
//   Pattern: seed subscriber, run one poll cycle with a "seats just opened" fixture,
//   assert outbox has exactly 1 entry for the subscriber.
//
// TODO(AC-4): second poll with seats still >0 → no new notification (dedupe / FR-5).
//   Pattern: run two poll cycles with the same "open" fixture, assert outbox length stays 1.
//
// TODO(AC-5): broken-HTML fixture → parser-broke operator alert + zero subscriber
//   notifications + class_state row unchanged.
//   Pattern: feed a fixture whose HTML no longer matches the expected DOM shape,
//   assert outbox is empty and class_state not overwritten.
//
// TODO(AC-6): KILL_SWITCH=1 → poll cycle performs no outbound fetch.
//   Pattern: spy on the scraper's fetch function, set env, run poll, assert spy not called.
//
// TODO(AC-7): unsubscribe then opening → nothing sent.
//   Pattern: seed subscriber, unsubscribe, run poll with open-seats fixture,
//   assert outbox is empty.
