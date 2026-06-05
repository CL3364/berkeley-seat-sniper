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
  CreateSubscriptionRequestSchema,
  AddWatchRequestSchema,
  GetSubscriptionResponseSchema,
  CreateSubscriptionResponseSchema,
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

  it('rejects more than 50 classKeys', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: Array.from(
        { length: 51 },
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

  it('accepts exactly 1 classKey', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: [validClass],
    });
    expect(result.success).toBe(true);
  });

  it('accepts exactly 50 classKeys', () => {
    const result = CreateSubscriptionRequestSchema.safeParse({
      email: 'student@berkeley.edu',
      classKeys: Array.from(
        { length: 50 },
        (_, i) => `2026-fall-compsci-${String(i + 100).padStart(3, '0')}-001-lec-001`,
      ),
    });
    expect(result.success).toBe(true);
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
  it('maps token_invalid to 401', () => {
    expect(API_ERROR_STATUS.token_invalid).toBe(401);
  });
  it('maps rate_limited to 429', () => {
    expect(API_ERROR_STATUS.rate_limited).toBe(429);
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

describe('CreateSubscriptionResponseSchema', () => {
  it('accepts a well-formed 201 response', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      subscriberId: 'sub-abc-123',
      token: 'signed.token.here',
      watches: ['2026-fall-compsci-189-001-lec-001'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty subscriberId', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      subscriberId: '',
      token: 'tok',
      watches: ['2026-fall-compsci-189-001-lec-001'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-canonical key in watches', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      subscriberId: 'sub-1',
      token: 'tok',
      watches: ['COMPSCI 189'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty watches array (subscriber with no active watches)', () => {
    const result = CreateSubscriptionResponseSchema.safeParse({
      subscriberId: 'sub-1',
      token: 'tok',
      watches: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('GetSubscriptionResponseSchema', () => {
  it('accepts a well-formed manage-view response', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'student@berkeley.edu',
      watches: ['2026-fall-compsci-189-001-lec-001'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email in the response', () => {
    const result = GetSubscriptionResponseSchema.safeParse({
      email: 'not-an-email',
      watches: [],
    });
    expect(result.success).toBe(false);
  });
});
