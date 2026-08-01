/**
 * Production mail safety invariants shared by both notifier entry surfaces.
 *
 * Development and test may use the branded noop transport and its inspectable
 * NDJSON sink. Production must never retain those PII/token-bearing snapshots,
 * and must select the one provider configuration that the deployment supports.
 */
export function assertProductionMailRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.NOOP_OUTBOX_FILE?.trim()) {
    throw new Error('NOOP_OUTBOX_FILE is forbidden in production');
  }
  if (env.MAIL_TRANSPORT?.trim() !== 'real') {
    throw new Error('MAIL_TRANSPORT must be real in production');
  }
  if (env.MAIL_PROVIDER?.trim() !== 'resend') {
    throw new Error('MAIL_PROVIDER must be resend in production');
  }
}

/** Reject an explicitly injected branded noop just as strictly as env selection. */
export function assertProductionMailTransport(
  transportKind: 'noop' | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === 'production' && transportKind === 'noop') {
    throw new Error('the noop mail transport is forbidden in production');
  }
}
