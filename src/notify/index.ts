/**
 * src/notify/index.ts
 *
 * Delivery layer for the seat-sniper worker. Public API:
 *
 *   createNotifier(options?)  → Notifier
 *     .dispatch(event)        → Promise<DispatchResult>  (idempotent, AC-3/AC-4)
 *     .alertOperator(key, d)  → Promise<void>            (parser-broke, AC-5)
 *     .outbox                 → OutboxEntry[]            (noop transport only)
 *
 * Transport is selected by MAIL_TRANSPORT env var:
 *   noop  (default) — append-only in-memory outbox; no network calls (FR-8)
 *   real            — SMTP or Resend adapter (env-keyed; never hardcoded)
 *
 * PII discipline (constitution / §6 / AC-8):
 *   - event.email is used to address mail but NEVER appears in any log line.
 *   - Log lines carry subscriberId + counts only.
 *   - The outbox holds full sent-mail snapshots (it models the sent mail), but
 *     log lines do not.
 *
 * Idempotency (FR-4/FR-5): keyed on (subscriberId, classKey, openedAt).
 * A repeat dispatch of the same event is a confirmed no-op (not an error).
 *
 * Delivery failures from the transport are surfaced as thrown errors — the
 * worker catches them and counts them as failures; they never silently vanish.
 */

import type { NotifyEvent } from '../shared/seat-state';
import type { Notifier, OutboxEntry, DispatchResult, Transport } from './types';
import { createNoopTransport } from './transports/noop';
import { createRealTransport } from './transports/smtp';
import { renderSeatOpenEmail, renderOperatorAlert } from './render';

// ---------------------------------------------------------------------------
// Notifier factory
// ---------------------------------------------------------------------------

export interface NotifierOptions {
  /**
   * Override the transport directly (useful in tests without relying on env).
   * When provided, MAIL_TRANSPORT is ignored.
   */
  transport?: Transport;

  /**
   * Sender address. Falls back to MAIL_FROM env var, then a safe default.
   * The real transport also validates MAIL_FROM at construction, so this only
   * matters for the noop path.
   */
  from?: string;
}

/**
 * Create a Notifier. Call once per process (or per test suite). The returned
 * object is safe to share across concurrent dispatch calls — the delivered-keys
 * Set is synchronously updated before any await so double-fires on the same
 * event are reliably caught even in a single-threaded event loop.
 *
 *   // test usage
 *   const { dispatch, alertOperator, outbox } = createNotifier({ transport: createNoopTransport(outbox) });
 *
 *   // production usage (reads MAIL_TRANSPORT from env)
 *   const notifier = createNotifier();
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const outbox: OutboxEntry[] = [];

  // Select transport.
  let transport: Transport;
  if (options.transport) {
    transport = options.transport;
  } else {
    const mailTransport = process.env['MAIL_TRANSPORT'] ?? 'noop';
    transport = mailTransport === 'noop' ? createNoopTransport(outbox) : createRealTransport();
  }

  const from = options.from ?? process.env['MAIL_FROM'] ?? 'alerts@berkeley-seat-sniper.local';

  // Idempotency store: keys are `${subscriberId}:${classKey}:${openedAt}`.
  // Using a Set gives O(1) lookup and is sufficient for a single-process
  // notifier. A persistent store (Redis/DB) would be needed for multi-process.
  const deliveredKeys = new Set<string>();

  // ---------------------------------------------------------------------------
  // dispatch
  // ---------------------------------------------------------------------------

  async function dispatch(event: NotifyEvent): Promise<DispatchResult> {
    const key = `${event.subscriberId}:${event.classKey}:${event.openedAt}`;

    // Idempotency check — synchronous, before any await.
    if (deliveredKeys.has(key)) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'notify_dedupe',
          subscriberId: event.subscriberId,
          classKey: event.classKey,
          idempotencyKey: key,
        }),
      );
      return { sent: false, idempotencyKey: key };
    }

    // Claim the key before awaiting the transport so a concurrent duplicate
    // call (e.g. fan-out race) is blocked rather than double-sent.
    deliveredKeys.add(key);

    const { subject, body } = renderSeatOpenEmail(event);

    try {
      await transport.send({ to: event.email, from, subject, body });
    } catch (err) {
      // Release the key so a retry attempt after a transient failure can re-try.
      deliveredKeys.delete(key);

      // Log without the email address (AC-8).
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'notify_send_failed',
          subscriberId: event.subscriberId,
          classKey: event.classKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      // Surface the failure to the worker — do not swallow.
      throw err;
    }

    // For the noop transport the outbox entry is pushed inside the transport's
    // send; we annotate it with our idempotency key and subscriber id after
    // the fact. For real transports the outbox is empty — that's intentional.
    const lastEntry = outbox.at(-1);
    if (lastEntry) {
      lastEntry.idempotencyKey = key;
    }

    // Structured log — subscriberId only, never the email (AC-8).
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'notify_sent',
        subscriberId: event.subscriberId,
        classKey: event.classKey,
        reason: event.reason,
        openSeats: event.openSeats,
        idempotencyKey: key,
      }),
    );

    return { sent: true, idempotencyKey: key };
  }

  // ---------------------------------------------------------------------------
  // alertOperator
  // ---------------------------------------------------------------------------

  async function alertOperator(classKey: string, detail: string): Promise<void> {
    const operatorEmail = process.env['OPERATOR_EMAIL'] ?? from;

    const { subject, body } = renderOperatorAlert(classKey, detail);

    // Push a distinct 'operator' entry directly to the outbox so tests can
    // assert exactly: one operator alert AND zero subscriber entries (AC-5).
    // We do this before the transport call so the record exists even if the
    // send fails (operator alerts are best-effort; the important thing is that
    // the incident is recorded in the outbox for the test harness / logging).
    const operatorEntry: OutboxEntry = {
      kind: 'operator',
      to: operatorEmail,
      subject,
      body,
      sentAt: new Date().toISOString(),
      detail,
    };
    outbox.push(operatorEntry);

    // Log the incident (class key is not PII; detail is operator-facing and
    // must not contain subscriber emails — callers own that invariant).
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'parser_broke_alert',
        classKey,
        detail,
      }),
    );

    try {
      await transport.send({ to: operatorEmail, from, subject, body });
    } catch (err) {
      // Operator alert delivery failure is logged but not re-thrown — the
      // incident is already recorded in the outbox; failing to email the
      // operator is not a reason to crash the poll cycle.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'operator_alert_send_failed',
          classKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Return the Notifier
  // ---------------------------------------------------------------------------

  return {
    dispatch,
    alertOperator,
    get outbox(): OutboxEntry[] {
      return outbox;
    },
  };
}

// Re-export types the worker and test-engineer need.
export type { Notifier, OutboxEntry, DispatchResult } from './types';
export type { NotifyEvent } from '../shared/seat-state';
