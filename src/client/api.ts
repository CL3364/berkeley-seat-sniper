/**
 * Typed API client — one function per API_ROUTES entry the frontend consumes.
 * All server calls go through here; components import nothing from fetch directly.
 *
 * Error handling: every function throws `ApiClientError` so callers get a safe
 * `ApiError` they can switch on (code, message, fields) or a network-level
 * failure with `code: 'internal_error'`.
 *
 * The request/response shapes come from the shared contract (src/shared/api.ts);
 * responses are validated with their Zod schemas before being returned. The
 * contract (src/shared/**) is READ-ONLY to the frontend — this client conforms
 * to it, never the other way round.
 */

import { z } from 'zod';
import type { ApiError } from '../shared/errors';
import { ApiErrorResponseSchema } from '../shared/errors';
import {
  AddWatchRequestSchema,
  AddWatchResponseSchema,
  ConfirmSubscriptionResponseSchema,
  CreateSubscriptionRequestSchema,
  CreateSubscriptionResponseSchema,
  DisablePushRequestSchema,
  EnablePushRequestSchema,
  EnablePushResponseSchema,
  GetSubscriptionResponseSchema,
  ResendManageLinkRequestSchema,
  ResendManageLinkResponseSchema,
  VapidPublicKeyResponseSchema,
} from '../shared/api';
import type {
  AddWatchResponse,
  ConfirmSubscriptionResponse,
  CreateSubscriptionResponse,
  EnablePushRequest,
  EnablePushResponse,
  GetSubscriptionResponse,
  ResendManageLinkResponse,
  VapidPublicKeyResponse,
} from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { clearStoredPilotInvite, pilotInviteCreateHeaders } from './pilot-invite';

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
    /** Parsed `Retry-After` response header, in seconds, when one was supplied. */
    public readonly retryAfterSeconds: number | null = null,
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

/** Parse either form of HTTP `Retry-After` into a non-negative delay. */
function parseRetryAfterSeconds(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}

