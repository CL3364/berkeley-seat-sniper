import { describe, expect, it } from 'vitest';

import { parseResendWebhookSecret } from './resend-webhook-secret';

describe('parseResendWebhookSecret', () => {
  it('decodes a canonical provider-issued secret', () => {
    const key = Buffer.alloc(24, 0xa5);

    expect(parseResendWebhookSecret(`whsec_${key.toString('base64')}`)).toEqual(key);
  });

  it('accepts canonical base64 with omitted padding', () => {
    const key = Buffer.alloc(25, 0x3c);
    const encoded = key.toString('base64').replace(/=+$/, '');

    expect(parseResendWebhookSecret(`whsec_${encoded}`)).toEqual(key);
  });

  it.each([
    [undefined, 'RESEND_WEBHOOK_SECRET is required'],
    ['', 'RESEND_WEBHOOK_SECRET is required'],
    [
      Buffer.alloc(24, 0xa5).toString('base64'),
      'RESEND_WEBHOOK_SECRET must use the provider-issued whsec_ format',
    ],
    ['whsec_!!!!', 'RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64'],
    ['whsec_A', 'RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64'],
    [
      `whsec_${Buffer.alloc(23, 0xa5).toString('base64')}`,
      'RESEND_WEBHOOK_SECRET whsec_ payload must be canonical base64 encoding at least 24 bytes',
    ],
  ])('rejects an invalid secret %#', (secret, message) => {
    expect(() => parseResendWebhookSecret(secret)).toThrow(message);
  });
});
