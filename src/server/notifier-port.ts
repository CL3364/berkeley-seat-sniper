/**
 * Notifier port — the subscriber-facing email dispatch surface the BACKEND
 * depends on (spec §4/§6, FR-9/FR-10/FR-12). Defined in the server lane so the
 * API never imports `src/notify/**` internals directly: `createApp(repo,
 * notifier)` takes this port, and `src/server/index.ts` builds the concrete
 * port at boot by wrapping an eagerly-constructed notify-lane `Notifier`
 * (`notifierPortFrom(createNotifier())`).
 *
 * WHY a port lives here (cross-lane contract, not a duplicate of the notifier):
 *  - The notify lane (task 6) owns the templates, the transport selection, the
 *    suppression check, and the List-Unsubscribe headers. The backend only needs
 *    to *trigger* a confirmation or manage-link send and must not reach into the
 *    notifier's internals.
 *  - The two methods below are the entire contract the backend needs.
 *
 * FAIL-LOUD BY CONSTRUCTION (spec §6 / D7): the concrete notifier is built
 * EAGERLY at process boot in `src/server/index.ts` via `createNotifier()`, and
 * the throw is left UNCAUGHT. A non-noop transport missing OPERATOR_EMAIL /
 * APP_BASE_URL (and, with MAIL_PROVIDER=resend, MAIL_FROM / RESEND_API_KEY) MUST
 * crash startup, exactly as the worker does (src/worker/poller.ts). This port
 * therefore has NO lazy load and NO null-tolerant fallback: a misconfigured
 * server can never come up and silently answer 202 without ever sending mail.
 * It also does NOT depend on the notify lane's module-level senders — it wraps a
 * live `Notifier` instance and calls its methods.
 *
 * PII discipline (constitution / AC-8): the backend passes `email` to the port
 * to address mail, but NEVER logs it. The token is a secret — never logged. The
 * port implementation owns the actual send + the suppression check; the backend
 * does NOT pre-check suppression for the response (resend is constant-shaped 202
 * regardless — FR-10 / AC-11).
 */

/** Input for a subscriber-facing emailed-link dispatch. */
export interface NotifierLinkInput {
  /** Opaque subscriber id (for the notifier's structured logs — not PII). */
  subscriberId: string;
  /** Recipient address. PII — the backend never logs it. */
  email: string;
  /** Signed manage token; the notifier builds the confirm/manage URL from it. */
  token: string;
}

/**
 * The subscriber-facing dispatch surface the backend triggers. Implementations
 * MUST resolve even when the address is suppressed (silent withhold, FR-12) and
 * MUST NOT throw for a suppressed address — only for an unexpected transport
 * fault, which the backend treats as `internal_error` on the confirm-coupled
 * subscribe path but swallows-with-log on the non-enumerating resend path so the
 * 202 stays constant (AC-11).
 */
export interface NotifierPort {
  /** Dispatch a confirmation email (subscribe + resend-while-Pending). */
  sendConfirmation(input: NotifierLinkInput): Promise<void>;
  /** Dispatch a manage-link email (resend-while-Confirmed). */
  sendManageLink(input: NotifierLinkInput): Promise<void>;
}

/**
 * The slice of the notify lane's `Notifier` instance the backend invokes (task
 * 6). Typed structurally (NOT by importing `src/notify/types`) so a transient
 * build error in the notify lane never breaks the server typecheck. The two
 * methods take `{ subscriberId, email, token }` and resolve to a `SendResult`
 * the backend discards.
 */
export interface NotifierSource {
  sendConfirmation(input: NotifierLinkInput): Promise<unknown>;
  sendManageLink(input: NotifierLinkInput): Promise<unknown>;
}

/**
 * Adapt an already-constructed notify-lane `Notifier` to the backend's
 * `NotifierPort`, discarding the `SendResult`. The notifier is constructed at
 * boot in `src/server/index.ts` (eager, uncaught — fail-loud on misconfig); this
 * wrapper only bridges the return type. It adds NO try/catch: a per-send
 * transport fault is surfaced to the caller, which owns the per-route handling
 * (internal_error log on subscribe, fire-and-forget swallow-with-log on the
 * non-enumerating resend path).
 */
export function notifierPortFrom(notifier: NotifierSource): NotifierPort {
  return {
    async sendConfirmation(input: NotifierLinkInput): Promise<void> {
      await notifier.sendConfirmation(input);
    },
    async sendManageLink(input: NotifierLinkInput): Promise<void> {
      await notifier.sendManageLink(input);
    },
  };
}
