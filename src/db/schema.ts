import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { SUPPRESSION_REASONS } from '../shared/api';
import { NOTIFY_REASONS, SEAT_STATUSES } from '../shared/seat-state';

/**
 * Monotonic visibility boundary shared by watch activations and successful
 * observations. Table locks define commit order; this sequence records that
 * order without depending on wall-clock monotonicity or timestamp resolution.
 */
export const watchVisibilityOrder = pgSequence('watch_visibility_order_seq');

/**
 * PostgreSQL's database-boundary form of the canonical v0.4 ClassKey grammar.
 *
 * Keep this synchronized with `CLASS_KEY_PATTERN` in `src/shared/class-key.ts`.
 * PostgreSQL ARE supports the positive look-ahead constraints used here. They
 * are what distinguish canonical zero-padded numeric identifiers (`001`) from
 * bounded alphanumeric catalog identifiers (`999l`) without an allowlist of
 * component codes.
 */
const DB_CLASS_KEY_PATTERN =
  '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$';

/**
 * `blind-window` (FR-28) is the ONE subscriber-facing kind that is not an
 * Opening. It is a mail kind rather than a third `NOTIFY_REASON` on purpose:
 * `NOTIFY_REASONS` is the architect-owned contract for Openings, and both its
 * dedup rule ("seats-open wins, the more-actionable signal") and
 * `PushAlertPayload` assume the thing being reported HAPPENED. A Blind window
 * is the absence of an observation, so it carries `reason = null` and never
 * pushes (push is alerts-only by contract).
 */
export const MAIL_OUTBOX_KINDS = [
  'alert',
  'confirmation',
  'manage-link',
  'operator',
  'blind-window',
] as const;
export type MailOutboxKind = (typeof MAIL_OUTBOX_KINDS)[number];

export const MAIL_OUTBOX_STATUSES = [
  'queued',
  'processing',
  'sent',
  'cancelled',
  'dead_letter',
] as const;
export type MailOutboxStatus = (typeof MAIL_OUTBOX_STATUSES)[number];

export const MAIL_OUTBOX_TERMINAL_REASONS = [
  'opening-closed',
  'expired',
  'permanent-failure',
  'retry-horizon',
  'subscriber-ineligible',
  'suppressed',
] as const;
export type MailOutboxTerminalReason = (typeof MAIL_OUTBOX_TERMINAL_REASONS)[number];

export const PARSER_HEALTH_STATUSES = ['healthy', 'broken'] as const;
export type ParserHealthStatus = (typeof PARSER_HEALTH_STATUSES)[number];

export const DEAD_LETTER_INCIDENT_STATES = ['unresolved', 'acknowledged', 'resolved'] as const;
export type DeadLetterIncidentState = (typeof DEAD_LETTER_INCIDENT_STATES)[number];

/**
 * Subscribers — one row per email address. `id` is the opaque `subscriberId`
 * exposed in API responses. `email` is PII: never log it (constitution / AC-8).
 * The manage token is derived from `id` at runtime and is never stored here.
 *
 * Double opt-in (FR-9 / D3 / ADR 0001): `confirmed_at IS NULL` = Pending
 * Subscriber (receives NO Alerts); a non-null timestamp = Confirmed. The
 * confirm endpoint sets it exactly once and is idempotent — never updated after
 * the first set. Fan-out (getSubscribersWatching) MUST filter to confirmed rows.
 */
export const subscribers = pgTable(
  'subscribers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // PII — never log; unique index created implicitly by .unique()
    email: text('email').notNull().unique(),
    // NULL = Pending; a timestamp = Confirmed. Set once by the confirm endpoint.
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'subscribers_email_normalized_berkeley',
      sql`${t.email} = lower(btrim(${t.email}))
        and char_length(${t.email}) <= 254
        and ${t.email} ~ '^[^+[:space:]@]+@berkeley[.]edu$'`,
    ),
    check(
      'subscribers_confirmation_after_creation',
      sql`${t.confirmedAt} is null or ${t.confirmedAt} >= ${t.createdAt}`,
    ),
  ],
);

