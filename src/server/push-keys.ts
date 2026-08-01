import { ECDH } from 'node:crypto';
import type { PushKeys } from '../shared/api';

/**
 * Validate the P-256 point, not only its wire length. A corrupted canonical
 * 65-byte value otherwise persists successfully and fails every later push.
 */
export function hasValidPushCurvePoint(keys: PushKeys): boolean {
  try {
    const point = Buffer.from(keys.p256dh, 'base64url');
    void ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'uncompressed');
    return true;
  } catch {
    return false;
  }
}
