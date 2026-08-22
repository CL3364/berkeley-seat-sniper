import { z } from 'zod';
import { ClassKeySchema } from './class-key';
import { SubscriberEmailSchema } from './email';

/**
 * Seat status for a watched class. Ties to FR-4 (notify on the 0 -> >0 open
 * transition or a freed waitlist slot) and FR-6 (a parse failure must NOT be
 * reported as `closed`/0 — it surfaces as a `parser-broke` ParseResult instead,
 * never as a SeatState).
 *
 *  - `open`     at least one seat is open (openSeats > 0). NOTE this counts TOTAL
 *               open seats as the page publishes them, INCLUDING seats reserved for a
 *               Reservation Group — see `openReserved`, which is a subset of this.
 *  - `waitlist` no open seats, but the waitlist is open / has movement.
 *  - `closed`   no open seats and the waitlist is not open.
 */
export const SEAT_STATUSES = ['open', 'waitlist', 'closed'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const SeatStatusSchema = z.enum(SEAT_STATUSES);

/**
 * Upper bound for any observed count, equal to PostgreSQL `integer` (int4) max.
 *
 * This is a STORAGE bound promoted into the contract on purpose. `class_state`
 * stores counts as int4, and `last_open_seats` is NOT NULL, so a value above this
 * cannot be persisted and cannot be degraded to `null` either — an unbounded
 * `openSeats` parses cleanly and then fails the upsert mid-poll, which is a crash
 * rather than a graceful degradation.
 *
 * The two field classes handle exceeding it DIFFERENTLY, and the asymmetry is the
 * point:
 *  - `openSeats` (alert-driving, NOT NULL in storage) -> `parser-broke`. A page
 *    claiming more than two billion open seats is unreadable, not informative,
 *    and this field drives transition detection and alerting. Widening it to
 *    nullable would widen the core state, transition, and storage contracts for
 *    no product return.
 *  - the optional dashboard observations (nullable in storage) -> `null`. Losing
 *    one display number must never page an operator (FR-26).
 */
export const MAX_OBSERVED_COUNT = 2_147_483_647;

/**
 * A successfully-parsed snapshot of a class's availability at a point in time.
 * Produced by the scraper, consumed by the worker for transition detection
 * (FR-4/FR-5) and persisted into `class_state` (spec §5).
 */
export const SeatStateSchema = z
  .object({
    /** Canonical class this snapshot is for. */
    classKey: ClassKeySchema,
    /** Coarse availability bucket driving the alert decision. */
    status: SeatStatusSchema,
    /**
     * TOTAL count of open seats exactly as the page publishes it ("Total Open Seats"),
     * INCLUDING any reserved for a Reservation Group — `openReserved` counts a subset
     * of this, never an addition. Non-negative integer, bounded by
     * {@link MAX_OBSERVED_COUNT} because storage is int4 NOT NULL — see that
     * constant for why exceeding it is `parser-broke` rather than `null`.
     */
    openSeats: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT),
    /** Whether the waitlist is currently open / accepting movement. */
    waitlistOpen: z.boolean(),
    /** When the source page was fetched (ISO-8601 UTC). Drives the p95 budget (§6). */
    fetchedAt: z.string().datetime(),

    // --- Dashboard observations (owner decision, 2026-07-30) -------------------
    // Extra numbers the per-class dashboard box renders. They are OPTIONAL here,
    // unlike their required-but-nullable counterparts on the wire
    // (`WatchFreshnessSchema` in ./api). The asymmetry is deliberate: the wire shape
    // has several producers and a client that renders a blank box on a missing
    // field, so strictness buys real safety there. A SeatState has exactly ONE
    // producer — `parseClassPage` — so the same strictness buys nothing and would
    // churn every construction site in the tests.
    //
    // SAFETY-CRITICAL, and the whole reason these are not required: a missing or
    // unreadable field here MUST NEVER produce `parser-broke`. A required field
    // would turn a healthy page whose markup merely differs (a section type with no
    // Capacity, say) into an operator page-out that ALSO suppresses that cycle's
    // subscriber alerts — strictly worse than a missing number. Absent becomes
    // undefined/null, the box renders a dash, the poll continues. The three fields
    // above (openSeats, waitlistOpen and the counts behind them) keep their existing
    // STRICT behavior and still yield `parser-broke` when absent or malformed.

    /** Class name from the page heading. Display-only; never an identity or lookup key. */
    displayName: z.string().min(1).max(256).nullish(),
    /** Students currently enrolled. */
    enrolled: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
    /** Total section capacity — the denominator for `openSeats`. Not general-only. */
    capacity: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
    /** Students QUEUED on the waitlist — NOT a count of open slots. See ./api. */
    waitlisted: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
    /** Maximum waitlist size — the denominator for open waitlist slots. */
    waitlistMax: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
    /**
     * Open seats RESERVED for a Reservation Group (major, class standing, enrollment
     * permission, …), as published by the page. A SUBSET of `openSeats`, not an
     * addition to it — the observed live page reported `Total Open Seats: 41` and
     * `Open Reserved Seats: 41`, meaning every open seat was reserved.
     *
     * Why this matters (ADR 0006, corrected): without it the product cannot tell a
     * seat a student can take from one they cannot, and would alert on both
     * identically. The owner's ruling is to ALERT REGARDLESS (2026-08-22) — a
     * reserved seat is real for whoever holds that permission — so this field does
     * NOT gate alerting. It exists to make the dashboard and the alert HONEST about
     * what kind of seat opened.
     *
     * It does NOT establish eligibility. There is no login, so we still cannot know
     * whether a given Subscriber belongs to the group; that half of Plan 0006 stays
     * blocked. Display it, never filter on it.
     */
    openReserved: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
  })
  /**
   * ENFORCE the subset rule rather than only documenting it. `openReserved` counts
   * a portion OF `openSeats`, so `{ openSeats: 2, openReserved: 3 }` is not a
   * pessimistic reading — it is an impossible page, and accepting it would let the
   * dashboard render "2 open (3 reserved)" and the email claim more reserved seats
   * than exist. The parser already degrades a non-subset shape to `null`; this makes
   * the contract itself unable to express the broken state.
   */
  .refine((state) => (state.openReserved ?? 0) <= state.openSeats, {
    message: 'openReserved cannot exceed openSeats; it counts a subset of them',
    path: ['openReserved'],
  });
