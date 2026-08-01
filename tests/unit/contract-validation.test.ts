/**
 * Unit tests for the API contract schemas — spec §4, FR-1, AC-2.
 *
 * Covers:
 *   - CreateSubscriptionRequestSchema: invalid email, empty classKeys (AC-2)
 *   - ClassKeyInputSchema: URL and code normalize to identical canonical key
 *   - ApiError envelope shape and the apiError() helper
 *   - API_ERROR_CODES union coverage
 */

import { describe, it, expect } from 'vitest';
import {
  AddWatchResponseSchema,
  API_ROUTES,
  CreateSubscriptionRequestSchema,
  AddWatchRequestSchema,
  GetSubscriptionResponseSchema,
  CreateSubscriptionResponseSchema,
  EnablePushRequestSchema,
  MAX_WATCHES_PER_SUBSCRIBER,
  WatchFreshnessSchema,
} from '../../src/shared/api';
import {
  ApiErrorSchema,
  ApiErrorResponseSchema,
  ApiErrorCodeSchema,
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiError,
} from '../../src/shared/errors';
import { ClassKeyInputSchema } from '../../src/shared/class-key';
import { EmailSchema, SubscriberEmailSchema } from '../../src/shared/email';

// ---------------------------------------------------------------------------
// CreateSubscriptionRequestSchema — AC-2 (invalid email / empty classKeys)
// ---------------------------------------------------------------------------

describe('CreateSubscriptionRequestSchema — AC-2 rejection cases', () => {
  const validClass = '2026-fall-compsci-189-001-lec-001';

  it('rejects an invalid email address', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'not-an-email',
      classKeys: [validClass],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.email).toBeDefined();
    }
  });

  it('rejects an empty email string', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: '',
      classKeys: [validClass],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing email field', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      classKeys: [validClass],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty classKeys array (must have at least 1)', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.classKeys).toBeDefined();
    }
  });

  it('rejects more than four classKeys', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: Array.from(
        { length: MAX_WATCHES_PER_SUBSCRIBER + 1 },
        (_, i) => `2026-fall-compsci-${String(i + 100).padStart(3, '0')}-001-lec-001`,
      ),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a classKeys entry with an unrecognizable identifier (AC-2)', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: ['not a class at all'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a classKeys entry without a term (no invented term, AC-2)', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: ['COMPSCI 189 LEC 001'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing classKeys field', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid request and normalizes classKeys to canonical form', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: '  Student@BERKELEY.EDU  ',
      classKeys: [
        'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
        '2026 Fall COMPSCI 61A 001 LEC 001',
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Email is lowercased and trimmed.
      expect(result.data.email).toBe('student@berkeley.edu');
      // Both class identifiers normalize to canonical keys.
      expect(result.data.classKeys).toEqual([
        '2026-fall-compsci-189-001-lec-001',
        '2026-fall-compsci-61a-001-lec-001',
      ]);
    }
  });

  it('rejects plus-addressing while accepting the corresponding base Berkeley address', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: '  Student+SeatAlerts@BERKELEY.EDU ',
      classKeys: [validClass],
    });
    expect(result.success).toBe(false);

    const base = CreateSubscriptionRequestSchema.safeParse({
      email: '  Student@BERKELEY.EDU ',
      classKeys: [validClass],
    });
    expect(base.success).toBe(true);
    if (base.success) expect(base.data.email).toBe('student@berkeley.edu');
  });

  it.each([
    'student@example.edu',
    'student@gmail.com',
    'student@sub.berkeley.edu',
    'student@berkeley.edu.example.com',
    'student@notberkeley.edu',
    'student@berkeley.education',
  ])('rejects a syntactically valid but ineligible subscriber domain: %s', (email) => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email,
      classKeys: [validClass],
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 1 classKey', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: [validClass],
    });
    expect(result.success).toBe(true);
  });

  it('accepts exactly four classKeys', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: Array.from(
        { length: MAX_WATCHES_PER_SUBSCRIBER },
        (_, i) => `2026-fall-compsci-${String(i + 100).padStart(3, '0')}-001-lec-001`,
      ),
    });
    expect(result.success).toBe(true);
  });
});

describe('generic and subscriber email policy remain deliberately distinct', () => {
  it('generic EmailSchema accepts a trusted non-Berkeley operations mailbox', () => {
    expect(EmailSchema.parse(' OPS@EXAMPLE.COM ')).toBe('ops@example.com');
  });

  it('SubscriberEmailSchema normalizes exact Berkeley addresses only', () => {
    expect(SubscriberEmailSchema.parse(' Student@BERKELEY.EDU ')).toBe('student@berkeley.edu');
    expect(SubscriberEmailSchema.safeParse('student+alerts@berkeley.edu').success).toBe(false);
    expect(SubscriberEmailSchema.safeParse('student@alumni.berkeley.edu').success).toBe(false);
    expect(SubscriberEmailSchema.safeParse('student@berkeley.edu.example').success).toBe(false);
  });
});

