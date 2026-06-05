/**
 * Typed API client — one function per API_ROUTES entry. All server calls go
 * through here; components import nothing from fetch directly.
 *
 * Error handling: every function throws `ApiClientError` so callers get a safe
 * `ApiError` they can switch on (code, message, fields) or a network-level
 * failure with `code: 'internal_error'`.
 *
 * The request/response shapes come from the shared contract (src/shared/api.ts);
 * responses are validated with their Zod schemas before being returned.
 */

import { z } from 'zod';
import type { ApiError } from '../shared/errors';
import { ApiErrorResponseSchema } from '../shared/errors';
import {
  AddWatchRequestSchema,
  AddWatchResponseSchema,
  CreateSubscriptionRequestSchema,
  CreateSubscriptionResponseSchema,
  GetSubscriptionResponseSchema,
} from '../shared/api';
import type {
  AddWatchResponse,
  CreateSubscriptionResponse,
  GetSubscriptionResponse,
} from '../shared/api';
import type { ClassKey } from '../shared/class-key';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown by every API function when the server returns an error envelope or
 * a non-OK status. Callers switch on `error.code` for user-facing messaging.
 * `cause` preserves the underlying network/parse failure for debugging without
 * leaking it to the UI. */
export class ApiClientError extends Error {
  constructor(
    public readonly error: ApiError,
    cause?: unknown,
  ) {
    super(error.message, cause !== undefined ? { cause } : undefined);
    this.name = 'ApiClientError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse an error response, falling back to a generic `internal_error`. */
async function parseErrorEnvelope(res: Response): Promise<ApiError> {
  try {
    const body: unknown = await res.json();
    const parsed = ApiErrorResponseSchema.safeParse(body);
    if (parsed.success) return parsed.data.error;
  } catch {
    // body is not JSON; fall through
  }
  return { code: 'internal_error', message: 'an unexpected server error occurred' };
}

/** Core fetch wrapper. Throws `ApiClientError` on non-2xx or invalid response. */
async function apiFetch<T>(
  url: string,
  init: RequestInit,
  responseSchema: z.ZodTypeAny,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // Network failure (offline, DNS, etc.) — attach cause for debugging
    throw new ApiClientError(
      { code: 'internal_error', message: 'network error — check your connection and try again' },
      cause,
    );
  }

  if (!res.ok) {
    const error = await parseErrorEnvelope(res);
    throw new ApiClientError(error);
  }

  // 204 No Content — no body to parse
  if (res.status === 204) {
    return undefined as T;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiClientError({
      code: 'internal_error',
      message: 'server returned an unreadable response',
    });
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    // Unexpected shape from the server — surface as internal error
    throw new ApiClientError({
      code: 'internal_error',
      message: 'server response did not match the expected shape',
    });
  }
  return parsed.data as T;
}

/** Build a JSON body, skipping the Content-Type override for DELETE bodies. */
function jsonBody(data: unknown): { body: string } {
  return { body: JSON.stringify(data) };
}

// ---------------------------------------------------------------------------
// API functions (one per API_ROUTES entry)
// ---------------------------------------------------------------------------

/**
 * POST /api/subscriptions
 * Creates a subscription with an email + one or more class identifiers (raw
 * strings — URLs or codes). The server normalizes classKeys; parsing here via
 * ClassKeyInputSchema validates shape before sending. We accept the Zod input
 * type (z.input) so callers pass raw strings, not pre-branded ClassKey values.
 */
export async function createSubscription(raw: {
  email: string;
  classKeys: string[];
}): Promise<CreateSubscriptionResponse> {
  // Validate the request shape against the contract schema before sending
  const validated = CreateSubscriptionRequestSchema.parse(raw);
  return apiFetch<CreateSubscriptionResponse>(
    '/api/subscriptions',
    { method: 'POST', ...jsonBody(validated) },
    CreateSubscriptionResponseSchema,
  );
}

/**
 * GET /api/subscriptions/:token
 * Fetches the subscription identified by the manage token.
 */
export async function getSubscription(token: string): Promise<GetSubscriptionResponse> {
  return apiFetch<GetSubscriptionResponse>(
    `/api/subscriptions/${encodeURIComponent(token)}`,
    { method: 'GET' },
    GetSubscriptionResponseSchema,
  );
}

/**
 * POST /api/subscriptions/:token/watches
 * Adds one watch. `classKey` accepts a URL or human code; the server normalizes.
 */
export async function addWatch(token: string, classKey: string): Promise<AddWatchResponse> {
  const validated = AddWatchRequestSchema.parse({ classKey });
  return apiFetch<AddWatchResponse>(
    `/api/subscriptions/${encodeURIComponent(token)}/watches`,
    { method: 'POST', ...jsonBody(validated) },
    AddWatchResponseSchema,
  );
}

/**
 * DELETE /api/subscriptions/:token/watches/:classKey
 * Removes the given canonical class key from the watch list. Returns void (204).
 */
export async function removeWatch(token: string, classKey: ClassKey): Promise<void> {
  return apiFetch<void>(
    `/api/subscriptions/${encodeURIComponent(token)}/watches/${encodeURIComponent(classKey)}`,
    { method: 'DELETE' },
    // 204 No Content — apiFetch returns undefined before reaching this schema
    z.undefined(),
  );
}

/**
 * DELETE /api/subscriptions/:token
 * Unsubscribes the subscriber identified by the token. Returns void (204).
 */
export async function unsubscribe(token: string): Promise<void> {
  return apiFetch<void>(
    `/api/subscriptions/${encodeURIComponent(token)}`,
    { method: 'DELETE' },
    z.undefined(),
  );
}
