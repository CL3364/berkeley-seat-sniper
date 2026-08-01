/**
 * Public surface of the scraper lane. The worker imports ONLY from here; it
 * does not reach into parse.ts or fetch.ts directly.
 *
 * Lane: src/scraper/** — owned by scraper-engineer. Read-only to all others.
 * The contract types (ClassKey, ParseResult, SeatState, ParserBroke) come from
 * src/shared/** (read-only to us too).
 */

export {
  fetchClass,
  fetchClassObservation,
  createPublicClassPageSource,
  FetchError,
  isSourceFetchingEnabled,
  beginScrapeCycle,
  endScrapeCycle,
  __clearRobotsCacheForTests,
} from './fetch';
export type {
  AvailabilityObservation,
  AvailabilitySource,
  AvailabilitySourceRequest,
  FetchErrorKind,
  FetchOptions,
  FetchImpl,
  OriginPermitContext,
  OriginRequestStart,
  OriginRequestKind,
  RunWithOriginPermit,
  SourceCacheMetadata,
  SourceValidators,
} from './fetch';
export { parseClassPage, isNotFoundPage } from './parse';
export type { ParseClassPageOptions, ScraperTelemetryEvent } from './parse';
