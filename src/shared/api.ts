import { z } from 'zod';
import { ClassKeyInputSchema, ClassKeySchema } from './class-key';
import { SubscriberEmailSchema } from './email';
import { isSafePushEndpointUrl, normalizePushEndpointUrl } from './push-endpoint';

export { EmailSchema, SubscriberEmailSchema } from './email';

/**
 * The wire contract for every HTTP endpoint in spec §4 (v0.4.2, 2026-07-23).
 * Request schemas accept RAW input and normalize at the boundary (constitution:
 * validate all external input with Zod); response schemas describe exactly what
 * the server returns. Error responses are the `ApiErrorResponse` from `./errors`
 * and are listed per endpoint in {@link API_ROUTES} for traceability.
 *
 * Framework-agnostic: no Hono/Drizzle/node imports — this module is bundled
 * client-side. Backend and frontend both import it; the contract is read-only
 * to everyone but the architect.
 *
 * Auth model (FR-2 / FR-9 / §6): there is NO password. There is exactly ONE
 * token type — the signed, expiring, per-subscriber manage token — and it
 * travels ONLY by email (it appears in NO response body since v0.3 / D3). The
 * confirm link carries the SAME token; confirming is an explicit POST (never a
 * GET side effect, so mail-scanner prefetch cannot confirm). A bad/expired
 * token yields `token_invalid` (401); a valid token for a missing subscriber
 * yields `not_found` (404). Webhook ingress authenticates with a provider
 * signature instead and rejects with `signature_invalid` (401).
 */

// --- Shared field schemas -----------------------------------------------------

/** Opaque manage/unsubscribe/confirm token (signed, expiring). Shape-only check. */
export const ManageTokenSchema = z.string().min(1).max(512);

/**
 * New-subscriber admission is fail-closed. An absent env setting has the same
 * meaning as `closed`; `pilot` requires the shared bearer code below; `public`
 * admits any exact-Berkeley request that passes the ordinary limits.
 */
export const ADMISSION_MODES = ['closed', 'pilot', 'public'] as const;
export const AdmissionModeSchema = z.enum(ADMISSION_MODES);
export type AdmissionMode = z.infer<typeof AdmissionModeSchema>;
export const DEFAULT_ADMISSION_MODE: AdmissionMode = 'closed';
export const PILOT_SUBSCRIBER_LIMIT = 100;

/**
 * Pilot bearer access travels in a request header, never the JSON body or URL
 * of the subscribe API. HTTP header names are case-insensitive; this lowercase
 * spelling is the canonical fetch/server representation.
 */
export const PILOT_INVITE_CODE_HEADER = 'x-seat-sniper-invite-code' as const;
export const PILOT_INVITE_CODE_MIN_LENGTH = 32;
export const PILOT_INVITE_CODE_MAX_LENGTH = 256;
export const PilotInviteCodeSchema = z
  .string()
  .min(PILOT_INVITE_CODE_MIN_LENGTH)
  .max(PILOT_INVITE_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'pilot invite code must be unpadded base64url');
export const CreateSubscriptionHeadersSchema = z.object({
  [PILOT_INVITE_CODE_HEADER]: PilotInviteCodeSchema.optional(),
});
export type CreateSubscriptionHeaders = z.infer<typeof CreateSubscriptionHeadersSchema>;

// --- POST /api/subscriptions  (FR-1, FR-9, FR-19, AC-1, AC-2, AC-2b, AC-25) ----

/**
 * The hard ceiling on LIVE (un-retired) watches one subscriber may hold. Freeing a
 * slot is a deliberate act: to watch a fifth class the student must first remove one
 * from the dashboard (owner decision, 2026-07-30).
 *
 * This lives in the CONTRACT, not in `src/db`, for two reasons. The dashboard has to
 * render "3 of 4 slots used" without importing the data layer; and both enforcement
 * points below must agree on one number.
 *
 * It is enforced in TWO places and both are required:
 *  1. here, bounding `classKeys` on the CREATE path — a batch create bypasses any
 *     per-add check, so a contract bound is the only thing standing between a new
 *     subscriber and an unbounded watch set;
 *  2. in the repository's add path, which counts existing LIVE rows and rejects with
 *     `watch_limit_reached`.
 * Removing either one silently reopens the bypass.
 */
export const MAX_WATCHES_PER_SUBSCRIBER = 4;

