import { z } from 'zod';

/**
 * The ONLY error shape the API returns to clients. No stack traces, no internals,
 * no upstream details leak through this boundary (constitution: safe error
 * messages; §6 security). Servers map every failure to one of these codes.
 *
 * Code union (kept deliberately small and stable — clients may switch on it):
 *  - `validation_error`   request body/params failed Zod validation (HTTP 400).
 *  - `not_found`          token/watch/subscription does not exist (HTTP 404).
 *  - `conflict`           duplicate, e.g. watch already exists (HTTP 409).
 *  - `token_invalid`      manage/unsubscribe token is malformed, expired, or
 *                         not signed by us (HTTP 401). Per FR-2 token links are
 *                         signed + expiring; this is the rejection code.
 *  - `rate_limited`       too many requests (HTTP 429).
 *  - `internal_error`     unexpected server fault (HTTP 500) — generic message
 *                         only; the real cause is logged server-side, not returned.
 */
export const API_ERROR_CODES = [
  'validation_error',
  'not_found',
  'conflict',
  'token_invalid',
  'rate_limited',
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
  not_found: 404,
  conflict: 409,
  token_invalid: 401,
  rate_limited: 429,
  internal_error: 500,
};

/** Construct a canonical error response envelope. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string>,
): ApiErrorResponse {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}