/**
 * Watches — one row per (subscriber, class) pair. `class_key` stores the
 * canonical ClassKey string (validated with ClassKeySchema before insert).
 *
 * Retirement (FR-13 / D8 / spec §5): `retired_at IS NULL` = live; a non-null
 * timestamp = retired (class-gone). A retired watch is soft-retired via the
 * timestamp rather than deleted — it preserves the glossary's live/retired Watch
 * semantics, avoids destructive writes from the worker, and lets a re-add REVIVE
 * the row (clear retired_at) while keeping the unique constraint. A retired watch
 * is excluded from polling, fan-out, and the manage view.
 *
 * Indexes:
 *   - watches_class_key_idx: filters by class_key for worker fan-out
 *     (getSubscribersWatching + getDistinctWatchedClassKeys — hot path, FR-3).
 *     A partial WHERE retired_at IS NULL index is not used because most rows are
 *     live; the live filter is applied as a query predicate on top of this index.
 *   - watches_subscriber_class_uq: enforces the uniqueness constraint and
 *     doubles as an index on (subscriber_id, class_key) for listWatches. The
 *     constraint spans (subscriber_id, class_key) regardless of retired_at, so a
 *     revived row reuses the same row rather than creating a duplicate.
 */
export const watches = pgTable(
  'watches',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriberId: text('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // Canonical ClassKey string — validated at the repo boundary before insert
    classKey: text('class_key').notNull(),
    // NULL = live; a timestamp = retired (class-gone). Re-add clears it (revive).
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Reset on every revival. Opening fan-out includes only watches active at
    // the prior successful observation, preventing inherited baseline alerts.
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activationOrder: bigint('activation_order', { mode: 'bigint' }),
  },
  (t) => [
    unique('watches_subscriber_class_uq').on(t.subscriberId, t.classKey),
    // Keep the database boundary aligned with HTTP validation. v0.4 has no
    // production legacy rows to preserve, so the forward migration removes
    // unusable pre-contract keys before adding this strict check.
    check('watches_class_key_valid', sql`${t.classKey} ~ ${sql.raw(`'${DB_CLASS_KEY_PATTERN}'`)}`),
    check(
      'watches_activation_consistent',
      sql`(${t.activatedAt} is null and ${t.activationOrder} is null)
        or (${t.activatedAt} is not null and ${t.activationOrder} > 0)`,
    ),
    // Fan-out index: worker queries watches by class_key to find all subscribers
    index('watches_class_key_idx').on(t.classKey),
  ],
);

/**
 * Class state — one row per watched class key. Persists the last known
 * availability so the worker can detect genuine 0→>0 seat transitions (FR-4)
 * and deduplicate repeat alerts (FR-5).
 *
 * IMPORTANT: this table is NEVER updated when the scraper emits parser-broke
 * (FR-6 / AC-5). Only a successful SeatState parse triggers upsertClassState.
 *
 * `last_status` mirrors the SeatStatus union from src/shared/seat-state.ts.
 * `parser-broke` is NOT a SeatStatus and must never be stored here.
 */