describe('EnablePushRequestSchema — public egress boundary', () => {
  const keys = {
    p256dh:
      'BL7ELU24fJTAlH5Kyl8N6BDCac8u8li_U5PIwG963MOvdYs9s7LSzj8x_7v7RFdLZ9Eap50PiiyF5K0TDAis7t0',
    auth: 'AAAAAAAAAAAAAAAAAAAAAA',
  };

  it('accepts a normal browser push-service endpoint', () => {
    expect(
      EnablePushRequestSchema.safeParse({
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/subscription',
        keys,
      }).success,
    ).toBe(true);
  });

  it.each([
    'http://push.example.com/subscription',
    'https://127.0.0.1/subscription',
    'https://[::1]/subscription',
    'https://metadata.internal/subscription',
    'https://localhost/subscription',
    'https://push.example.com:8443/subscription',
    'https://user:pass@push.example.com/subscription',
  ])('rejects a non-public push target: %s', (endpoint) => {
    expect(EnablePushRequestSchema.safeParse({ endpoint, keys }).success).toBe(false);
  });

  it('canonicalizes endpoint aliases and rejects fragments', () => {
    const parsed = EnablePushRequestSchema.parse({
      endpoint: 'https://PUSH.EXAMPLE.COM:443/a/../subscription',
      keys,
    });
    expect(parsed.endpoint).toBe('https://push.example.com/subscription');
    expect(
      EnablePushRequestSchema.safeParse({
        endpoint: 'https://push.example.com/subscription#duplicate-alias',
        keys,
      }).success,
    ).toBe(false);
    expect(
      EnablePushRequestSchema.parse({
        endpoint: 'https://push.example.com/subscription?',
        keys,
      }).endpoint,
    ).toBe('https://push.example.com/subscription');
  });

  it('rejects truncated browser key material', () => {
    expect(
      EnablePushRequestSchema.safeParse({
        endpoint: 'https://push.example.com/subscription',
        keys: { p256dh: 'short', auth: 'short' },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClassKeyInputSchema — URL and code produce identical canonical key
// ---------------------------------------------------------------------------

describe('ClassKeyInputSchema — URL and code normalize to the same canonical key', () => {
  const urlInputs = [
    'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
    'https://classes.berkeley.edu/content/2026-spring-compsci-61a-001-lec-001',
    'content/2026-summer-math-110-001-dis-002',
  ];

  const codeInputs = [
    '2026 Fall COMPSCI 189 001 LEC 001',
    '2026 SPRING COMPSCI 61A 001 LEC 001',
    '2026 Summer MATH 110 001 DIS 002',
  ];

  const expectedKeys = [
    '2026-fall-compsci-189-001-lec-001',
    '2026-spring-compsci-61a-001-lec-001',
    '2026-summer-math-110-001-dis-002',
  ];

  urlInputs.forEach((url, idx) => {
    it(`URL "${url}" normalizes to canonical key`, () => {
      const result = ClassKeyInputSchema.safeParse(url);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(expectedKeys[idx]);
      }
    });
  });

  codeInputs.forEach((code, idx) => {
    it(`code "${code}" normalizes to canonical key`, () => {
      const result = ClassKeyInputSchema.safeParse(code);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(expectedKeys[idx]);
      }
    });
  });

  it('URL and equivalent code produce the exact same canonical key', () => {
    const urlResult = ClassKeyInputSchema.safeParse(urlInputs[0]);
    const codeResult = ClassKeyInputSchema.safeParse(codeInputs[0]);
    expect(urlResult.success).toBe(true);
    expect(codeResult.success).toBe(true);
    if (urlResult.success && codeResult.success) {
      expect(urlResult.data).toBe(codeResult.data);
    }
  });
});

// ---------------------------------------------------------------------------
// ApiError envelope shape
// ---------------------------------------------------------------------------

describe('ApiErrorSchema — envelope shape', () => {
  it('accepts a minimal valid ApiError (no fields)', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'validation_error',
      message: 'invalid input',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('validation_error');
      expect(result.data.message).toBe('invalid input');
      expect(result.data.fields).toBeUndefined();
    }
  });

  it('accepts an ApiError with fields', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'validation_error',
      message: 'invalid input',
      fields: { email: 'enter a valid email address', classKeys: 'at least one required' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fields).toEqual({
        email: 'enter a valid email address',
        classKeys: 'at least one required',
      });
    }
  });

  it('rejects an unknown error code', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'unknown_code',
      message: 'something',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'not_found',
      message: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing code field', () => {
    const result = ApiErrorSchema.safeParse({ message: 'something went wrong' });
    expect(result.success).toBe(false);
  });

  it('rejects missing message field', () => {
    const result = ApiErrorSchema.safeParse({ code: 'not_found' });
    expect(result.success).toBe(false);
  });
});

