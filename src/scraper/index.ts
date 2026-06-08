/**
 * Public surface of the scraper lane. The worker imports ONLY from here; it
 * does not reach into parse.ts or fetch.ts directly.
 *
 * Lane: src/scraper/** — owned by scraper-engineer. Read-only to all others.
 * The contract types (ClassKey, ParseResult, SeatState, ParserBroke) come from
 * src/shared/** (read-only to us too).
 */

export { fetchClass, FetchError } from './fetch';
export type { FetchOptions, FetchImpl } from './fetch';
export { parseClassPage } from './parse';
