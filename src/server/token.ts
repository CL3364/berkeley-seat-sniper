/**
 * Stateless signed manage token (FR-2).
 *
 * A token encodes `{ subscriberId, exp }` as HMAC-SHA256 over a JSON payload,
 * expressed as `<base64url-payload>.<base64url-sig>`. There is no database
 * lookup — the server verifies the signature and expiry, then the endpoint does
 * a DB lookup to confirm the subscriber still exists.
 *
 * Secret comes ONLY from `process.env.TOKEN_SECRET`. It is never logged.
 * Expiry defaults to 30 days (`TOKEN_TTL_SECONDS`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_SECONDS = parseInt(
  process.env.TOKEN_TTL_SECONDS ?? String(30 * 24 * 60 * 60),
  10,
);

/** Payload embedded in the token. */
interface TokenPayload {
  sub: string; // subscriberId (opaque)
  exp: number; // Unix timestamp (seconds)
}

/** Outcome of verifying a raw token string. */
export type VerifyResult =
  | { ok: true; subscriberId: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

function getSecret(): Buffer {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    // Fail loud at runtime — a missing/short secret is a configuration error,
    // not something to silently swallow.
    throw new Error('TOKEN_SECRET env var is missing or too short (min 32 chars)');
  }
  return Buffer.from(secret, 'utf8');
}

function toBase64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(s: string): Buffer {
  // Restore standard base64 padding.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const padded2 = pad === 0 ? padded : padded + '='.repeat(4 - pad);
  return Buffer.from(padded2, 'base64');
}

function sign(payload: string, secret: Buffer): string {
  return toBase64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * Mint a signed token for `subscriberId`. Returns the opaque token string that
 * the client carries as a manage/unsubscribe link parameter.
 *
 * The token encodes the subscriberId and an expiry. It is NOT stored in the DB.
 */
export function mintToken(subscriberId: string): string {
  const payload: TokenPayload = {
    sub: subscriberId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = toBase64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = sign(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a raw token string. Returns the subscriberId on success or a typed
 * failure. Never throws — callers branch on `ok`.
 *
 * Malformed/expired/bad-signature all map to `token_invalid` (401) per spec §4.
 */
export function verifyToken(raw: string): VerifyResult {
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, receivedSig] = parts;

  // Verify signature with constant-time comparison.
  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64, getSecret());
  } catch {
    // getSecret() throws when TOKEN_SECRET is misconfigured — treat as malformed
    // from the client's perspective (the server logs the real cause separately).
    return { ok: false, reason: 'malformed' };
  }

  const expected = Buffer.from(expectedSig, 'utf8');
  const received = Buffer.from(receivedSig, 'utf8');

  // Lengths must match before timingSafeEqual to avoid throwing.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Decode and parse payload.
  let payload: TokenPayload;
  try {
    const json = fromBase64url(payloadB64).toString('utf8');
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || !payload.sub) {
    return { ok: false, reason: 'malformed' };
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, subscriberId: payload.sub };
}