/**
 * Create a subscription with an email + >= 1 class identifier (URL or code).
 * Each `classKeys` entry is normalized to a canonical {@link ClassKey} at the
 * boundary; an unrecognizable entry fails validation (AC-2).
 *
 * The upper bound is {@link MAX_WATCHES_PER_SUBSCRIBER}, so an over-cap create is
 * rejected as `400 validation_error` BEFORE any subscriber row exists — distinct from
 * the post-confirmation add path, which rejects with `409 watch_limit_reached`.
 */
export const CreateSubscriptionRequestSchema = z.object({
  email: SubscriberEmailSchema,
  classKeys: z
    .array(ClassKeyInputSchema)
    .min(1, 'add at least one class to watch')
    .max(
      MAX_WATCHES_PER_SUBSCRIBER,
      `you can watch at most ${MAX_WATCHES_PER_SUBSCRIBER} classes at a time`,
    ),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

/**
 * 202 Accepted (double opt-in, FR-9 / ADR 0001 / D3). The body is a constant
 * acknowledgement: NO token, NO subscriberId, NO watch list — the manage/confirm
 * link travels only in the confirmation email. Duplicate email → `409 conflict`
 * with the standard error envelope (no merge, no token; see spec §4 for the
 * accepted existence-disclosure tradeoff, blunted by rate limits).
 *
 * Admission failures are deliberately non-enumerating: closed admission, a
 * missing/wrong pilot code, and a full pilot all return the same canonical
 * `503 admission_unavailable` response plus the fixed Retry-After value exported
 * by `./errors`. The invite value is a shared bearer secret and must never be
 * stored, echoed, or logged.
 */
export const CreateSubscriptionResponseSchema = z.object({
  status: z.literal('pending'),
});
export type CreateSubscriptionResponse = z.infer<typeof CreateSubscriptionResponseSchema>;

// --- POST /api/subscriptions/:token/confirm  (FR-3, FR-9, AC-1, AC-10, AC-18) --

/** Path params for the token-scoped endpoints. */
export const TokenParamsSchema = z.object({ token: ManageTokenSchema });
export type TokenParams = z.infer<typeof TokenParamsSchema>;

/**
 * 200 response for confirm. IDEMPOTENT: confirming an already-confirmed
 * subscriber returns this same body and changes nothing (`confirmed_at` and
 * watch activation are set exactly once). A first confirmation atomically
 * activates all staged watches subject to unique-Section capacity; capacity
 * failure returns `503 capacity_exceeded` and leaves the subscriber Pending.
 * Only Confirmed Subscribers receive Alerts (FR-9).
 */
export const ConfirmSubscriptionResponseSchema = z.object({
  status: z.literal('confirmed'),
});
export type ConfirmSubscriptionResponse = z.infer<typeof ConfirmSubscriptionResponseSchema>;

// --- GET /api/subscriptions/:token  (FR-2, AC-1) ------------------------------

/**
 * Public-source freshness for one live watch. `lastCheckedAt` is the most
 * recent SUCCESSFULLY PARSED observation, not a claim about when Berkeley SIS
 * changed. `sourceStale` is therefore true for a new watch and whenever that
 * successful observation ages past the configured worker freshness threshold.
 */
export const WatchFreshnessSchema = z
  .object({
    classKey: ClassKeySchema,
    source: z.literal('public-class-page'),
    lastCheckedAt: z.string().datetime().nullable(),
    sourceStale: z.boolean(),

    // --- Dashboard observations (owner decision, 2026-07-30) -------------------
    // One box per live watch shows the class name, open seats out of total, open
    // waitlist slots out of total, and a link to the official page, so the student
    // can decide what to stop watching and free one of their four slots.
    //
    // Every field below is REQUIRED-BUT-NULLABLE: the key is always present and
    // `null` means "not observed yet". These are LEFT-joined from `class_state`,
    // so a watch whose class has never been polled has no row at all and every
    // value here is null — that is a normal new watch, not an error. Nullable
    // rather than optional so the compiler forces each producer to decide; an
    // omittable field turns a forgetful producer into a silently blank box.
    //
    // Display-only. NONE of these is ever an identity input, a lookup key, or part
    // of a ClassKey. The official class URL is DERIVED from `classKey`, never
    // stored per row and never taken from the page.

    /** Human-readable class name from the page heading, e.g. "COMPSCI 189 001 - LEC 001". */
    displayName: z.string().min(1).max(256).nullable(),
    /** TOTAL open seats, reserved ones included. Pair with `capacity` for "3 of 350". */
    openSeats: z.number().int().nonnegative().nullable(),
    /** Students currently enrolled. */
    enrolled: z.number().int().nonnegative().nullable(),
    /** Total section capacity — the denominator for `openSeats`. Not general-only. */
    capacity: z.number().int().nonnegative().nullable(),
    /**
     * Students currently QUEUED on the waitlist. This is NOT a count of open
     * waitlist slots — it is how many people are already in line. Open slots are
     * `waitlistMax - waitlisted`; rendering `waitlisted` as "open" inverts the
     * meaning and reports a FULL waitlist as wide open. See `waitlistOpen`.
     */
    waitlisted: z.number().int().nonnegative().nullable(),
    /** Maximum waitlist size — the denominator for open waitlist slots. */
    waitlistMax: z.number().int().nonnegative().nullable(),
    /**
     * Of `openSeats`, how many are RESERVED for a Reservation Group. A SUBSET of
     * `openSeats`, never an addition — `openSeats: 41` with `openReserved: 41` means
     * every open seat is reserved and a student without that permission can take none
     * of them. That exact snapshot was observed live on 2026-08-21.
     *
     * The dashboard MUST surface this rather than showing a bare open count: "41 open
     * (all reserved)" is honest, "41 open" is not. Alerting is deliberately NOT gated
     * on it (owner ruling 2026-08-22) — a reserved seat is real to whoever holds the
     * permission, and suppressing would cost them the alert.
     *
     * `null` means the page published no reserved line, which is NOT the same as zero
     * reserved. Render the plain count in that case; never infer 0.
     */
    openReserved: z.number().int().nonnegative().nullable(),
    /**
     * Whether the waitlist is accepting movement (`waitlistMax > 0 && waitlisted <
     * waitlistMax`).
     *
     * Invariant the UI and tests must hold, stated as an IMPLICATION and not a
     * biconditional: a rendered open-waitlist count > 0 IMPLIES this is true. The
     * converse does NOT hold and must not be tested as one — `true` with either
     * count null renders a dash, and `null` renders a dash whatever the counts say,
     * because a row written before these columns existed knows the flag but not the
     * numbers. `false` renders 0 regardless of the arithmetic: this field is what
     * the alerting path derives from, so a box claiming spots while it is false
     * would promise availability that never produces an alert.
     */
    waitlistOpen: z.boolean().nullable(),
  })
  /**
   * Same subset rule the producer enforces (`SeatStateSchema`), restated here
   * because this shape has SEVERAL producers and a client that renders it. A wire
   * payload claiming more reserved seats than open ones would make the dashboard
   * print "2 open (3 reserved)"; rejecting it at the boundary means the client
   * never has to defend against a state the server should not send.
   */
  .refine((watch) => (watch.openReserved ?? 0) <= (watch.openSeats ?? 0), {
    message: 'openReserved cannot exceed openSeats; it counts a subset of them',
    path: ['openReserved'],
  });
export type WatchFreshness = z.infer<typeof WatchFreshnessSchema>;

/**
 * 200 response for the manage view: the subscriber's email (shown back to them,
 * they already own the token), whether they are Confirmed (drives the "confirm
 * to start receiving alerts" prompt when false), and their LIVE (un-retired)
 * canonical watches.
 */
export const GetSubscriptionResponseSchema = z.object({
  email: SubscriberEmailSchema,
  confirmed: z.boolean(),
  watches: z.array(ClassKeySchema),
  /** One entry for every item in `watches`, in the same order. */
  watchFreshness: z.array(WatchFreshnessSchema),
});
export type GetSubscriptionResponse = z.infer<typeof GetSubscriptionResponseSchema>;

// --- POST /api/subscriptions/:token/watches  (FR-2) ---------------------------

/** Add one watch. `classKey` accepts a URL or code and is normalized. */
export const AddWatchRequestSchema = z.object({
  classKey: ClassKeyInputSchema,
});
export type AddWatchRequest = z.infer<typeof AddWatchRequestSchema>;

/**
 * 200 response: the full updated LIVE watch list after the add. Re-adding a
 * class whose watch was retired (class-gone, FR-13) REVIVES that watch; only a
 * duplicate LIVE watch yields `409 conflict` (spec §5).
 */
export const AddWatchResponseSchema = z.object({
  watches: z.array(ClassKeySchema),
  /** One entry for every item in `watches`, in the same order. */
  watchFreshness: GetSubscriptionResponseSchema.shape.watchFreshness,
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

// --- DELETE /api/subscriptions/:token  +  one-click POST  (FR-2, AC-7) --------

// Unsubscribe. Path params = TokenParamsSchema. 204 No Content on success.
//
// RFC 8058 one-click: mail clients POST (never DELETE) to the URL named in the
// `List-Unsubscribe`/`List-Unsubscribe-Post` headers, so the contract exposes
// `POST /api/subscriptions/:token/unsubscribe` with IDENTICAL semantics. Its
// request body (form-encoded `List-Unsubscribe=One-Click`) is accepted and
// IGNORED — never validated, never echoed.

// --- POST /api/subscriptions/resend  (FR-10, FR-11, AC-11, AC-12) --------------

/**
 * Recover a lost manage/confirm link by email. NON-ENUMERATING (ADR 0005 / D6):
 * the response is byte-identical whether or not the address is subscribed (or
 * suppressed), and the handler does comparable work on every path (no timing
 * oracle). Mail is actually sent only to a subscribed, non-suppressed address —
 * the confirmation template while Pending, the manage-link template once
 * Confirmed.
 */
export const ResendManageLinkRequestSchema = z.object({
  email: SubscriberEmailSchema,
});
export type ResendManageLinkRequest = z.infer<typeof ResendManageLinkRequestSchema>;

/** Constant-shaped 202 — returned for known AND unknown addresses alike. */
export const ResendManageLinkResponseSchema = z.object({
  status: z.literal('sent'),
});
export type ResendManageLinkResponse = z.infer<typeof ResendManageLinkResponseSchema>;

// --- POST /api/webhooks/resend  (FR-12, AC-13) ---------------------------------

/**
 * Headers carrying the provider (Svix) signature on every Resend webhook call.
 * The backend verifies HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with
 * `RESEND_WEBHOOK_SECRET` (env only) and rejects failures with
 * `signature_invalid` (401). The raw-body byte ceiling below is enforced before
 * signature verification or parsing. Tests sign fake payloads with the same
 * scheme.
 */
export const RESEND_WEBHOOK_SIGNATURE_HEADERS = [
  'svix-id',
  'svix-timestamp',
  'svix-signature',
] as const;

/** Exact raw Resend webhook ceiling (32 KiB), enforced before signature work. */
export const RESEND_WEBHOOK_MAX_BODY_BYTES = 32 * 1024;

/**
 * Tolerant schema for a Resend webhook event. This is a THIRD PARTY's payload:
 * we validate only the fields we act on and pass everything else through, so a
 * provider schema addition never breaks ingestion. Events whose `type` we do
 * not act on are acknowledged with 204 and ignored.
 */
export const ResendWebhookEventSchema = z
  .object({
    /** e.g. 'email.bounced' | 'email.complained' | 'email.delivered' | ... */
    type: z.string().min(1),
    data: z
      .object({
        /** Recipient address(es) the event applies to. */
        to: z.union([z.array(z.string()), z.string()]).optional(),
        /** Bounce detail when type === 'email.bounced'. */
        bounce: z
          .object({
            /** e.g. 'Permanent' | 'Transient' (SES-style) or 'hard' | 'soft'. */
            type: z.string().optional(),
            subType: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ResendWebhookEvent = z.infer<typeof ResendWebhookEventSchema>;

/** Why an address is suppressed. Mirrors the `suppressions.reason` column (§5). */
export const SUPPRESSION_REASONS = ['bounce', 'complaint'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Single classification authority for webhook-driven suppression (FR-12 / D5).
 * Returns the addresses to suppress (normalized, validated) with their reason:
 *
 *  - `email.complained` → suppress every recipient (a complaint is always final).
 *  - `email.bounced`    → suppress UNLESS the payload marks the bounce explicitly
 *                         transient/soft. Missing/unknown bounce type suppresses
 *                         (suppress-by-default protects sender reputation, the
 *                         channel the whole product depends on).
 *  - anything else      → suppress nothing.
 *
 * Pure and total: never throws, never logs (recipients are PII — the caller
 * must not log them either; log counts only, AC-8).
 */
export function suppressionsFromResendEvent(
  event: ResendWebhookEvent,
): Array<{ email: string; reason: SuppressionReason }> {
  const rawTo = event.data?.to;
  const recipients = (Array.isArray(rawTo) ? rawTo : typeof rawTo === 'string' ? [rawTo] : [])
    .map((r) => SubscriberEmailSchema.safeParse(r))
    .filter((r): r is { success: true; data: string } => r.success)
    .map((r) => r.data);
  if (recipients.length === 0) return [];

  if (event.type === 'email.complained') {
    return recipients.map((email) => ({ email, reason: 'complaint' as const }));
  }
  if (event.type === 'email.bounced') {
    const bounceType = (event.data?.bounce?.type ?? '').toLowerCase();
    const isSoft =
      bounceType === 'temporary' || bounceType === 'transient' || bounceType === 'soft';
    if (isSoft) return [];
    return recipients.map((email) => ({ email, reason: 'bounce' as const }));
  }
  return [];
}

// --- Web push  (FR-15, AC-16, D10) ----------------------------------------------

/**
 * Browser push-subscription keys as produced by
 * `PushSubscription.toJSON().keys`. Delivery credentials — never logged.
 */
function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

export const PushKeysSchema = z.object({
  // RFC 8291 browser subscriptions expose an uncompressed P-256 public key:
  // 0x04 followed by two 32-byte coordinates, encoded as unpadded base64url.
  p256dh: z
    .string()
    .max(128)
    .refine((value) => {
      const bytes = decodeCanonicalBase64Url(value);
      return bytes?.byteLength === 65 && bytes[0] === 0x04;
    }, 'p256dh must be a canonical 65-byte uncompressed P-256 key'),
  // The Push API authentication secret is exactly 16 bytes (RFC 8291 §3.2).
  auth: z
    .string()
    .max(64)
    .refine((value) => {
      const bytes = decodeCanonicalBase64Url(value);
      return bytes?.byteLength === 16;
    }, 'auth must be a canonical 16-byte push authentication secret'),
});
export type PushKeys = z.infer<typeof PushKeysSchema>;

/**
 * POST /api/subscriptions/:token/push — register THIS browser for alert push.
 * Requires a CONFIRMED subscriber (`409 conflict` while Pending, FR-15).
 * Idempotent upsert keyed on `endpoint` (globally unique): re-registering
 * updates the keys; an endpoint previously registered to a different subscriber
 * is reassigned (last write wins). Unknown extra fields from
 * `PushSubscription.toJSON()` (e.g. `expirationTime`) are stripped, not errors.
 */
export const EnablePushRequestSchema = z.object({
  // https-only (v0.3.3): browser push services are always https; anything else
  // is an SSRF/egress primitive, not a push endpoint.
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(
      isSafePushEndpointUrl,
      'push endpoint must be a public HTTPS hostname on the standard port',
    )
    .transform((value) => normalizePushEndpointUrl(value)!),
  keys: PushKeysSchema,
});
export type EnablePushRequest = z.infer<typeof EnablePushRequestSchema>;

/** Constant 201 acknowledgement. Inert until VAPID keys are configured. */
export const EnablePushResponseSchema = z.object({
  status: z.literal('enabled'),
});
export type EnablePushResponse = z.infer<typeof EnablePushResponseSchema>;

/**
 * DELETE /api/subscriptions/:token/push — deregister THIS browser (the client
 * recomputes its `endpoint` from `pushManager.getSubscription()`; we key on it
 * rather than a server id so nothing must be stored client-side). Idempotent:
 * an unknown endpoint still yields 204.
 */
export const DisablePushRequestSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(
      isSafePushEndpointUrl,
      'push endpoint must be a public HTTPS hostname on the standard port',
    )
    .transform((value) => normalizePushEndpointUrl(value)!),
});
export type DisablePushRequest = z.infer<typeof DisablePushRequestSchema>;

/**
 * GET /api/push/vapid-public-key — the VAPID public key browsers need for
 * `pushManager.subscribe`. Public by design (it is not a secret). `null` when
 * push is not configured (no VAPID env) — the UI then hides the push toggle.
 */
export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1).nullable(),
});
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

/** Explicit JSON body for state-changing routes with no business payload. */
export const EmptyJsonRequestSchema = z.object({}).strict();
export type EmptyJsonRequest = z.infer<typeof EmptyJsonRequestSchema>;

// --- Route table ----------------------------------------------------------------

/**
 * Machine-readable route table. Each entry names the method, path template, the
 * request/param/response schemas, and the error codes the endpoint may return.
 * This is documentation that stays in sync with the schemas above; tests and the
 * API client can reference it. `null` response = 204 No Content; `null` request
 * = body absent or deliberately ignored.
 *
 * Routing note (backend): register the STATIC `/api/subscriptions/resend` path
 * BEFORE the `/:token`-parameterized siblings so "resend" is never captured as
 * a token segment.
 */
export const API_ROUTES = {
  createSubscription: {
    method: 'POST',
    path: '/api/subscriptions',
    headers: CreateSubscriptionHeadersSchema,
    request: CreateSubscriptionRequestSchema,
    response: CreateSubscriptionResponseSchema,
    successStatus: 202,
    errors: [
      'validation_error',
      'payload_too_large',
      'conflict',
      'admission_unavailable',
      'rate_limited',
      'internal_error',
    ],
  },
  confirmSubscription: {
    method: 'POST',
    path: '/api/subscriptions/:token/confirm',
    params: TokenParamsSchema,
    request: EmptyJsonRequestSchema,
    response: ConfirmSubscriptionResponseSchema,
    successStatus: 200,
    errors: [
      'validation_error',
      'payload_too_large',
      'token_invalid',
      'not_found',
      'capacity_exceeded',
      'internal_error',
    ],
  },
  resendManageLink: {
    method: 'POST',
    path: '/api/subscriptions/resend',
    request: ResendManageLinkRequestSchema,
    response: ResendManageLinkResponseSchema,
    successStatus: 202,
    errors: ['validation_error', 'payload_too_large', 'rate_limited', 'internal_error'],
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
    errors: [
      'validation_error',
      'payload_too_large',
      'token_invalid',
      'not_found',
      // conflict = this class is already a LIVE watch.
      'conflict',
      // watch_limit_reached = the subscriber is at MAX_WATCHES_PER_SUBSCRIBER.
      // Checked BEFORE capacity_exceeded: a full subscriber must be told to remove
      // one of their own, not to wait for the service to free up.
      'watch_limit_reached',
      'capacity_exceeded',
      'internal_error',
    ],
  },
  removeWatch: {
    method: 'DELETE',
    path: '/api/subscriptions/:token/watches/:classKey',
    params: RemoveWatchParamsSchema,
    response: null,
    successStatus: 204,
    // A non-canonical :classKey path param fails RemoveWatchParamsSchema
    // (strict ClassKeySchema) → validation_error (400).
    errors: ['validation_error', 'token_invalid', 'not_found', 'internal_error'],
  },
  unsubscribe: {
    method: 'DELETE',
    path: '/api/subscriptions/:token',
    params: TokenParamsSchema,
    response: null,
    successStatus: 204,
    errors: ['token_invalid', 'not_found', 'internal_error'],
  },
  oneClickUnsubscribe: {
    method: 'POST',
    path: '/api/subscriptions/:token/unsubscribe',
    params: TokenParamsSchema,
    // RFC 8058: mail providers POST `List-Unsubscribe=One-Click` here. The body
    // is accepted and ignored; semantics are identical to `unsubscribe`.
    request: null,
    response: null,
    successStatus: 204,
    errors: ['payload_too_large', 'token_invalid', 'not_found', 'internal_error'],
  },
  resendWebhook: {
    method: 'POST',
    path: '/api/webhooks/resend',
    // Authenticated by the Svix signature headers (RESEND_WEBHOOK_SIGNATURE_HEADERS)
    // over the RAW body. Enforce maxBodyBytes BEFORE signature work or parsing.
    // Valid-signature events we do not act on are acknowledged (204) and ignored.
    maxBodyBytes: RESEND_WEBHOOK_MAX_BODY_BYTES,
    request: ResendWebhookEventSchema,
    response: null,
    successStatus: 204,
    errors: ['payload_too_large', 'signature_invalid', 'internal_error'],
  },
  getVapidPublicKey: {
    method: 'GET',
    path: '/api/push/vapid-public-key',
    response: VapidPublicKeyResponseSchema,
    successStatus: 200,
    errors: ['internal_error'],
  },
  enablePush: {
    method: 'POST',
    path: '/api/subscriptions/:token/push',
    params: TokenParamsSchema,
    request: EnablePushRequestSchema,
    response: EnablePushResponseSchema,
    successStatus: 201,
    // conflict = subscriber not yet Confirmed (FR-15: confirm first).
    errors: [
      'validation_error',
      'payload_too_large',
      'token_invalid',
      'not_found',
      'conflict',
      // The route is mounted behind the per-IP limiter (src/server/app.ts), so a
      // 429 is observable here. The contract previously omitted it and therefore
      // under-declared a real response.
      'rate_limited',
      'internal_error',
    ],
  },
  disablePush: {
    method: 'DELETE',
    path: '/api/subscriptions/:token/push',
    params: TokenParamsSchema,
    request: DisablePushRequestSchema,
    response: null,
    successStatus: 204,
    errors: [
      'validation_error',
      'payload_too_large',
      'token_invalid',
      'not_found',
      'internal_error',
    ],
  },
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;
