/**
 * Resend (Svix) webhook signature verification (FR-12 / AC-13).
 *
 * Svix signs `${id}.${timestamp}.${rawBody}` with an HMAC-SHA256 keyed by the
 * webhook secret, and sends the signature in the `svix-signature` header as one
 * or more space-separated `v1,<base64>` entries. We verify against
 * `RESEND_WEBHOOK_SECRET` (env only) over the RAW body BEFORE parsing it, and
 * reject a missing/malformed/failed signature with `signature_invalid` (401).
 *
 * Secret format: Svix secrets are `whsec_<base64>`; the bytes after the prefix
 * are the HMAC key. A missing prefix is rejected at startup and verification.
 *
 * Timing safety: signatures are compared with `timingSafeEqual`. We never log
 * the secret, the signature, or the body (the body holds recipient PII, AC-8).
 *
 * No external dependency: this re-implements the small slice of Svix
 * verification we need with node:crypto only (constitution: prefer the stdlib;
 * no new runtime dep without a reason).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { RESEND_WEBHOOK_SIGNATURE_HEADERS } from '../shared/api';
import { parseResendWebhookSecret } from './resend-webhook-secret';

/**
 * Replay window: reject a webhook whose `svix-timestamp` differs from now by more
 * than this (in EITHER direction — stale replay OR implausible future skew). Svix's
 * own verifier uses a 5-minute tolerance; we match it. The timestamp is part of the
 * signed content, so a valid signature already binds it — this bounds how long a
 * captured-and-replayed valid request stays acceptable.
 */
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** Outcome of verifying a webhook request. */
export type WebhookVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_configured'
        | 'missing_headers'
        | 'bad_timestamp'
        | 'timestamp_out_of_tolerance'
        | 'bad_signature';
    };

/** Resolve the HMAC key bytes from the configured secret. */
function secretKey(secret: string): Buffer {
  return parseResendWebhookSecret(secret);
}

/** Compute the expected base64 signature for a signed content string. */
function computeSignature(secret: string, signedContent: string): string {
  return createHmac('sha256', secretKey(secret)).update(signedContent).digest('base64');
}

/** Constant-time compare of two base64 signature strings. */
function signaturesMatch(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a Resend/Svix webhook signature over the RAW request body.
 *
 * @param headers  the incoming request headers (case-insensitive Headers).
 * @param rawBody  the EXACT raw request body string (must not be re-serialized).
 * @returns ok:true on a valid signature; otherwise a typed rejection. Callers
 *          map every non-ok result to `signature_invalid` (401) and make NO
 *          state change (AC-13b). Never logs the body/secret/signature.
 */
export function verifyResendWebhook(headers: Headers, rawBody: string): WebhookVerifyResult {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || secret.length === 0) {
    // Suppression silently never happens without the secret (spec §6) — but an
    // unauthenticated webhook must still be rejected, not trusted. Treat an
    // unconfigured secret as a hard reject (no state change), never as "valid".
    return { ok: false, reason: 'not_configured' };
  }

  const [idHeader, tsHeader, sigHeader] = RESEND_WEBHOOK_SIGNATURE_HEADERS;
  const id = headers.get(idHeader);
  const timestamp = headers.get(tsHeader);
  const signatureHeader = headers.get(sigHeader);

  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  // Replay guard (Svix parity): the svix-timestamp is Unix SECONDS. Reject an
  // unparseable value, and reject anything more than the tolerance window from
  // now in either direction so a captured valid request cannot be replayed
  // indefinitely. Cheap + secret-independent, so it runs before the HMAC.
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  if (Math.abs(Date.now() - tsSeconds * 1000) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  let expected: string;
  try {
    expected = computeSignature(secret, signedContent);
  } catch {
    return { ok: false, reason: 'not_configured' };
  }

  // The header may carry multiple space-separated `v1,<sig>` entries (Svix key
  // rotation). Accept if ANY v1 entry matches; unknown versions and bare values
  // are not this protocol and must not be treated as equivalent signatures.
  const candidates = signatureHeader
    .split(' ')
    .filter((part) => part.startsWith('v1,') && part.indexOf(',', 3) === -1)
    .map((part) => part.slice(3))
    .filter((s) => s.length > 0);

  for (const candidate of candidates) {
    if (signaturesMatch(expected, candidate)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'bad_signature' };
}
