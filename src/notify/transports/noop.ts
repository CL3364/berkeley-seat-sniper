import type { Transport, TransportMessage } from '../types';

/**
 * No-op transport (FR-8). Simulates successful delivery without making any
 * network calls. Logging uses opaque metadata only — `to` is NOT printed
 * (PII rule; constitution/§6/AC-8).
 *
 * The outbox is owned and written by the Notifier layer (see index.ts), not by
 * this transport, so there is no double-push race when dispatch and alertOperator
 * both flow through the same send function. This transport's sole job is to
 * confirm "I would have sent this" and return successfully.
 */
export function createNoopTransport(): Transport {
  return {
    // Brand (Transport.kind, see ../types): ONLY the no-op transport carries
    // `kind: 'noop'`. The env-gated NOOP_OUTBOX_FILE sink in index.ts keys off
    // THIS field — not "a transport was injected" — so an explicitly injected
    // REAL transport (brand unset) can never tee subscriber emails + tokens to
    // disk (spec v0.3.1: the sink is honored only when the transport IS noop).
    kind: 'noop',
    async send(message: TransportMessage) {
      // Structured log — no address, no watch list (AC-8).
      console.log(
        JSON.stringify({
          level: 'info',
          transport: 'noop',
          event: 'mail_queued',
          subject: message.subject,
          sentAt: new Date().toISOString(),
        }),
      );
      // No network call; no outbox push — the Notifier layer owns those.
      return { status: 'success' as const, acceptedAt: new Date() };
    },
  };
}
