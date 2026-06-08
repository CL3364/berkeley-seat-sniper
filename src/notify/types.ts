import type { NotifyEvent } from '../shared/seat-state';

/**
 * An entry in the outbox — models a single sent message. The `to` field holds
 * the delivery address (present because the outbox models the sent mail, not a
 * log line; log lines MUST NOT print it). Tests inspect this shape.
 */
export interface OutboxEntry {
  /** 'subscriber' for a seat-open alert; 'operator' for a parser-broke alert. */
  kind: 'subscriber' | 'operator';
  /** Delivery address — present in outbox only, never in log lines. */
  to: string;
  subject: string;
  body: string;
  /** ISO-8601 UTC timestamp of when this entry was recorded. */
  sentAt: string;
  /** For subscriber entries: the idempotency key that was consumed. */
  idempotencyKey?: string;
  /** For operator entries: free-form detail from the alertOperator call. */
  detail?: string;
}

/**
 * The interface every transport adapter must satisfy. Transports are stateless
 * with respect to idempotency — deduplication is owned by the Notifier layer.
 */
export interface Transport {
  /**
   * Send a single message. Implementations may retry internally but MUST
   * surface a failure rather than swallowing it — the notifier layer logs the
   * error and bubbles it to the worker so it can be counted as a failure, not
   * silently dropped.
   */
  send(message: TransportMessage): Promise<void>;
}

/** Minimal wire shape passed to a transport. */
export interface TransportMessage {
  to: string;
  from: string;
  subject: string;
  body: string;
}

/**
 * The public API surface of a Notifier instance. `outbox` is only populated by
 * the noop transport and is always an empty array on real transports — tests
 * should only read it when they know they wired a noop transport.
 */
export interface Notifier {
  /**
   * Deliver a seat-open notification to one subscriber. Idempotent keyed on
   * `(subscriberId, classKey, openedAt)` — a repeat call with the same event
   * is a no-op. PII rule: never log event.email; log subscriberId + counts.
   */
  dispatch(event: NotifyEvent): Promise<DispatchResult>;

  /**
   * Record a distinct operator-facing alert for a parser-broke incident.
   * Never emits a subscriber notification; records a separate outbox entry so
   * tests can assert the distinction (AC-5).
   */
  alertOperator(classKey: string, detail: string): Promise<void>;

  /** Inspect delivered messages — only populated by the noop transport. */
  readonly outbox: OutboxEntry[];
}

/** Result returned by dispatch so the worker can track metrics. */
export interface DispatchResult {
  /** true = message was sent; false = suppressed by idempotency dedupe. */
  sent: boolean;
  /** Opaque key used for dedupe (useful for test assertions). */
  idempotencyKey: string;
}