export const classState = pgTable(
  'class_state',
  {
    // Canonical ClassKey — primary key, so getClassState and upsertClassState
    // are O(1) by PK lookup and INSERT … ON CONFLICT DO UPDATE.
    classKey: text('class_key').primaryKey(),
    // SeatStatus enum: 'open' | 'waitlist' | 'closed' — from src/shared
    lastStatus: text('last_status', { enum: SEAT_STATUSES }).notNull(),
    lastOpenSeats: integer('last_open_seats').notNull(),
    lastWaitlistOpen: boolean('last_waitlist_open').notNull(),
    // Optional dashboard observations. NULL is a first-class value meaning the
    // latest successful page did not publish a usable value (FR-25–FR-27).
    displayName: text('display_name'),
    lastEnrolled: integer('last_enrolled'),
    lastCapacity: integer('last_capacity'),
    lastWaitlisted: integer('last_waitlisted'),
    lastWaitlistMax: integer('last_waitlist_max'),
    lastOpenReserved: integer('last_open_reserved'),
    // Exact optimistic-lock token. Do not CAS on updated_at: PostgreSQL stores
    // microseconds while node-postgres round-trips Date at millisecond precision,
    // so equality against a fetched JS Date can miss the row in production.
    stateVersion: integer('state_version').notNull().default(0),
    // High-water mark of watch activations visible to this successful parse.
    observedWatchOrder: bigint('observed_watch_order', { mode: 'bigint' })
      .notNull()
      .default(sql`nextval('watch_visibility_order_seq')`),
    // Successful public-page observation. `updated_at` is lastCheckedAt;
    // this deadline includes cache eligibility plus the two-minute target.
    sourceFreshUntil: timestamp('source_fresh_until', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp() + interval '120 seconds'`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    check(
      'class_state_class_key_valid',
      sql`${t.classKey} ~ ${sql.raw(`'${DB_CLASS_KEY_PATTERN}'`)}`,
    ),
    check('class_state_status_valid', sql`${t.lastStatus} in ('open', 'waitlist', 'closed')`),
    check('class_state_open_seats_nonnegative', sql`${t.lastOpenSeats} >= 0`),
    check(
      'class_state_open_reserved_subset',
      sql`${t.lastOpenReserved} is null
        or (${t.lastOpenReserved} >= 0 and ${t.lastOpenReserved} <= ${t.lastOpenSeats})`,
    ),
    check(
      'class_state_display_name_valid',
      sql`${t.displayName} is null or char_length(${t.displayName}) between 1 and 256`,
    ),
    check(
      'class_state_enrolled_nonnegative',
      sql`${t.lastEnrolled} is null or ${t.lastEnrolled} >= 0`,
    ),
    check(
      'class_state_capacity_nonnegative',
      sql`${t.lastCapacity} is null or ${t.lastCapacity} >= 0`,
    ),
    check(
      'class_state_waitlisted_nonnegative',
      sql`${t.lastWaitlisted} is null or ${t.lastWaitlisted} >= 0`,
    ),
    check(
      'class_state_waitlist_max_nonnegative',
      sql`${t.lastWaitlistMax} is null or ${t.lastWaitlistMax} >= 0`,
    ),
    check('class_state_version_nonnegative', sql`${t.stateVersion} >= 0`),
    check('class_state_observed_order_positive', sql`${t.observedWatchOrder} > 0`),
  ],
);

/**
 * Durable parser episode state (FR-14).
 *
 * Absence means the Section has never entered a broken episode. A broken row
 * and its Operator outbox job are committed together; recovery is the only
 * transition back to healthy. This survives process restart and worker
 * failover, unlike an in-memory debounce timer.
 */
export const parserHealth = pgTable(
  'parser_health',
  {
    classKey: text('class_key').primaryKey(),
    status: text('status', { enum: PARSER_HEALTH_STATUSES }).notNull(),
    episodeStartedAt: timestamp('episode_started_at', { withTimezone: true }),
    alertEnqueuedAt: timestamp('alert_enqueued_at', { withTimezone: true }),
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    check(
      'parser_health_class_key_valid',
      sql`${t.classKey} ~ ${sql.raw(`'${DB_CLASS_KEY_PATTERN}'`)}`,
    ),
    check('parser_health_status_valid', sql`${t.status} in ('healthy', 'broken')`),
    check(
      'parser_health_state_consistent',
      sql`(
          ${t.status} = 'broken'
          and ${t.episodeStartedAt} is not null
          and ${t.alertEnqueuedAt} is not null
          and ${t.recoveredAt} is null
          and ${t.alertEnqueuedAt} >= ${t.episodeStartedAt}
          and ${t.updatedAt} >= ${t.alertEnqueuedAt}
        ) or (
          ${t.status} = 'healthy'
          and ${t.episodeStartedAt} is not null
          and ${t.alertEnqueuedAt} is not null
          and ${t.recoveredAt} is not null
          and ${t.alertEnqueuedAt} >= ${t.episodeStartedAt}
          and ${t.recoveredAt} >= ${t.alertEnqueuedAt}
          and ${t.updatedAt} >= ${t.recoveredAt}
        )`,
    ),
  ],
);

/**
 * Suppressions — one row per suppressed email ADDRESS (FR-12 / D4-D5 / spec §5).
 *
 * Keyed on the address, NOT a subscriber id, by deliberate design: suppression
 * is a property of the address and must survive unsubscribe/re-subscribe (else
 * deliverability hygiene resets every time a bounced/complained address churns
 * through the subscriber table). Rows are PII retained past subscriber deletion
 * (the standard deliverability-suppression exception); keep the table tiny and
 * NEVER log its rows (constitution / AC-8). No purge in v1.
 *
 * `reason` mirrors the contract's SUPPRESSION_REASONS ('bounce' | 'complaint').
 * Upsert on conflict — first reason wins (suppressEmail uses DO NOTHING), since
 * once suppressed the address stays suppressed regardless of a later signal.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    // PII — never log. The email IS the primary key (suppression is per-address).
    email: text('email').primaryKey(),
    // 'bounce' | 'complaint' — from the contract's SUPPRESSION_REASONS union.
    reason: text('reason', { enum: SUPPRESSION_REASONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'suppressions_email_normalized',
      sql`${t.email} = lower(btrim(${t.email}))
        and char_length(${t.email}) <= 254
        and ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`,
    ),
    check('suppressions_reason_valid', sql`${t.reason} in ('bounce', 'complaint')`),
  ],
);

/**
 * Push subscriptions — one row per registered browser (FR-15 / D10 / spec §5).
 *
 * `endpoint` is the browser's push service URL and is GLOBALLY UNIQUE: the same
 * device/browser yields the same endpoint, so re-registration upserts on it. An
 * endpoint that re-registers under a DIFFERENT subscriber is reassigned (last
 * write wins — the browser belongs to whoever holds the token and the device).
 *
 * `p256dh` and `auth` are delivery credentials — treat exactly like email: NEVER
 * log the endpoint or the keys (log opaque ids + counts only, constitution/AC-8).
 * The FK cascades on subscriber delete (unsubscribe removes a subscriber's push
 * rows). The notifier deletes a row when the push service reports 404/410 (gone).
 *
 * Indexes:
 *   - push_subscriptions_endpoint_uq: enforces global endpoint uniqueness and
 *     backs the upsert-by-endpoint and delete-by-endpoint (410 cleanup) paths.
 *   - push_subscriptions_subscriber_idx: backs listPushSubscriptions(subscriberId),
 *     the fan-out lookup that gathers a subscriber's browsers to push an Alert to.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriberId: text('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // Browser push service URL — globally unique. Delivery credential: never log.
    endpoint: text('endpoint').notNull(),
    // Push encryption keys — delivery credentials: never log.
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('push_subscriptions_endpoint_uq').on(t.endpoint),
    check(
      'push_subscriptions_https_endpoint',
      sql`char_length(${t.endpoint}) <= 2048 and ${t.endpoint} ~ '^https://[^[:space:]]+$'`,
    ),
    check(
      'push_subscriptions_keys_bounded',
      sql`char_length(${t.p256dh}) between 1 and 512 and char_length(${t.auth}) between 1 and 512`,
    ),
    // Per-subscriber lookup for push fan-out (notifier gathers a subscriber's browsers)
    index('push_subscriptions_subscriber_idx').on(t.subscriberId),
  ],
);

/**
 * Compatibility alert delivery ledger (FR-4 / spec v0.3.3 §5).
 *
 * A worker inserts one pending row before attempting a subscriber alert and
 * stamps `sent_at` only after the transport reports success. The composite
 * primary key is the durable idempotency key for one subscriber and one class
 * opening; process-local notifier state is only an optional fast path.
 *
 * Subscriber deletion cascades to its delivery bookkeeping. v0.4 dispatch uses
 * `mail_outbox`; retained terminal rows here are purged after 90 days while the
 * older worker adapter is phased out.
 */
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    subscriberId: text('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    classKey: text('class_key').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    // Original opening payload required to reproduce a retry after class_state changes.
    reason: text('reason', { enum: NOTIFY_REASONS }).notNull(),
    openSeats: integer('open_seats').notNull(),
    // Nullable snapshot: NULL means the opening page published no usable reserved count.
    openReserved: integer('open_reserved'),
    // Exact watch incarnation claimed for this opening. A remove/re-add changes
    // activation_order, making the old pending delivery terminally ineligible.
    watchActivationOrder: bigint('watch_activation_order', { mode: 'bigint' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    providerMessageId: text('provider_message_id'),
    providerAcceptedAt: timestamp('provider_accepted_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'alert_deliveries_subscriber_class_opened_pk',
      columns: [t.subscriberId, t.classKey, t.openedAt],
    }),
    index('alert_deliveries_pending_idx')
      .on(t.nextAttemptAt, t.createdAt)
      .where(sql`${t.sentAt} is null and ${t.cancelledAt} is null and ${t.deadLetteredAt} is null`),
    unique('alert_deliveries_provider_idempotency_uq').on(t.providerIdempotencyKey),
    check(
      'alert_deliveries_class_key_valid',
      sql`${t.classKey} ~ ${sql.raw(`'${DB_CLASS_KEY_PATTERN}'`)}`,
    ),
    check('alert_deliveries_reason_valid', sql`${t.reason} in ('seats-open', 'waitlist-open')`),
    check('alert_deliveries_open_seats_nonnegative', sql`${t.openSeats} >= 0`),
    check(
      'alert_deliveries_open_reserved_subset',
      sql`${t.openReserved} is null
        or (${t.openReserved} >= 0 and ${t.openReserved} <= ${t.openSeats})`,
    ),
    check('alert_deliveries_attempt_count_nonnegative', sql`${t.attemptCount} >= 0`),
    check('alert_deliveries_watch_order_positive', sql`${t.watchActivationOrder} > 0`),
    check(
      'alert_deliveries_one_hour_expiry',
      sql`${t.expiresAt} = ${t.openedAt} + interval '1 hour'`,
    ),
    check(
      'alert_deliveries_terminal_consistent',
      sql`num_nonnulls(${t.sentAt}, ${t.cancelledAt}, ${t.deadLetteredAt}) <= 1
        and (
          (${t.terminalAt} is null and num_nonnulls(${t.sentAt}, ${t.cancelledAt}, ${t.deadLetteredAt}) = 0)
          or
          (${t.terminalAt} is not null and num_nonnulls(${t.sentAt}, ${t.cancelledAt}, ${t.deadLetteredAt}) = 1)
        )`,
    ),
  ],
);

/**
 * Unified durable mail queue (FR-17).
 *
 * Production rows contain only opaque subscriber/class references plus bounded
 * template metadata. Recipient addresses are joined from `subscribers` at claim
 * time; manage/confirm tokens are minted by the dispatcher at send time. An
 * Operator job resolves its address from trusted process configuration.
 *
 * `opened_at` is per-kind: for `alert` it is when the Opening was observed, and
 * for `blind-window` (FR-28) it is when the Section was LAST SUCCESSFULLY READ,
 * i.e. the moment the Blind window opened. Both use it as the logical dedup key
 * (see the two partial unique indexes below).
 *
 * `expires_at` is set for `alert` only. An Opening stops being actionable after
 * an hour, so an undelivered Alert is cancelled. A Blind-window disclosure does
 * NOT expire and is never cancelled on recovery: an Opening may have gone unseen
 * during the window, so the Subscriber's silence was unearned whether or not the
 * window has since cleared. Undeliverable disclosures instead reach the ordinary
 * non-Alert retry horizon and dead-letter to the Operator.
 */
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text('kind', { enum: MAIL_OUTBOX_KINDS }).notNull(),
    subscriberId: text('subscriber_id').references(() => subscribers.id, {
      onDelete: 'cascade',
    }),
    classKey: text('class_key'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    reason: text('reason', { enum: NOTIFY_REASONS }),
    status: text('status', { enum: MAIL_OUTBOX_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimToken: text('claim_token'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    terminalReason: text('terminal_reason', { enum: MAIL_OUTBOX_TERMINAL_REASONS }),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    providerMessageId: text('provider_message_id'),
    providerAcceptedAt: timestamp('provider_accepted_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique('mail_outbox_provider_idempotency_uq').on(t.providerIdempotencyKey),
    uniqueIndex('mail_outbox_alert_logical_uq')
      .on(t.subscriberId, t.classKey, t.openedAt)
      .where(sql`${t.kind} = 'alert'`),
    /**
     * Exactly one Blind-window disclosure per Subscriber per window (FR-28).
     *
     * This index IS the once-per-window discipline — there is no in-memory
     * episode set to lose. For a `blind-window` row `opened_at` is the WINDOW
     * START (the last successful read of the Section), so a restarted worker
     * recomputes the same key from `class_state` and its insert conflicts away
     * instead of emailing a second time. A later successful read advances
     * `class_state.updated_at`, which makes the next window a different key and
     * rearms disclosure without any explicit recovery write.
     */
    uniqueIndex('mail_outbox_blind_window_logical_uq')
      .on(t.subscriberId, t.classKey, t.openedAt)
      .where(sql`${t.kind} = 'blind-window'`),
    index('mail_outbox_claimable_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    index('mail_outbox_processing_lease_idx')
      .on(t.claimedAt)
      .where(sql`${t.status} = 'processing'`),
    index('mail_outbox_subscriber_idx').on(t.subscriberId),
    index('mail_outbox_class_idx').on(t.classKey),
    index('mail_outbox_terminal_idx')
      .on(t.terminalAt)
      .where(sql`${t.terminalAt} is not null`),
    check(
      'mail_outbox_kind_valid',
      sql`${t.kind} in ('alert', 'confirmation', 'manage-link', 'operator', 'blind-window')`,
    ),
    check(
      'mail_outbox_status_valid',
      sql`${t.status} in ('queued', 'processing', 'sent', 'cancelled', 'dead_letter')`,
    ),
    check(
      'mail_outbox_terminal_reason_valid',
      sql`${t.terminalReason} is null or ${t.terminalReason} in (
        'opening-closed',
        'expired',
        'permanent-failure',
        'retry-horizon',
        'subscriber-ineligible',
        'suppressed'
      )`,
    ),
    check(
      'mail_outbox_class_key_valid',
      sql`${t.classKey} is null or ${t.classKey} ~ ${sql.raw(`'${DB_CLASS_KEY_PATTERN}'`)}`,
    ),
    check(
      'mail_outbox_shape_valid',
      sql`(
          ${t.kind} = 'alert'
          and (${t.subscriberId} is not null or ${t.status} = 'dead_letter')
          and ${t.classKey} is not null
          and ${t.openedAt} is not null
          and ${t.reason} is not null
          and ${t.expiresAt} = ${t.openedAt} + interval '1 hour'
        ) or (
          ${t.kind} in ('confirmation', 'manage-link')
          and (${t.subscriberId} is not null or ${t.status} = 'dead_letter')
          and ${t.classKey} is null
          and ${t.openedAt} is null
          and ${t.reason} is null
          and ${t.expiresAt} is null
        ) or (
          ${t.kind} = 'operator'
          and ${t.subscriberId} is null
          and ${t.openedAt} is null
          and ${t.reason} is null
          and ${t.expiresAt} is null
        ) or (
          ${t.kind} = 'blind-window'
          and (${t.subscriberId} is not null or ${t.status} = 'dead_letter')
          and ${t.classKey} is not null
          and ${t.openedAt} is not null
          and ${t.reason} is null
          and ${t.expiresAt} is null
        )`,
    ),
    check(
      'mail_outbox_reason_valid',
      sql`${t.reason} is null or ${t.reason} in ('seats-open', 'waitlist-open')`,
    ),
    check('mail_outbox_attempts_nonnegative', sql`${t.attempts} >= 0`),
    check(
      'mail_outbox_claim_consistent',
      sql`(
          ${t.status} = 'queued'
          and ${t.claimedAt} is null
          and ${t.claimToken} is null
          and ${t.sentAt} is null
          and ${t.terminalAt} is null
          and ${t.terminalReason} is null
        ) or (
          ${t.status} = 'processing'
          and ${t.claimedAt} is not null
          and ${t.claimToken} is not null
          and ${t.sentAt} is null
          and ${t.terminalAt} is null
          and ${t.terminalReason} is null
        ) or (
          ${t.status} = 'sent'
          and ${t.claimedAt} is null
          and ${t.claimToken} is null
          and ${t.sentAt} is not null
          and ${t.terminalAt} is not null
          and ${t.terminalReason} is null
          and ${t.providerAcceptedAt} is not null
        ) or (
          ${t.status} in ('cancelled', 'dead_letter')
          and ${t.claimedAt} is null
          and ${t.claimToken} is null
          and ${t.sentAt} is null
          and ${t.terminalAt} is not null
          and ${t.terminalReason} is not null
        )`,
    ),
    check(
      'mail_outbox_provider_key_bounded',
      sql`char_length(${t.providerIdempotencyKey}) between 1 and 256`,
    ),
    check(
      'mail_outbox_provider_metadata_bounded',
      sql`(${t.providerMessageId} is null or char_length(${t.providerMessageId}) <= 512)
        and (${t.lastErrorCode} is null or char_length(${t.lastErrorCode}) <= 128)`,
    ),
    check(
      'mail_outbox_payload_bounded',
      sql`jsonb_typeof(${t.payload}) = 'object' and pg_column_size(${t.payload}) <= 8192`,
    ),
    check('mail_outbox_updated_after_creation', sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Durable Operator lifecycle for one terminal mail failure (FR-22).
 *
 * One incident is opened in the same transaction as the first dead-letter
 * transition. The external incident publisher uses `dead-letter/<id>` as its
 * stable idempotency key and stamps `surfaced_at` only after acceptance. It
 * never creates another mail job, including when the failed job was itself an
 * Operator message.
 */
export const deadLetterIncidents = pgTable(
  'dead_letter_incidents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    mailJobId: text('mail_job_id')
      .notNull()
      .unique()
      .references(() => mailOutbox.id, { onDelete: 'cascade' }),
    state: text('state', { enum: DEAD_LETTER_INCIDENT_STATES }).notNull().default('unresolved'),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('dead_letter_incidents_unresolved_idx')
      .on(t.openedAt)
      .where(sql`${t.state} = 'unresolved'`),
    index('dead_letter_incidents_unsurfaced_idx')
      .on(t.openedAt)
      .where(sql`${t.surfacedAt} is null`),
    check(
      'dead_letter_incidents_state_valid',
      sql`${t.state} in ('unresolved', 'acknowledged', 'resolved')`,
    ),
    check(
      'dead_letter_incidents_state_consistent',
      sql`(
          ${t.state} = 'unresolved'
          and ${t.acknowledgedAt} is null
          and ${t.resolvedAt} is null
        ) or (
          ${t.state} = 'acknowledged'
          and ${t.acknowledgedAt} is not null
          and ${t.resolvedAt} is null
        ) or (
          ${t.state} = 'resolved'
          and ${t.resolvedAt} is not null
        )`,
    ),
    check(
      'dead_letter_incidents_timestamps_ordered',
      sql`(${t.surfacedAt} is null or ${t.surfacedAt} >= ${t.openedAt})
        and (${t.acknowledgedAt} is null or ${t.acknowledgedAt} >= ${t.openedAt})
        and (${t.resolvedAt} is null or ${t.resolvedAt} >= ${t.openedAt})
        and (
          ${t.acknowledgedAt} is null
          or ${t.resolvedAt} is null
          or ${t.resolvedAt} >= ${t.acknowledgedAt}
        )`,
    ),
  ],
);

// Drizzle inferred types — used by the repo layer
export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type ClassStateRow = typeof classState.$inferSelect;
export type NewClassStateRow = typeof classState.$inferInsert;
export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
export type MailOutboxRow = typeof mailOutbox.$inferSelect;
export type NewMailOutboxRow = typeof mailOutbox.$inferInsert;
export type ParserHealth = typeof parserHealth.$inferSelect;
export type NewParserHealth = typeof parserHealth.$inferInsert;
export type DeadLetterIncident = typeof deadLetterIncidents.$inferSelect;
export type NewDeadLetterIncident = typeof deadLetterIncidents.$inferInsert;