export type SeatState = z.infer<typeof SeatStateSchema>;

/** Discriminant tag for the parser-broke branch of {@link ParseResult}. */
export const PARSER_BROKE = 'parser-broke' as const;

/**
 * Emitted when the scraper can no longer read a page that STILL EXISTS — a 200
 * response whose shape changed (FR-6). This is a LOUD, distinct signal — it is
 * NOT a SeatState and MUST NOT be coerced into one. The worker routes it to the
 * operator "parser-broke" alert (AC-5, debounced once per broken episode per
 * FR-14) and suppresses any subscriber notification for that cycle. It NEVER
 * overwrites `class_state`. `detail` is operator-facing and MUST NOT echo raw
 * page HTML or any subscriber PII (constitution / §6).
 */
export const ParserBrokeSchema = z.object({
  kind: z.literal(PARSER_BROKE),
  classKey: ClassKeySchema,
  /** Short operator-facing reason, e.g. "seat-count node not found". No HTML, no PII. */
  detail: z.string().min(1).max(280),
});
export type ParserBroke = z.infer<typeof ParserBrokeSchema>;

/** Discriminant tag for the class-gone branch of {@link ParseResult}. */
export const CLASS_GONE = 'class-gone' as const;

/**
 * Emitted when the page for a watched class no longer exists — an HTTP 404 or
 * a recognized "class not found" page (FR-13 / D8). This is EXPECTED lifecycle
 * (a cancelled section or an ended term), not a bug:
 *
 *  - the worker RETIRES every watch on the class (sets `watches.retired_at`,
 *    so it is no longer polled or listed) instead of paging the operator;
 *  - NO operator alert, NO subscriber alert, and `class_state` is untouched.
 *
 * Keep it distinct from {@link ParserBroke}: conflating the two pages the
 * operator for non-bugs (alert fatigue) and hides real parser breakage.
 */
export const ClassGoneSchema = z.object({
  kind: z.literal(CLASS_GONE),
  classKey: ClassKeySchema,
  /** Short operator-facing reason, e.g. "404" or "not-found page". No HTML, no PII. */
  detail: z.string().min(1).max(280),
});
export type ClassGone = z.infer<typeof ClassGoneSchema>;

/**
 * Discriminated union returned by the scraper's `fetchClass`. Consumers branch
 * on a successful `SeatState` (no `kind` field) vs. `ParserBroke`
 * (`kind: 'parser-broke'`, page exists but is unreadable) vs. `ClassGone`
 * (`kind: 'class-gone'`, page no longer exists). The arms are structurally
 * distinct so a fetch/parse failure can never masquerade as "0 open seats"
 * (FR-6) and a vanished class never pages the operator (FR-13).
 */
export const ParseResultSchema = z.union([SeatStateSchema, ParserBrokeSchema, ClassGoneSchema]);
export type ParseResult = SeatState | ParserBroke | ClassGone;

/** Narrowing helper: true when a ParseResult is the parser-broke arm. */
export function isParserBroke(r: ParseResult): r is ParserBroke {
  return (r as ParserBroke).kind === PARSER_BROKE;
}

/** Narrowing helper: true when a ParseResult is the class-gone arm. */
export function isClassGone(r: ParseResult): r is ClassGone {
  return (r as ClassGone).kind === CLASS_GONE;
}

/** Narrowing helper: true when a ParseResult is a successful SeatState. */
export function isSeatState(r: ParseResult): r is SeatState {
  return !isParserBroke(r) && !isClassGone(r);
}

/**
 * The event the WORKER hands the NOTIFIER once it has decided a genuine,
 * deduped opening occurred (FR-4/FR-5). One event targets one subscriber for one
 * class; the worker fans a transition out into N of these — CONFIRMED
 * subscribers only (FR-9). Delivery must be idempotent keyed on
 * `(subscriberId, classKey, openedAt)` (constitution).
 *
 * Simultaneous opening (D13, accepted behavior — documented, not a bug): when
 * seats AND the waitlist open in the same poll cycle, the worker emits ONE
 * event per subscriber and `seats-open` wins (the more-actionable signal). A
 * double-opening is deliberately not double-alerted.
 */
