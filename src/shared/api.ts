import { z } from 'zod';
import { ClassKeyInputSchema, ClassKeySchema } from './class-key';

/**
 * The wire contract for every HTTP endpoint in spec §4. Request schemas accept
 * RAW input and normalize at the boundary (constitution: validate all external
 * input with Zod); response schemas describe exactly what the server returns.
 * Error responses are the `ApiErrorResponse` from `./errors` and are listed per
 * endpoint in {@link API_ROUTES} for traceability.
 *
 * Framework-agnostic: no Hono/Drizzle imports. Backend and frontend both import
 * these; the contract is read-only to everyone but the architect.
 *
 * Auth model (FR-2 / §6): there is NO password. Subscriptions are managed via a
 * signed, expiring, per-subscriber `token` carried in the path. A bad/expired
 * token yields `token_invalid` (401); a valid token for a missing subscriber
 * yields `not_found` (404).
 */

// --- Shared field schemas -----------------------------------------------------

/** Subscriber email. Lowercased + trimmed at the boundary. PII — never logged. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('enter a valid email address')
  .max(254);

/** Opaque manage/unsubscribe token (signed, expiring). Validated for shape only. */
export const ManageTokenSchema = z.string().min(1).max(512);

// --- POST /api/subscriptions  (FR-1, AC-1, AC-2) ------------------------------

/**
 * Create a subscription with an email + >= 1 class identifier (URL or code).
 * Each `classKeys` entry is normalized to a canonical {@link ClassKey} at the
 * boundary; an unrecognizable entry fails validation (AC-2).
 */
export const CreateSubscriptionRequestSchema = z.object({
  email: EmailSchema,
  classKeys: z
    .array(ClassKeyInputSchema)
    .min(1, 'add at least one class to watch')
    .max(50, 'a subscription can watch at most 50 classes'),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

/**
 * 201 response. Returns the opaque subscriber id and the freshly-minted manage
 * token so the client can deep-link into the manage view (FR-2). The email is
 * NOT echoed back.
 */
export const CreateSubscriptionResponseSchema = z.object({
  subscriberId: z.string().min(1),
  token: ManageTokenSchema,
  watches: z.array(ClassKeySchema),
});
export type CreateSubscriptionResponse = z.infer<typeof CreateSubscriptionResponseSchema>;

// --- GET /api/subscriptions/:token  (FR-2, AC-1) ------------------------------

/** Path params for the token-scoped manage endpoints. */
export const TokenParamsSchema = z.object({ token: ManageTokenSchema });
export type TokenParams = z.infer<typeof TokenParamsSchema>;

/**
 * 200 response for the manage view: the subscriber's email (shown back to them,
 * they already own the token) and their current canonical watches.
 */
export const GetSubscriptionResponseSchema = z.object({
  email: EmailSchema,
  watches: z.array(ClassKeySchema),
});
export type GetSubscriptionResponse = z.infer<typeof GetSubscriptionResponseSchema>;

// --- POST /api/subscriptions/:token/watches  (FR-2) ---------------------------

/** Add one watch. `classKey` accepts a URL or code and is normalized. */
export const AddWatchRequestSchema = z.object({
  classKey: ClassKeyInputSchema,
});
export type AddWatchRequest = z.infer<typeof AddWatchRequestSchema>;

/** 200 response: the full updated watch list after the add. */
export const AddWatchResponseSchema = z.object({
  watches: z.array(ClassKeySchema),
});
export type AddWatchResponse = z.infer<typeof AddWatchResponseSchema>;

// --- DELETE /api/subscriptions/:token/watches/:classKey  (FR-2) ---------------

/**
 * Path params for removing a watch. The `:classKey` segment MUST already be a
 * canonical key (the client only ever holds canonical keys from prior responses),
 * so it is validated with the strict {@link ClassKeySchema}, not the input form.
 */
export const RemoveWatchParamsSchema = z.object({
  token: ManageTokenSchema,
  classKey: ClassKeySchema,
});
export type RemoveWatchParams = z.infer<typeof RemoveWatchParamsSchema>;

// 204 No Content on success — no response body schema.

// --- DELETE /api/subscriptions/:token  (FR-2, AC-7) ---------------------------

// Unsubscribe. Path params = TokenParamsSchema. 204 No Content on success.

/**
 * Machine-readable route table. Each entry names the method, path template, the
 * request/param/response schemas, and the error codes the endpoint may return.
 * This is documentation that stays in sync with the schemas above; tests and the
 * API client can reference it. `null` response = 204 No Content.
 */
export const API_ROUTES = {
  createSubscription: {
    method: 'POST',
    path: '/api/subscriptions',
    request: CreateSubscriptionRequestSchema,
    response: CreateSubscriptionResponseSchema,
    successStatus: 201,
    errors: ['validation_error', 'conflict', 'rate_limited', 'internal_error'],
  },
  getSubscription: {
    method: 'GET',
    path: '/api/subscriptions/:token',
    params: TokenParamsSchema,
    response: GetSubscriptionResponseSchema,
    successStatus: 200,
    errors: ['token_invalid', 'not_found', 'internal_error'],
  },
  addWatch: {
    method: 'POST',
    path: '/api/subscriptions/:token/watches',
    params: TokenParamsSchema,
    request: AddWatchRequestSchema,
    response: AddWatchResponseSchema,
    successStatus: 200,
    errors: ['validation_error', 'token_invalid', 'not_found', 'conflict', 'internal_error'],
  },
  removeWatch: {
    method: 'DELETE',
    path: '/api/subscriptions/:token/watches/:classKey',
    params: RemoveWatchParamsSchema,
    response: null,
    successStatus: 204,
    errors: ['token_invalid', 'not_found', 'internal_error'],
  },
  unsubscribe: {
    method: 'DELETE',
    path: '/api/subscriptions/:token',
    params: TokenParamsSchema,
    response: null,
    successStatus: 204,
    errors: ['token_invalid', 'not_found', 'internal_error'],
  },
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;
