/** Shared outbound-send deadline configuration (spec §6, v0.3.3). */

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * Resolve SEND_TIMEOUT_MS without allowing zero, negative, fractional, or
 * otherwise malformed values to disable the delivery deadline accidentally.
 */
export function getSendTimeoutMs(): number {
  const raw = process.env.SEND_TIMEOUT_MS;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SEND_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SEND_TIMEOUT_MS;
}
