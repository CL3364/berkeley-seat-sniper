/**
 * src/notify/index.ts
 *
 * Delivery layer for the seat-sniper worker. Public API:
 *
 *   createNotifier(options?)  → Notifier
 *     .dispatch(event)        → Promise<DispatchResult>  (idempotent, AC-3/AC-4)
 *     .alertOperator(key, d)  → Promise<void>            (parser-broke, AC-5)
 *     .outbox                 → OutboxEntry[]            (noop/any transport)
 *
 * Transport is selected by MAIL_TRANSPORT env var:
 *   noop  (default) — no network calls; outbox captures sent mail (FR-8)
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
 *
 * Outbox ownership: the Notifier layer pushes all OutboxEntry records so there
 * is no double-push race between the transport and the notifier. The transport's
 * only job is to confirm delivery (or throw on failure).
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
   * Sender address. Falls back to MAIL_FROM env var, then a local default.
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
 * Usage:
 *   // production (reads MAIL_TRANSPORT from env; defaults to 'noop')
 *   const notifier = createNotifier();
 *
 *   // test usage (explicit noop, inspect outbox)
 *   const notifier = createNotifier({ transport: createNoopTransport() });
 *   await notifier.dispatch(event);
 *   console.log(notifier.outbox); // [{ kind: 'subscriber', subject: '...', ... }]
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  // The outbox is owned here; all pushes happen in this module.
  const outbox: OutboxEntry[] = [];

  // Select transport.
  let transport: Transport;
  if (options.transport) {
    transport = options.transport;
  } else {
    const mailTransport = process.env['MAIL_TRANSPORT'] ?? 'noop';
    transport = mailTransport === 'noop' ? createNoopTransport() : createRealTransport();
  }

  const from = options.from ?? process.env['MAIL_FROM'] ?? 'alerts@berkeley-seat-sniper.local';

  // Idempotency store: keys are `${subscriberId}:${classKey}:${openedAt}`.
  // A Set is sufficient for a single-process notifier. For multi-process
  // deployments, back this with a Redis SETNX or a DB unique constraint.
  const deliveredKeys = new Set<string>();

  // ---------------------------------------------------------------------------
  // dispatch
  // ---------------------------------------------------------------------------

  async function dispatch(event: NotifyEvent): Promise<DispatchResult> {
    const key = `${event.subscriberId}:${event.classKey}:${event.openedAt}`;

    // Idempotency check — synchronous, before any await, so a concurrent
    // duplicate call (e.g. fan-out race) is reliably blocked.
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

    // Claim the key before awaiting so a concurrent call is blocked.
    deliveredKeys.add(key);

    const { subject, body } = renderSeatOpenEmail(event);

    try {
      await transport.send({ to: event.email, from, subject, body });
    } catch (err) {
      // Release the key so a retry after a transient failure can succeed.
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

    // Record in the outbox after successful delivery (Notifier owns the outbox).
    outbox.push({
      kind: 'subscriber',
      to: event.email,
      subject,
      body,
      sentAt: new Date().toISOString(),
      idempotencyKey: key,
    });

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

    // Log the incident (classKey is not PII; detail must not contain subscriber
    // emails — callers own that invariant per constitution / §6).
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'parser_broke_alert',
        classKey,
        detail,
      }),
    );

    const sentAt = new Date().toISOString();

    try {
      await transport.send({ to: operatorEmail, from, subject, body });
    } catch (err) {
      // Operator alert delivery failure is logged but NOT re-thrown — failing to
      // email the operator must not crash the poll cycle. The incident is always
      // recorded in the outbox below.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'operator_alert_send_failed',
          classKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Push a distinct 'operator' entry to the outbox. Tests can assert:
    //   outbox.filter(e => e.kind === 'operator').length === 1   (AC-5)
    //   outbox.filter(e => e.kind === 'subscriber').length === 0  (AC-5)
    outbox.push({
      kind: 'operator',
      to: operatorEmail,
      subject,
      body,
      sentAt,
      detail,
    });
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
// Re-export transport factory so tests can wire noop explicitly.
export { createNoopTransport } from './transports/noop';
