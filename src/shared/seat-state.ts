import { z } from 'zod';
import { ClassKeySchema } from './class-key';

/**
 * Seat status for a watched class. Ties to FR-4 (notify on the 0 -> >0 open
 * transition or a freed waitlist slot) and FR-6 (a parse failure must NOT be
 * reported as `closed`/0 — it surfaces as a `parser-broke` ParseResult instead,
 * never as a SeatState).
 *
 *  - `open`     at least one general-enrollment seat is open (openSeats > 0).
 *  - `waitlist` no open seats, but the waitlist is open / has movement.
 *  - `closed`   no open seats and the waitlist is not open.
 */
export const SEAT_STATUSES = ['open', 'waitlist', 'closed'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const SeatStatusSchema = z.enum(SEAT_STATUSES);

/**
 * A successfully-parsed snapshot of a class's availability at a point in time.
 * Produced by the scraper, consumed by the worker for transition detection
 * (FR-4/FR-5) and persisted into `class_state` (spec §5).
 */
export const SeatStateSchema = z.object({
  /** Canonical class this snapshot is for. */
  classKey: ClassKeySchema,
  /** Coarse availability bucket driving the alert decision. */
  status: SeatStatusSchema,
  /** Count of open general-enrollment seats. Non-negative integer. */
  openSeats: z.number().int().nonnegative(),
  /** Whether the waitlist is currently open / accepting movement. */
  waitlistOpen: z.boolean(),
  /** When the source page was fetched (ISO-8601 UTC). Drives the p95 budget (§6). */
  fetchedAt: z.string().datetime(),
});
export type SeatState = z.infer<typeof SeatStateSchema>;

/** Discriminant tag for the parser-broke branch of {@link ParseResult}. */
export const PARSER_BROKE = 'parser-broke' as const;

/**
 * Emitted when the scraper can no longer read the page (FR-6). This is a LOUD,
 * distinct signal — it is NOT a SeatState and MUST NOT be coerced into one. The
 * worker routes it to the operator "parser-broke" alert (AC-5) and suppresses
 * any subscriber notification for that cycle. `detail` is operator-facing and
 * MUST NOT echo raw page HTML or any subscriber PII (constitution / §6).
 */
export const ParserBrokeSchema = z.object({
  kind: z.literal(PARSER_BROKE),
  classKey: ClassKeySchema,
  /** Short operator-facing reason, e.g. "seat-count node not found". No HTML, no PII. */
  detail: z.string().min(1).max(280),
});
export type ParserBroke = z.infer<typeof ParserBrokeSchema>;

/**
 * Discriminated union returned by the scraper's `fetchClass`. Consumers branch
 * on a successful `SeatState` (has `status`) vs. `ParserBroke` (has
 * `kind: 'parser-broke'`). The two arms are kept structurally distinct so a
 * parse failure can never masquerade as "0 open seats" (FR-6).
 */
export const ParseResultSchema = z.union([SeatStateSchema, ParserBrokeSchema]);
export type ParseResult = SeatState | ParserBroke;

/** Narrowing helper: true when a ParseResult is the parser-broke arm. */
export function isParserBroke(r: ParseResult): r is ParserBroke {
  return (r as ParserBroke).kind === PARSER_BROKE;
}

/** Narrowing helper: true when a ParseResult is a successful SeatState. */
export function isSeatState(r: ParseResult): r is SeatState {
  return !isParserBroke(r);
}

/**
 * The event the WORKER hands the NOTIFIER once it has decided a genuine,
 * deduped opening occurred (FR-4/FR-5). One event targets one subscriber for one
 * class; the worker fans a transition out into N of these. Delivery must be
 * idempotent keyed on `(subscriberId, classKey, openedAt)` (constitution).
 */
export const NOTIFY_REASONS = ['seats-open', 'waitlist-open'] as const;
export type NotifyReason = (typeof NOTIFY_REASONS)[number];

export const NotifyEventSchema = z.object({
  /** Opaque subscriber id — never the email — to keep logs PII-free (§6/AC-8). */
  subscriberId: z.string().min(1),
  /** Delivery address for this event. PII: never logged (constitution). */
  email: z.string().email(),
  /** Canonical class that opened. */
  classKey: ClassKeySchema,
  /** Which transition fired the alert. */
  reason: z.enum(NOTIFY_REASONS),
  /** Open seat count observed at the transition (for the message body). */
  openSeats: z.number().int().nonnegative(),
  /** When the opening was observed (ISO-8601 UTC); part of the idempotency key. */
  openedAt: z.string().datetime(),
});
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

/**
 * A subscriber and the classes they watch. Internal/server-side shape used by
 * the worker for fan-out and by the backend behind a token. `email` is PII;
 * never log it — log `id` and counts only (§6/AC-8).
 */
export const SubscriberSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  watches: z.array(ClassKeySchema),
  createdAt: z.string().datetime(),
});
export type Subscriber = z.infer<typeof SubscriberSchema>;