/** Human-readable suffix for capacity/rate-limit messages. */
export function describeRetryAfter(seconds: number | null): string {
  if (seconds === null) return 'later';
  if (seconds < 60) return seconds <= 1 ? 'in a moment' : `in about ${seconds} seconds`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Core fetch wrapper. Throws `ApiClientError` on non-2xx or invalid response. */
async function apiFetch<T>(
  url: string,
  init: RequestInit,
  responseSchema: z.ZodTypeAny,
  expectedStatus?: number,
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
    throw new ApiClientError(
      error,
      undefined,
      parseRetryAfterSeconds(res.headers.get('Retry-After')),
    );
  }

  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new ApiClientError({
      code: 'internal_error',
      message: 'server returned an unexpected success status',
    });
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

/** Build a JSON body. */
function jsonBody(data: unknown): { body: string } {
  return { body: JSON.stringify(data) };
}

/** Path-segment encoder used for the per-subscriber token in every scoped route. */
function tokenPath(token: string): string {
  return `/api/subscriptions/${encodeURIComponent(token)}`;
}

/**
 * The contract requires exactly one same-order freshness entry per watch.
 * Zod validates each wire value; this guards the cross-field ordering invariant
 * before a component can accidentally label one class with another's status.
 */
function requireAlignedWatchFreshness<
  T extends {
    watches: readonly ClassKey[];
    watchFreshness: ReadonlyArray<{ classKey: ClassKey }>;
  },
>(response: T): T {
  const aligned =
    response.watches.length === response.watchFreshness.length &&
    response.watches.every(
      (classKey, index) => response.watchFreshness[index]?.classKey === classKey,
    );

  if (!aligned) {
    throw new ApiClientError({
      code: 'internal_error',
      message: 'server response did not match the expected watch freshness order',
    });
  }
  return response;
}

// ---------------------------------------------------------------------------
// Public (no auth)
// ---------------------------------------------------------------------------

/**
 * POST /api/subscriptions — create a subscription (FR-1, double opt-in FR-9).
 * Raw `classKeys` (URLs or codes) are normalized by the server; we validate
 * shape against the contract schema before sending. The 202 body carries
 * `{ status: 'pending' }` only — NO token, NO subscriberId, NO watch list (D3).
 */
export async function createSubscription(raw: {
  email: string;
  classKeys: string[];
}): Promise<CreateSubscriptionResponse> {
  const validated = CreateSubscriptionRequestSchema.parse(raw);
  const response = await apiFetch<CreateSubscriptionResponse>(
    '/api/subscriptions',
    {
      method: 'POST',
      headers: pilotInviteCreateHeaders(),
      ...jsonBody(validated),
    },
    CreateSubscriptionResponseSchema,
    202,
  );
  clearStoredPilotInvite();
  return response;
}

/**
 * POST /api/subscriptions/resend — recover a lost confirm/manage link by email
 * (FR-10). NON-ENUMERATING: the response is constant-shaped (`{ status: 'sent' }`)
 * whether or not the address is subscribed, so the UI shows identical copy on
 * every success path.
 */
export async function resendManageLink(email: string): Promise<ResendManageLinkResponse> {
  const validated = ResendManageLinkRequestSchema.parse({ email });
  return apiFetch<ResendManageLinkResponse>(
    '/api/subscriptions/resend',
    { method: 'POST', ...jsonBody(validated) },
    ResendManageLinkResponseSchema,
  );
}

/**
 * GET /api/push/vapid-public-key — the application server key browsers need for
 * `pushManager.subscribe`. `publicKey` is `null` when push is not configured
 * (no VAPID env) — the UI then hides/disables the push toggle.
 */
export async function getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  return apiFetch<VapidPublicKeyResponse>(
    '/api/push/vapid-public-key',
    { method: 'GET' },
    VapidPublicKeyResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Token-scoped (signed manage token in path)
// ---------------------------------------------------------------------------

/**
 * POST /api/subscriptions/:token/confirm — flip a Pending subscriber to Confirmed
 * (FR-9). Idempotent: re-confirming returns the same 200. This is an explicit POST
 * (never a GET side effect) so a mail-scanner prefetch of the confirm link cannot
 * auto-confirm — the landing view requires a user gesture before calling this.
 */
export async function confirmSubscription(token: string): Promise<ConfirmSubscriptionResponse> {
  return apiFetch<ConfirmSubscriptionResponse>(
    `${tokenPath(token)}/confirm`,
    { method: 'POST', ...jsonBody({}) },
    ConfirmSubscriptionResponseSchema,
  );
}

/**
 * GET /api/subscriptions/:token — load the manage view: email, confirmed flag,
 * and the LIVE (un-retired) canonical watches.
 */
export async function getSubscription(token: string): Promise<GetSubscriptionResponse> {
  return requireAlignedWatchFreshness(
    await apiFetch<GetSubscriptionResponse>(
      tokenPath(token),
      { method: 'GET' },
      GetSubscriptionResponseSchema,
    ),
  );
}

/**
 * POST /api/subscriptions/:token/watches — add one watch. `classKey` accepts a
 * URL or human code; the server normalizes. Returns the full updated LIVE list.
 */
export async function addWatch(token: string, classKey: string): Promise<AddWatchResponse> {
  const validated = AddWatchRequestSchema.parse({ classKey });
  return requireAlignedWatchFreshness(
    await apiFetch<AddWatchResponse>(
      `${tokenPath(token)}/watches`,
      { method: 'POST', ...jsonBody(validated) },
      AddWatchResponseSchema,
    ),
  );
}

/**
 * DELETE /api/subscriptions/:token/watches/:classKey — remove the given canonical
 * class key from the watch list. Returns void (204).
 */
export async function removeWatch(token: string, classKey: ClassKey): Promise<void> {
  return apiFetch<void>(
    `${tokenPath(token)}/watches/${encodeURIComponent(classKey)}`,
    { method: 'DELETE' },
    // 204 No Content — apiFetch returns undefined before reaching this schema
    z.undefined(),
  );
}

/**
 * DELETE /api/subscriptions/:token — unsubscribe the subscriber. Returns void (204).
 */
export async function unsubscribe(token: string): Promise<void> {
  return apiFetch<void>(tokenPath(token), { method: 'DELETE' }, z.undefined());
}

/**
 * POST /api/subscriptions/:token/push — register THIS browser for alert push
 * (FR-15). Requires a CONFIRMED subscriber (`409 conflict` while Pending). The
 * payload is the browser's own `PushSubscription` endpoint + keys.
 */
export async function enablePush(
  token: string,
  subscription: EnablePushRequest,
): Promise<EnablePushResponse> {
  const validated = EnablePushRequestSchema.parse(subscription);
  return apiFetch<EnablePushResponse>(
    `${tokenPath(token)}/push`,
    { method: 'POST', ...jsonBody(validated) },
    EnablePushResponseSchema,
  );
}

/**
 * DELETE /api/subscriptions/:token/push — deregister THIS browser. Idempotent
 * (an unknown endpoint still yields 204). Returns void (204).
 */
export async function disablePush(token: string, endpoint: string): Promise<void> {
  const validated = DisablePushRequestSchema.parse({ endpoint });
  return apiFetch<void>(
    `${tokenPath(token)}/push`,
    { method: 'DELETE', ...jsonBody(validated) },
    z.undefined(),
  );
}