describe('ApiErrorResponseSchema — wire envelope', () => {
  it('accepts a well-formed error response envelope', () => {
    const result = ApiErrorResponseSchema.safeParse({
      error: { code: 'not_found', message: 'subscription not found' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.code).toBe('not_found');
    }
  });

  it('rejects a response without the error wrapper', () => {
    // A bare ApiError (not wrapped in { error: ... }) should fail.
    const result = ApiErrorResponseSchema.safeParse({
      code: 'not_found',
      message: 'subscription not found',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a null error field', () => {
    const result = ApiErrorResponseSchema.safeParse({ error: null });
    expect(result.success).toBe(false);
  });
});

describe('ApiErrorCodeSchema — code union completeness', () => {
  it('accepts every defined error code', () => {
    for (const code of API_ERROR_CODES) {
      const result = ApiErrorCodeSchema.safeParse(code);
      expect(result.success).toBe(true);
    }
  });

  it('rejects codes outside the union', () => {
    const unknowns = ['server_error', 'bad_request', 'unauthorized', ''];
    for (const code of unknowns) {
      expect(ApiErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});

describe('API_ERROR_STATUS — HTTP status mapping', () => {
  it('maps validation_error to 400', () => {
    expect(API_ERROR_STATUS.validation_error).toBe(400);
  });
  it('maps not_found to 404', () => {
    expect(API_ERROR_STATUS.not_found).toBe(404);
  });
  it('maps conflict to 409', () => {
    expect(API_ERROR_STATUS.conflict).toBe(409);
  });
  it('maps watch_limit_reached to 409', () => {
    expect(API_ERROR_STATUS.watch_limit_reached).toBe(409);
  });
  it('maps token_invalid to 401', () => {
    expect(API_ERROR_STATUS.token_invalid).toBe(401);
  });
  it('maps rate_limited to 429', () => {
    expect(API_ERROR_STATUS.rate_limited).toBe(429);
  });
  it('maps payload_too_large to 413', () => {
    expect(API_ERROR_STATUS.payload_too_large).toBe(413);
  });
  it('maps capacity_exceeded to 503', () => {
    expect(API_ERROR_STATUS.capacity_exceeded).toBe(503);
  });
  it('maps internal_error to 500', () => {
    expect(API_ERROR_STATUS.internal_error).toBe(500);
  });
  it('has an entry for every defined error code', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeTypeOf('number');
    }
  });
});

describe('API_ROUTES — v0.4 error surface', () => {
  it('declares payload_too_large on every bounded public body route', () => {
    expect(API_ROUTES.createSubscription.errors).toContain('payload_too_large');
    expect(API_ROUTES.resendManageLink.errors).toContain('payload_too_large');
    expect(API_ROUTES.addWatch.errors).toContain('payload_too_large');
    expect(API_ROUTES.resendWebhook.errors).toContain('payload_too_large');
  });

  it('declares capacity_exceeded only where a new unique watch may be admitted', () => {
    expect(API_ROUTES.createSubscription.errors).not.toContain('capacity_exceeded');
    expect(API_ROUTES.confirmSubscription.errors).toContain('capacity_exceeded');
    expect(API_ROUTES.addWatch.errors).toContain('capacity_exceeded');
    expect(API_ROUTES.resendManageLink.errors).not.toContain('capacity_exceeded');
  });

  it('declares distinct watch-cap and push rate-limit errors', () => {
    expect(API_ROUTES.addWatch.errors).toContain('watch_limit_reached');
    expect(API_ROUTES.enablePush.errors).toContain('rate_limited');
  });
});

describe('apiError() helper', () => {
  it('constructs a wrapped envelope with no fields', () => {
    const env = apiError('not_found', 'subscription not found');
    expect(env).toEqual({ error: { code: 'not_found', message: 'subscription not found' } });
    expect(ApiErrorResponseSchema.safeParse(env).success).toBe(true);
  });

  it('constructs a wrapped envelope with fields', () => {
    const env = apiError('validation_error', 'invalid input', {
      email: 'not a valid email',
    });
    expect(env.error.fields).toEqual({ email: 'not a valid email' });
    expect(ApiErrorResponseSchema.safeParse(env).success).toBe(true);
  });

  it('omits fields key when no fields provided', () => {
    const env = apiError('internal_error', 'unexpected error');
    expect('fields' in env.error).toBe(false);
  });

  it('output validates against ApiErrorResponseSchema', () => {
    for (const code of API_ERROR_CODES) {
      const env = apiError(code, 'test message');
      expect(ApiErrorResponseSchema.safeParse(env).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AddWatchRequestSchema — spot-check the watch-add endpoint boundary
// ---------------------------------------------------------------------------

describe('AddWatchRequestSchema', () => {
  it('accepts a URL as classKey and normalizes it', () => {
    const result = AddWatchRequestSchema.safeParse({
      classKey: 'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classKey).toBe('2026-fall-compsci-189-001-lec-001');
    }
  });

  it('accepts a human code and normalizes it', () => {
    const result = AddWatchRequestSchema.safeParse({
      classKey: '2026 Fall COMPSCI 189 001 LEC 001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classKey).toBe('2026-fall-compsci-189-001-lec-001');
    }
  });

  it('rejects a missing classKey', () => {
    expect(AddWatchRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unrecognizable classKey', () => {
    expect(AddWatchRequestSchema.safeParse({ classKey: 'garbage' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Response schema shape tests
// ---------------------------------------------------------------------------

describe('CreateSubscriptionResponseSchema — v0.3 double opt-in (202 pending)', () => {
  it('AC-1: accepts the constant 202 body { status: "pending" }', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({ status: 'pending' });
    expect(result.success).toBe(true);
  });

  it('AC-1: the parsed body never carries a token (stripped — token only travels by email, D3)', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      status: 'pending',
      token: 'signed.token.here',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The schema's parsed shape is exactly { status } — any leaked token is
      // stripped, so the contract can never serialize a token in the 202 body.
      expect(result.data).toEqual({ status: 'pending' });
      expect('token' in result.data).toBe(false);
    }
  });

  it('AC-1: the parsed body never carries a subscriberId', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      status: 'pending',
      subscriberId: 'sub-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('subscriberId' in result.data).toBe(false);
    }
  });

  it('rejects a wrong status literal', () => {
    expect(CreateSubscriptionResponseSchema.safeParse({ status: 'confirmed' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(CreateSubscriptionResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('watch freshness response schemas — v0.4', () => {
  const classKey = '2026-fall-compsci-189-001-lec-001';
  const observedFreshness = {
    classKey,
    source: 'public-class-page',
    lastCheckedAt: '2026-07-23T20:00:00.000Z',
    sourceStale: false,
    displayName: 'COMPSCI 189 001 - LEC 001',
    openSeats: 3,
    enrolled: 347,
    capacity: 350,
    waitlisted: 100,
    waitlistMax: 100,
    waitlistOpen: false,
  } as const;

  it('accepts a well-formed manage-view response with same-order watchFreshness', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'student@berkeley.edu',
      confirmed: true,
      watches: [classKey],
      watchFreshness: [observedFreshness],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a never-observed stale entry for a Pending subscriber', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'student@berkeley.edu',
      confirmed: false,
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
          waitlistOpen: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a response missing watchFreshness', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'student@berkeley.edu',
      confirmed: true,
      watches: [classKey],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ineligible subscriber email in the response', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'student@example.edu',
      confirmed: true,
      watches: [classKey],
      watchFreshness: [observedFreshness],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid source or timestamp', () => {
    expect(
      WatchFreshnessSchema.safeParse({
        ...observedFreshness,
        source: 'sis-api',
      }).success,
    ).toBe(false);
    expect(
      WatchFreshnessSchema.safeParse({
        ...observedFreshness,
        lastCheckedAt: 'yesterday',
      }).success,
    ).toBe(false);
  });

  it('requires every dashboard field on the wire while accepting explicit nulls', () => {
    const missingDisplayName: Record<string, unknown> = { ...observedFreshness };
    delete missingDisplayName.displayName;
    expect(WatchFreshnessSchema.safeParse(missingDisplayName).success).toBe(false);
    expect(
      WatchFreshnessSchema.safeParse({
        ...observedFreshness,
        displayName: null,
        openSeats: null,
        enrolled: null,
        capacity: null,
        waitlisted: null,
        waitlistMax: null,
        waitlistOpen: null,
      }).success,
    ).toBe(true);
  });

  it('requires watchFreshness on add-watch responses too', () => {
    expect(
      AddWatchResponseSchema.safeParse({
        watches: [classKey],
        watchFreshness: [observedFreshness],
      }).success,
    ).toBe(true);
    expect(AddWatchResponseSchema.safeParse({ watches: [classKey] }).success).toBe(false);
  });
});
