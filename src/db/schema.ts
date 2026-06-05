import { boolean, index, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { SEAT_STATUSES } from '../shared/seat-state';

/**
 * Subscribers — one row per email address. `id` is the opaque `subscriberId`
 * exposed in API responses. `email` is PII: never log it (constitution / AC-8).
 * The manage token is derived from `id` at runtime and is never stored here.
 */
export const subscribers = pgTable('subscribers', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // PII — never log; unique index created implicitly by .unique()
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Watches — one row per (subscriber, class) pair. `class_key` stores the
 * canonical ClassKey string (validated with ClassKeySchema before insert).
 *
 * Indexes:
 *   - watches_class_key_idx: filters by class_key for worker fan-out
 *     (getSubscribersWatching + getDistinctWatchedClassKeys — hot path, FR-3).
 *   - watches_subscriber_class_uq: enforces the uniqueness constraint and
 *     doubles as an index on (subscriber_id, class_key) for listWatches.
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('watches_subscriber_class_uq').on(t.subscriberId, t.classKey),
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
export const classState = pgTable('class_state', {
  // Canonical ClassKey — primary key, so getClassState and upsertClassState
  // are O(1) by PK lookup and INSERT … ON CONFLICT DO UPDATE.
  classKey: text('class_key').primaryKey(),
  // SeatStatus enum: 'open' | 'waitlist' | 'closed' — from src/shared
  lastStatus: text('last_status', { enum: SEAT_STATUSES }).notNull(),
  lastOpenSeats: integer('last_open_seats').notNull(),
  lastWaitlistOpen: boolean('last_waitlist_open').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Drizzle inferred types — used by the repo layer
export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type ClassStateRow = typeof classState.$inferSelect;
export type NewClassStateRow = typeof classState.$inferInsert;
