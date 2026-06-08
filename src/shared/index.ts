/**
 * Barrel for the Berkeley Seat Sniper API contract — the single source of truth
 * all teammates implement against (constitution / spec §4). Read-only to every
 * role except the architect. Framework-agnostic: only `zod` is imported here.
 *
 * Modules:
 *  - `class-key`  ClassKey brand, canonical form, normalizeClassKey, schemas.
 *  - `seat-state` SeatState/SeatStatus, ParseResult union, NotifyEvent, Subscriber.
 *  - `errors`     ApiError code union + envelope + helpers.
 *  - `api`        per-endpoint request/param/response schemas + route table.
 */
export * from './class-key';
export * from './seat-state';
export * from './errors';
export * from './api';
