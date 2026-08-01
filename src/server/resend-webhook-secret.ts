/** Minimum HMAC key size for Resend/Svix webhook verification. */
const MIN_SECRET_BYTES = 24;

/**
 * Parse and validate a server-only Resend/Svix webhook secret.
 *
 * Node's base64 decoder is deliberately permissive, so validate and
 * canonicalize before accepting key bytes.
 */
export function parseResendWebhookSecret(secret: string | undefined): Buffer {
  if (!secret) {
    throw new Error('RESEND_WEBHOOK_SECRET is required');
  }
  if (!secret.startsWith('whsec_')) {
    throw new Error('RESEND_WEBHOOK_SECRET must use the provider-issued whsec_ format');
  }

  const encoded = secret.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64');
  }
  const withoutPadding = encoded.replace(/=+$/, '');
  if (withoutPadding.length % 4 === 1) {
    throw new Error('RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64');
  }

  const key = Buffer.from(encoded, 'base64');
  const canonical = key.toString('base64').replace(/=+$/, '');
  if (canonical !== withoutPadding || key.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64 encoding at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  return key;
}