export const NOTIFY_REASONS = ['seats-open', 'waitlist-open'] as const;
export type NotifyReason = (typeof NOTIFY_REASONS)[number];

export const NotifyEventSchema = z
  .object({
    /** Opaque subscriber id — never the email — to keep logs PII-free (§6/AC-8). */
    subscriberId: z.string().min(1),
    /** Delivery address for this event. PII: never logged (constitution). */
    email: SubscriberEmailSchema,
    /** Canonical class that opened. */
    classKey: ClassKeySchema,
    /** Which transition fired the alert. */
    reason: z.enum(NOTIFY_REASONS),
    /**
     * Open seat count observed at the transition (for the message body). Bounded by
     * {@link MAX_OBSERVED_COUNT}: `alert_deliveries.open_seats` is int4 NOT NULL, so
     * this is a SECOND storage boundary with the same overflow failure as
     * `class_state.last_open_seats`. The value originates from a bounded SeatState,
     * so this is defence in depth rather than a distinct source of truth.
     */
    openSeats: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT),
    /** When the opening was observed (ISO-8601 UTC); part of the idempotency key. */
    openedAt: z.string().datetime(),
    /**
     * Of `openSeats`, how many were RESERVED at the moment of the opening (FR-27).
     *
     * OPTIONAL so adding it cannot break existing producers, and because the page
     * may publish no reserved line at all — `null`/absent means "unknown", never
     * "none reserved".
     *
     * It does NOT affect whether this event exists: the owner ruled that an Alert
     * fires on ANY opening (2026-08-22), reserved or not. It exists so the message
     * can be specific instead of hedging. Deliberately a COUNT and not the group
     * name: the name is attacker-influenced text from a third-party page, and this
     * value is rendered into an email.
     */
    openReserved: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
  })
  /** Same subset rule as `SeatState`: an event cannot reserve more seats than opened. */
  .refine((event) => (event.openReserved ?? 0) <= event.openSeats, {
    message: 'openReserved cannot exceed openSeats; it counts a subset of them',
    path: ['openReserved'],
  });
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

/**
 * The JSON payload delivered to a registered browser for one Alert (FR-15 /
 * D10). Web push is ADDITIVE and ALERTS-ONLY: this is the ONLY payload kind
 * ever pushed — never a Confirmation or Manage link, never a token, never an
 * email address. The service worker renders the notification from these fields
 * and derives the click-through URL from the classKey alone
 * (`https://classes.berkeley.edu/content/<classKey>`). The notifier validates
 * against this schema before sending; the service worker validates on receipt.
 */
export const PushAlertPayloadSchema = z
  .object({
    /** Discriminant — the only push payload kind in v1 (alerts-only by contract). */
    kind: z.literal('alert'),
    /** Canonical class that opened. */
    classKey: ClassKeySchema,
    /** Which transition fired the alert (seats-open wins on a simultaneous open, D13). */
    reason: z.enum(NOTIFY_REASONS),
    /** Open seat count observed at the transition. Bounded by {@link MAX_OBSERVED_COUNT}. */
    openSeats: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT),
    /** When the opening was observed (ISO-8601 UTC). */
    openedAt: z.string().datetime(),
    /**
     * Of `openSeats`, how many are RESERVED (FR-27). Carried so the service worker can
     * say what it actually knows: before this it claimed "some seats are reserved" on
     * EVERY alert, which both understates 41-of-41 and asserts a reservation that may
     * not exist when the page reported zero. Nullable — `null` is "unknown", not "none".
     */
    openReserved: z.number().int().nonnegative().max(MAX_OBSERVED_COUNT).nullish(),
  })
  /** Same subset rule as `SeatState`. */
  .refine((payload) => (payload.openReserved ?? 0) <= payload.openSeats, {
    message: 'openReserved cannot exceed openSeats; it counts a subset of them',
    path: ['openReserved'],
  });
export type PushAlertPayload = z.infer<typeof PushAlertPayloadSchema>;

/**
 * A subscriber and the classes they watch. Internal/server-side shape used by
 * the worker for fan-out and by the backend behind a token. `email` is PII;
 * never log it — log `id` and counts only (§6/AC-8).
 *
 * `confirmedAt` realizes the glossary's Pending/Confirmed states (FR-9 /
 * ADR 0001): `null` = Pending Subscriber (receives NO Alerts); a timestamp =
 * Confirmed. Fan-out queries MUST filter to confirmed subscribers.
 */
export const SubscriberSchema = z.object({
  id: z.string().min(1),
  email: SubscriberEmailSchema,
  /** ISO-8601 UTC when confirmed; null while Pending. */
  confirmedAt: z.string().datetime().nullable(),
  watches: z.array(ClassKeySchema),
  createdAt: z.string().datetime(),
});
export type Subscriber = z.infer<typeof SubscriberSchema>;
