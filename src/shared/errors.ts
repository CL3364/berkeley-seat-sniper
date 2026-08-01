import { z } from 'zod';

/**
 * The ONLY error shape the API returns to clients. No stack traces, no internals,
 * no upstream details leak through this boundary (constitution: safe error
 * messages; §6 security). Servers map every failure to one of these codes.
 *
 * Code union (kept deliberately small and stable — clients may switch on it):
 *  - `validation_error`   request body/params failed Zod validation (HTTP 400).
 *  - `payload_too_large`  request body exceeds the route limit (HTTP 413).
 *  - `not_found`          token/watch/subscription does not exist (HTTP 404).
 *  - `conflict`           duplicate, e.g. watch already exists (HTTP 409).
 *  - `watch_limit_reached`
 *                         the subscriber already holds the maximum number of LIVE
 *                         watches (`MAX_WATCHES_PER_SUBSCRIBER` in `./api`) and cannot
 *                         add another (HTTP 409). Deliberately DISTINCT from `conflict`:
 *                         "you already watch this class" and "you are at your limit"
 *                         demand opposite instructions from the student, and the UI
 *                         must tell them to remove one to free a slot. Unlike
 *                         `capacity_exceeded` this is NOT retryable — waiting never
 *                         clears it; only the subscriber removing a watch does. It
 *                         therefore carries no `Retry-After`.
 *  - `token_invalid`      manage/unsubscribe token is malformed, expired, or
 *                         not signed by us (HTTP 401). Per FR-2 token links are
 *                         signed + expiring; this is the rejection code.
 *  - `signature_invalid`  webhook ingress signature is missing, malformed, or
 *                         fails verification (HTTP 401). Distinct from
 *                         `token_invalid`: this authenticates a PROVIDER webhook
 *                         (e.g. the Resend/Svix headers, FR-12), not a
 *                         subscriber's manage token.
 *  - `rate_limited`       too many requests (HTTP 429).
 *  - `admission_unavailable`
 *                         new subscriptions are unavailable because admission
 *                         is closed, the pilot bearer is absent/wrong, or the
 *                         pilot account cap is full (HTTP 503). Those cases are
 *                         deliberately indistinguishable and carry the same
 *                         fixed `Retry-After`.
 *  - `capacity_exceeded`  confirming staged watches or adding a Confirmed
 *                         subscriber's new unique watch would exceed the polite
 *                         source-polling capacity (HTTP 503). Responses carry
 *                         `Retry-After`; Pending state/existing watches remain.
 *  - `internal_error`     unexpected server fault (HTTP 500) — generic message
 *                         only; the real cause is logged server-side, not returned.
 */
export const API_ERROR_CODES = [
  'validation_error',
  'payload_too_large',
  'not_found',
  'conflict',
  'watch_limit_reached',
  'token_invalid',
  'signature_invalid',
  'rate_limited',
  'admission_unavailable',
  'capacity_exceeded',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/**
 * Canonical client-facing error. `message` is a short, safe, human-readable
 * string; it MUST NOT contain stack traces, SQL, raw HTML, secrets, or PII.
 * `fields` is optional and present only for `validation_error` to drive inline
 * form errors (FR-1/AC-2) — it maps a field name to a safe message.
 */
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The wire envelope for any error response: `{ error: ApiError }`. */
export const ApiErrorResponseSchema = z.object({
  error: ApiErrorSchema,
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/** Conventional HTTP status for each error code (servers SHOULD use these). */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  validation_error: 400,
  payload_too_large: 413,
  not_found: 404,
  conflict: 409,
  // Same status as `conflict` on purpose: the request conflicts with the client's
  // OWN current state and the client can resolve it by changing that state. The
  // canonical `code` is what discriminates the two, which is exactly why the code
  // exists — status alone cannot tell the student which of the two happened.
  watch_limit_reached: 409,
  token_invalid: 401,
  signature_invalid: 401,
  rate_limited: 429,
  admission_unavailable: 503,
  capacity_exceeded: 503,
  internal_error: 500,
};

/**
 * Canonical non-enumerating admission response metadata (FR-19 / AC-25).
 * Closed, invalid/missing pilot bearer, and full-pilot responses must use this
 * exact safe message and decimal-delta Retry-After value.
 */
export const ADMISSION_UNAVAILABLE_MESSAGE = 'new subscriptions are not currently available';
export const ADMISSION_RETRY_AFTER_SECONDS = 3600;

/** Canonical generic body for a recovery-path infrastructure failure (FR-10). */
export const RECOVERY_INTERNAL_ERROR_MESSAGE =
  'the request could not be processed; please try again later';

/** Construct a canonical error response envelope. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string>,
): ApiErrorResponse {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}
