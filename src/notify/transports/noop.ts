import type { Transport, TransportMessage, OutboxEntry } from '../types';

/**
 * No-op transport (FR-8). Appends every sent message to an in-memory outbox
 * array rather than making any network calls. The outbox is shared by
 * reference, so tests can inspect it directly:
 *
 *   const outbox: OutboxEntry[] = [];
 *   const t = createNoopTransport(outbox);
 *
 * Log line: one structured line per send with opaque metadata only — `to` is
 * NOT printed (PII rule; constitution/§6/AC-8).
 */
export function createNoopTransport(outbox: OutboxEntry[]): Transport {
  return {
    async send(message: TransportMessage): Promise<void> {
      const entry: OutboxEntry = {
        // kind is filled by the Notifier layer; transport just stores the envelope.
        // We default to 'subscriber' here; the Notifier overwrites it for operator
        // alerts by pushing directly, not through this path.
        kind: 'subscriber',
        to: message.to,
        subject: message.subject,
        body: message.body,
        sentAt: new Date().toISOString(),
      };
      outbox.push(entry);

      // Structured log — no address, no watch list (AC-8).
      console.log(
        JSON.stringify({
          level: 'info',
          transport: 'noop',
          event: 'mail_sent',
          subject: message.subject,
          sentAt: entry.sentAt,
        }),
      );
    },
  };
}
