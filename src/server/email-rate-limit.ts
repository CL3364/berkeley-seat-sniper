/**
 * Compatibility exports for older server tests/imports.
 *
 * v0.4 uses the shared Redis-backed limiter in `rate-limit.ts` for both IP and
 * normalized-email windows. Keeping this module avoids a flag-day import break
 * while ensuring there is only one implementation and one resettable dev store.
 */

export { checkEmailLimit } from './rate-limit';
export { resetRateLimitStore as resetEmailRateLimitStore } from './rate-limit';
