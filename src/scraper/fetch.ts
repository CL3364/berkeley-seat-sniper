/**
 * Cache-aware, policy-constrained access to Berkeley's public class pages.
 *
 * Security and conduct invariants:
 * - class URLs are built only from a validated ClassKey;
 * - redirects are followed manually, at most three times, and only when the
 *   destination remains on the exact HTTPS classes.berkeley.edu origin;
 * - page-provided links are never fetched;
 * - every physical origin attempt starts synchronously inside one global
 *   permit wrapper, with permit wait + redirects sharing the same deadline;
 * - requests carry an identifying User-Agent, bounded time/body budgets, and no
 *   cache-busting query;
 * - robots.txt is checked once per poll cycle and fails closed on transient
 *   inability to read policy;
 * - cache validators and freshness metadata are surfaced to the worker.
 */

import { isNotFoundPage, parseClassPage } from './parse';
import type { ParseClassPageOptions, ScraperTelemetryEvent } from './parse';
import type { ClassKey } from '../shared/class-key';
import type { ParseResult } from '../shared/seat-state';

const BERKELEY_ORIGIN = 'https://classes.berkeley.edu';
const BERKELEY_CLASS_BASE = `${BERKELEY_ORIGIN}/content/`;
const ROBOTS_TXT_URL = `${BERKELEY_ORIGIN}/robots.txt`;
const MAX_REDIRECTS = 3;
const MAX_HEADER_VALUE_LENGTH = 2048;
const ROBOTS_MAX_BODY_BYTES = 512_000;
const ROBOTS_MAX_RULES = 1024;
const ROBOTS_MAX_PATTERN_LENGTH = 2048;
const MAX_CACHE_FRESHNESS_SECONDS = 31_536_000;

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type OriginRequestKind = 'robots' | 'class';

/**
 * Minimal context for the global origin-rate gate. It deliberately carries no
 * URL, ClassKey, response data, or subscriber information.
 */
export interface OriginPermitContext {
  readonly kind: OriginRequestKind;
  /** Aborts when the scraper's one absolute request deadline expires. */
  readonly signal: AbortSignal;
}

/**
 * A physical request promise nested so an async permit wrapper can return it
 * without Promise resolution adopting (and therefore awaiting) the request.
 */
export interface OriginRequestStart<T> {
  readonly started: Promise<T>;
}

/**
 * Owns the synchronous invocation boundary for each physical fetch attempt,
 * including redirects. The wrapper must invoke `start` exactly once and return
 * that exact result. Rejection before invocation makes no request; rejection
 * afterward aborts the request and is still surfaced as a transient failure.
 */
export type RunWithOriginPermit = <T>(
  context: OriginPermitContext,
  start: () => OriginRequestStart<T>,
) => Promise<OriginRequestStart<T>>;

/** Conditional validators persisted by the cache-aware worker. */
export interface SourceValidators {
  etag?: string;
  lastModified?: string;
}

/**
 * Response cache facts used by deadline-driven scheduling.
 *
 * `freshUntil` is the source representation's HTTP freshness deadline at the
 * moment we observed this response: checkedAt + max(0, max-age - Age). A 304
 * refreshes checkedAt and carries forward prior cache directives when the
 * validating response omits them.
 */
export interface SourceCacheMetadata {
  checkedAt: string;
  cacheControl: string | null;
  ageSeconds: number;
  maxAgeSeconds: number | null;
  freshForSeconds: number;
  freshUntil: string;
  etag: string | null;
  lastModified: string | null;
}

export interface AvailabilitySourceRequest {
  validators?: SourceValidators;
  /** Prior metadata lets a sparse 304 response refresh a complete deadline. */
  previousCache?: SourceCacheMetadata;
  /**
   * Optional global origin-rate wrapper. The scraper delegates every actual
   * request start to it, so robots and redirect traffic cannot bypass the
   * physical-start ceiling.
   */
  runWithOriginPermit?: RunWithOriginPermit;
}

/**
 * Rich source result. A 304 is deliberately distinct from a SeatState: the
 * worker refreshes scheduling metadata without mutating class_state.
 */
export type AvailabilityObservation =
  | {
      kind: 'result';
      result: ParseResult;
      /** Null only when no class-page response occurred (kill-switch/robots skip). */
      cache: SourceCacheMetadata | null;
    }
  | {
      kind: 'not-modified';
      classKey: ClassKey;
      checkedAt: string;
      cache: SourceCacheMetadata;
    };

export interface AvailabilitySource {
  fetch(classKey: ClassKey, request?: AvailabilitySourceRequest): Promise<AvailabilityObservation>;
  beginCycle(): void;
  endCycle(): void;
}

export interface FetchOptions extends AvailabilitySourceRequest {
  fetchImpl?: FetchImpl;
  /**
   * Production defaults to throwing typed failures for scheduler handling.
   * `return-broke` is retained only for legacy tests/adapters.
   */
  onNetworkError?: 'return-broke' | 'throw';
  /** Optional operator-safe parser metrics adapter. */
  onTelemetry?: ParseClassPageOptions['onTelemetry'];
}

/**
 * Source access is opt-in: only the exact documented enable value permits an
 * outbound request. Missing, empty, or malformed values fail closed.
 */
export function isSourceFetchingEnabled(): boolean {
  return process.env.KILL_SWITCH === '0';
}

/**
 * Fixed source-failure classification consumed by the worker.
 *
 * Only `transient` is eligible for ordinary scheduler backoff. The other
 * classifications are source-safety-stop triggers that require Operator
 * review before class-page fetching resumes.
 */
export type FetchErrorKind =
  | 'transient'
  | 'robots-disallow'
  | 'source-forbidden'
  | 'source-rate-limited';

/** Typed fetch failure consumed by worker backoff and source-safety handling. */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly status: number;
  readonly detail: string;
  /** Retry delay from Retry-After, in milliseconds, when the source supplied it. */
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    detail: string,
    retryAfterMs: number | null = null,
    kind: FetchErrorKind = fetchErrorKindForStatus(status),
  ) {
    super(`FetchError(${status}): ${detail}`);
    this.name = 'FetchError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

function fetchErrorKindForStatus(status: number): FetchErrorKind {
  if (status === 401 || status === 403) return 'source-forbidden';
  if (status === 429) return 'source-rate-limited';
  return 'transient';
}

/**
 * Backward-compatible ParseResult API. New cache-aware scheduling should use
 * fetchClassObservation or createPublicClassPageSource instead.
 */
export async function fetchClass(
  classKey: ClassKey,
  options: FetchOptions = {},
): Promise<ParseResult> {
  try {
    const observation = await fetchClassObservation(classKey, options);
    if (observation.kind === 'not-modified') {
      throw new FetchError(304, 'not-modified response requires the cache-aware observation API');
    }
    return observation.result;
  } catch (error) {
    if (error instanceof FetchError && options.onNetworkError === 'return-broke') {
      return {
        kind: 'parser-broke',
        classKey,
        detail: sanitizeDetail(error.detail),
      };
    }
    throw error;
  }
}

/** Fetch one class and retain response cache metadata for the scheduler. */
export async function fetchClassObservation(
  classKey: ClassKey,
  options: FetchOptions = {},
): Promise<AvailabilityObservation> {
  const { fetchImpl = fetch, onNetworkError = 'throw' } = options;

  if (!isSourceFetchingEnabled()) {
    return {
      kind: 'result',
      result: {
        kind: 'parser-broke',
        classKey,
        detail: 'kill-switch active: outbound fetch suppressed',
      },
      cache: null,
    };
  }

  const targetUrl = `${BERKELEY_CLASS_BASE}${classKey}`;
  if (process.env.RESPECT_ROBOTS !== '0') {
    const robotsDecision = await checkRobots(targetUrl, fetchImpl, options.runWithOriginPermit);
    if (!robotsDecision.allowed) {
      const detail = `robots.txt: ${robotsDecision.reason}`;
      if (onNetworkError === 'throw') {
        throw new FetchError(
          robotsDecision.status,
          detail,
          robotsDecision.retryAfterMs,
          robotsDecision.kind,
        );
      }
      return {
        kind: 'result',
        result: { kind: 'parser-broke', classKey, detail },
        cache: null,
      };
    }
  }

  let fetched: ClassFetchResult;
  try {
    fetched = await doClassFetch(targetUrl, classKey, fetchImpl, options);
  } catch (error) {
    if (error instanceof FetchError) {
      if (onNetworkError === 'throw') throw error;
      return {
        kind: 'result',
        result: {
          kind: 'parser-broke',
          classKey,
          detail: sanitizeDetail(error.detail),
        },
        cache: null,
      };
    }

    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unexpected class-page fetch error';
    const wrapped = new FetchError(0, detail);
    if (onNetworkError === 'throw') throw wrapped;
    return {
      kind: 'result',
      result: { kind: 'parser-broke', classKey, detail },
      cache: null,
    };
  }

  if (fetched.kind === 'not-modified') {
    return {
      kind: 'not-modified',
      classKey,
      checkedAt: fetched.cache.checkedAt,
      cache: fetched.cache,
    };
  }

  if (fetched.kind === 'gone') {
    return {
      kind: 'result',
      result: { kind: 'class-gone', classKey, detail: `404 for ${classKey}` },
      cache: fetched.cache,
    };
  }

  if (isNotFoundPage(fetched.html)) {
    return {
      kind: 'result',
      result: { kind: 'class-gone', classKey, detail: 'not-found page (200)' },
      cache: fetched.cache,
    };
  }

  return {
    kind: 'result',
    result: parseClassPage(fetched.html, classKey, {
      fetchedAt: fetched.cache.checkedAt,
      onTelemetry: options.onTelemetry,
    }),
    cache: fetched.cache,
  };
}

/**
 * Build the worker-facing source adapter while keeping fetch injection inside
 * the scraper lane.
 */
export function createPublicClassPageSource(
  options: Pick<
    FetchOptions,
    'fetchImpl' | 'onNetworkError' | 'onTelemetry' | 'runWithOriginPermit'
  > = {},
): AvailabilitySource {
  return {
    fetch(classKey, request = {}) {
      return fetchClassObservation(classKey, { ...options, ...request });
    },
    beginCycle: beginScrapeCycle,
    endCycle: endScrapeCycle,
  };
}

type ClassFetchResult =
  | { kind: 'html'; html: string; cache: SourceCacheMetadata }
  | { kind: 'gone'; cache: SourceCacheMetadata }
  | { kind: 'not-modified'; cache: SourceCacheMetadata };

async function doClassFetch(
  url: string,
  classKey: ClassKey,
  fetchImpl: FetchImpl,
  options: AvailabilitySourceRequest,
): Promise<ClassFetchResult> {
  const timeoutMs = parseTimeoutMs(process.env.FETCH_TIMEOUT_MS, 10_000);
  const request = createDeadline(timeoutMs, `class page ${classKey}`);

  try {
    const headers: Record<string, string> = {
      'User-Agent': resolveUserAgent(),
      Accept: 'text/html,application/xhtml+xml',
    };
    const validators = resolveValidators(options);
    if (validators.etag !== undefined) headers['If-None-Match'] = validators.etag;
    if (validators.lastModified !== undefined) {
      headers['If-Modified-Since'] = validators.lastModified;
    }

    const response = await requestWithSafeRedirects(
      url,
      headers,
      fetchImpl,
      request,
      `class page ${classKey}`,
      'class',
      options.runWithOriginPermit,
    );
    const checkedAtMs = Date.now();
    const cache = cacheMetadataFromResponse(response, checkedAtMs, options.previousCache);

    if (response.status === 304) {
      await cancelResponseBody(response, request.deadline, 'class page 304 response not consumed');
      return { kind: 'not-modified', cache };
    }

    if (response.status === 404) {
      await cancelResponseBody(response, request.deadline, 'class page 404 response not consumed');
      return { kind: 'gone', cache };
    }

    if (response.status !== 200) {
      const retryAfterMs =
        response.status === 429
          ? parseRetryAfter(responseHeader(response, 'retry-after'), checkedAtMs)
          : null;
      await cancelResponseBody(
        response,
        request.deadline,
        'class page non-200 response not consumed',
      );
      throw new FetchError(
        response.status,
        `non-200 response (${response.status}) for ${classKey}`,
        retryAfterMs,
      );
    }

    const html = await readBoundedBody(
      response,
      request.deadline,
      `class page ${classKey}`,
      configuredBodyLimit(),
    );
    return { kind: 'html', html, cache };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw request.toFetchError(error);
  } finally {
    request.dispose();
  }
}

interface RequestDeadline {
  controller: AbortController;
  deadline: Promise<never>;
  didTimeout(): boolean;
  toFetchError(error: unknown): FetchError;
  dispose(): void;
}

function createDeadline(timeoutMs: number, label: string): RequestDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new FetchError(0, `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return {
    controller,
    deadline,
    didTimeout: () => timedOut,
    toFetchError(error) {
      if (error instanceof FetchError) return error;
      const aborted = timedOut || (error instanceof Error && error.name === 'AbortError');
      return new FetchError(
        0,
        aborted
          ? `${label} timed out after ${timeoutMs}ms`
          : `${label} network error: ${sanitizeDetail(
              error instanceof Error ? error.message : String(error),
            )}`,
      );
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Use redirect:manual so the runtime never makes a request to an unvalidated
 * Location. The same absolute deadline covers all hops and body consumption.
 */
async function requestWithSafeRedirects(
  initialUrl: string,
  headers: Record<string, string>,
  fetchImpl: FetchImpl,
  request: RequestDeadline,
  label: string,
  kind: OriginRequestKind,
  runWithOriginPermit: RunWithOriginPermit | undefined,
): Promise<Response> {
  let currentUrl = new URL(initialUrl);
  assertAllowedSourceUrl(currentUrl);

  for (let redirects = 0; ; redirects += 1) {
    const response = await runOriginRequest(runWithOriginPermit, kind, request, () =>
      fetchImpl(currentUrl.toString(), {
        method: 'GET',
        headers,
        signal: request.controller.signal,
        redirect: 'manual',
      }),
    );

    if (!isRedirectStatus(response.status)) return response;

    if (redirects >= MAX_REDIRECTS) {
      await cancelResponseBody(
        response,
        request.deadline,
        `${label} redirect limit response not consumed`,
      );
      throw new FetchError(0, `${label} exceeded ${MAX_REDIRECTS} redirects`);
    }

    const location = responseHeader(response, 'location');
    if (!location || location.length > MAX_HEADER_VALUE_LENGTH) {
      await cancelResponseBody(
        response,
        request.deadline,
        `${label} invalid redirect response not consumed`,
      );
      throw new FetchError(0, `${label} returned a redirect without a valid Location`);
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
      assertAllowedSourceUrl(nextUrl);
    } catch {
      await cancelResponseBody(
        response,
        request.deadline,
        `${label} rejected redirect response not consumed`,
      );
      throw new FetchError(0, `${label} redirect target was rejected`);
    }

    await cancelResponseBody(response, request.deadline, `${label} redirect response not consumed`);
    currentUrl = nextUrl;
  }
}

async function runOriginRequest<T>(
  runWithOriginPermit: RunWithOriginPermit | undefined,
  kind: OriginRequestKind,
  request: RequestDeadline,
  startRequest: () => Promise<T>,
): Promise<T> {
  if (!runWithOriginPermit) {
    return Promise.race([startRequest(), request.deadline]);
  }

  let startCalls = 0;
  let startedByCallback: OriginRequestStart<T> | undefined;
  const start = (): OriginRequestStart<T> => {
    startCalls += 1;
    if (startCalls !== 1) {
      throw new FetchError(0, `${kind} origin permit invoked request start more than once`);
    }
    if (request.controller.signal.aborted) {
      throw request.toFetchError(new DOMException('aborted', 'AbortError'));
    }

    let started: Promise<T>;
    try {
      started = startRequest();
    } catch (error) {
      started = Promise.reject(error);
    }
    // A wrapper can still fail after starting (for example while reconciling
    // durable state). Attach a handler immediately so aborting that path cannot
    // leave a rejected physical request promise unobserved.
    void started.catch(() => undefined);
    startedByCallback = { started };
    return startedByCallback;
  };

  let returnedStart: OriginRequestStart<T>;
  try {
    returnedStart = await Promise.race([
      Promise.resolve().then(() =>
        runWithOriginPermit(
          {
            kind,
            signal: request.controller.signal,
          },
          start,
        ),
      ),
      request.deadline,
    ]);
  } catch (error) {
    if (startedByCallback !== undefined) {
      request.controller.abort();
    }
    if (error instanceof FetchError) throw error;
    if (request.didTimeout()) throw request.toFetchError(error);
    throw new FetchError(0, `${kind} origin permit acquisition failed`);
  }

  if (startCalls !== 1 || startedByCallback === undefined || returnedStart !== startedByCallback) {
    request.controller.abort();
    throw new FetchError(0, `${kind} origin permit did not return its request start`);
  }

  if (request.controller.signal.aborted) {
    throw request.toFetchError(new DOMException('aborted', 'AbortError'));
  }

  return Promise.race([returnedStart.started, request.deadline]);
}

function assertAllowedSourceUrl(url: URL): void {
  if (
    url.origin !== BERKELEY_ORIGIN ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('source URL is outside the approved origin');
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ---------------------------------------------------------------------------
// robots.txt: one cache entry per worker cycle, RFC 9309 matching
// ---------------------------------------------------------------------------

interface RobotsRule {
  directive: 'allow' | 'disallow';
  pattern: string;
}

interface RobotsCacheEntry {
  rules: RobotsRule[];
  skipReason: string | null;
  errorKind: FetchErrorKind;
  status: number;
  retryAfterMs: number | null;
  fetchedAtMs: number;
}

type RobotsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      kind: FetchErrorKind;
      status: number;
      retryAfterMs: number | null;
    };

let robotsCache: RobotsCacheEntry | null = null;
let robotsCachePromise: Promise<RobotsCacheEntry> | null = null;
let robotsCyclePinned = false;

export function beginScrapeCycle(): void {
  robotsCache = null;
  robotsCachePromise = null;
  robotsCyclePinned = true;
}

export function endScrapeCycle(): void {
  robotsCyclePinned = false;
}

export function __clearRobotsCacheForTests(): void {
  robotsCache = null;
  robotsCachePromise = null;
  robotsCyclePinned = false;
}

async function checkRobots(
  targetUrl: string,
  fetchImpl: FetchImpl,
  runWithOriginPermit: RunWithOriginPermit | undefined,
): Promise<RobotsDecision> {
  const targetPath = new URL(targetUrl).pathname;
  const entry = await getRobotsEntry(fetchImpl, runWithOriginPermit);
  if (entry.skipReason !== null) {
    return {
      allowed: false,
      reason: entry.skipReason,
      kind: entry.errorKind,
      status: entry.status,
      retryAfterMs: entry.retryAfterMs,
    };
  }

  const matching = entry.rules.filter((rule) => robotsPatternMatches(rule.pattern, targetPath));
  if (matching.length === 0) return { allowed: true };

  matching.sort((left, right) => {
    const lengthDifference =
      robotsPatternSpecificity(right.pattern) - robotsPatternSpecificity(left.pattern);
    if (lengthDifference !== 0) return lengthDifference;
    if (left.directive === right.directive) return 0;
    return left.directive === 'allow' ? -1 : 1;
  });

  const winner = matching[0];
  return winner.directive === 'allow'
    ? { allowed: true }
    : {
        allowed: false,
        reason: `path matches Disallow: ${sanitizeDetail(winner.pattern)}`,
        kind: 'robots-disallow',
        status: 0,
        retryAfterMs: null,
      };
}

async function getRobotsEntry(
  fetchImpl: FetchImpl,
  runWithOriginPermit: RunWithOriginPermit | undefined,
): Promise<RobotsCacheEntry> {
  const now = Date.now();
  if (
    robotsCache !== null &&
    (robotsCyclePinned || now - robotsCache.fetchedAtMs < robotsCacheTtlMs())
  ) {
    return robotsCache;
  }
  if (robotsCachePromise !== null) return robotsCachePromise;

  robotsCachePromise = fetchRobotsEntry(fetchImpl, now, runWithOriginPermit);
  try {
    robotsCache = await robotsCachePromise;
    return robotsCache;
  } finally {
    robotsCachePromise = null;
  }
}

async function fetchRobotsEntry(
  fetchImpl: FetchImpl,
  startedAtMs: number,
  runWithOriginPermit: RunWithOriginPermit | undefined,
): Promise<RobotsCacheEntry> {
  const timeoutMs = parseTimeoutMs(process.env.FETCH_TIMEOUT_MS, 10_000);
  const request = createDeadline(timeoutMs, 'robots.txt');

  try {
    const response = await requestWithSafeRedirects(
      ROBOTS_TXT_URL,
      {
        'User-Agent': resolveUserAgent(),
        Accept: 'text/plain',
      },
      fetchImpl,
      request,
      'robots.txt',
      'robots',
      runWithOriginPermit,
    );

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(responseHeader(response, 'retry-after'), Date.now());
      await cancelResponseBody(response, request.deadline, 'robots.txt 429 response not consumed');
      return {
        rules: [],
        skipReason: 'rate limited (429) — skipping fetch this cycle',
        errorKind: 'source-rate-limited',
        status: 429,
        retryAfterMs,
        fetchedAtMs: startedAtMs,
      };
    }

    if (response.status === 401 || response.status === 403) {
      await cancelResponseBody(
        response,
        request.deadline,
        'robots.txt access-denied response not consumed',
      );
      return {
        rules: [],
        skipReason: `access denied (${response.status}) — source safety stop required`,
        errorKind: 'source-forbidden',
        status: response.status,
        retryAfterMs: null,
        fetchedAtMs: startedAtMs,
      };
    }

    // RFC 9309: remaining unavailable 4xx responses mean no rules apply.
    if (response.status >= 400 && response.status < 500) {
      await cancelResponseBody(response, request.deadline, 'robots.txt 4xx response not consumed');
      return allowedRobotsEntry(startedAtMs);
    }

    if (response.status >= 500) {
      await cancelResponseBody(response, request.deadline, 'robots.txt 5xx response not consumed');
      return skippedRobotsEntry(
        `server error (${response.status}) — skipping fetch this cycle`,
        startedAtMs,
        response.status,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(
        response,
        request.deadline,
        'robots.txt unexpected response not consumed',
      );
      return skippedRobotsEntry(
        `unexpected response (${response.status}) — skipping fetch this cycle`,
        startedAtMs,
        response.status,
      );
    }

    const content = await readBoundedBody(
      response,
      request.deadline,
      'robots.txt',
      Math.min(configuredBodyLimit(), ROBOTS_MAX_BODY_BYTES),
    );
    const parsed = parseRobotsTxt(content, resolveRobotsProductToken());
    if (parsed.safetyLimitExceeded) {
      return skippedRobotsEntry(
        'policy exceeds parser safety bounds — skipping fetch this cycle',
        startedAtMs,
      );
    }
    return {
      rules: parsed.rules,
      skipReason: null,
      errorKind: 'transient',
      status: 0,
      retryAfterMs: null,
      fetchedAtMs: startedAtMs,
    };
  } catch (error) {
    const fetchError = error instanceof FetchError ? error : request.toFetchError(error);
    return skippedRobotsEntry(
      request.didTimeout()
        ? `request timed out after ${timeoutMs}ms — skipping fetch this cycle`
        : `${sanitizeDetail(fetchError.detail)} — skipping fetch this cycle`,
      startedAtMs,
      fetchError.status,
      fetchError.retryAfterMs,
      fetchError.kind,
    );
  } finally {
    request.dispose();
  }
}

function allowedRobotsEntry(fetchedAtMs: number): RobotsCacheEntry {
  return {
    rules: [],
    skipReason: null,
    errorKind: 'transient',
    status: 0,
    retryAfterMs: null,
    fetchedAtMs,
  };
}

function skippedRobotsEntry(
  reason: string,
  fetchedAtMs: number,
  status = 0,
  retryAfterMs: number | null = null,
  errorKind: FetchErrorKind = fetchErrorKindForStatus(status),
): RobotsCacheEntry {
  return {
    rules: [],
    skipReason: reason,
    errorKind,
    status,
    retryAfterMs,
    fetchedAtMs,
  };
}

function robotsCacheTtlMs(): number {
  const explicit = parsePositiveInteger(process.env.ROBOTS_CACHE_TTL_MS);
  if (explicit !== null) return explicit;
  const pollSeconds = parsePositiveInteger(process.env.POLL_INTERVAL_SECONDS) ?? 30;
  return pollSeconds * 1000;
}

function parseRobotsTxt(
  content: string,
  agentName: string,
): { rules: RobotsRule[]; safetyLimitExceeded: boolean } {
  interface Group {
    agents: string[];
    rules: RobotsRule[];
    rulesStarted: boolean;
  }

  const groups: Group[] = [];
  let group: Group | null = null;
  let ruleCount = 0;
  let safetyLimitExceeded = false;

  for (const rawLine of content.split('\n')) {
    const line = stripRobotsComment(rawLine).trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      if (group === null || group.rulesStarted) {
        group = { agents: [], rules: [], rulesStarted: false };
        groups.push(group);
      }
      if (value !== '' && value.length <= 256) {
        group.agents.push(value.toLowerCase());
      }
      continue;
    }

    if (key !== 'allow' && key !== 'disallow') continue;
    if (group === null) continue;
    group.rulesStarted = true;
    if (value === '' || value.length > ROBOTS_MAX_PATTERN_LENGTH || ruleCount >= ROBOTS_MAX_RULES) {
      if (value !== '') safetyLimitExceeded = true;
      continue;
    }
    group.rules.push({ directive: key, pattern: value });
    ruleCount += 1;
  }

  const specific = groups.filter((candidate) => candidate.agents.includes(agentName));
  const selected =
    specific.length > 0 ? specific : groups.filter((candidate) => candidate.agents.includes('*'));
  return {
    rules: selected.flatMap((candidate) => candidate.rules),
    safetyLimitExceeded,
  };
}

function stripRobotsComment(line: string): string {
  const commentStart = line.indexOf('#');
  return commentStart < 0 ? line : line.slice(0, commentStart);
}

/**
 * RFC 9309 `*` and terminal `$` matching without constructing a RegExp from
 * untrusted policy. Adding an implicit trailing `*` implements prefix semantics
 * for rules without `$`; the classic glob matcher then runs with bounded input.
 */
function robotsPatternMatches(pattern: string, path: string): boolean {
  const normalizedPattern = normalizeRobotsOctets(pattern);
  const normalizedPath = normalizeRobotsOctets(path);
  const endAnchored = normalizedPattern.endsWith('$');
  const body = endAnchored ? normalizedPattern.slice(0, -1) : `${normalizedPattern}*`;

  let patternIndex = 0;
  let pathIndex = 0;
  let latestStar = -1;
  let latestStarMatch = 0;

  while (pathIndex < normalizedPath.length) {
    if (
      patternIndex < body.length &&
      body[patternIndex] !== '*' &&
      body[patternIndex] === normalizedPath[pathIndex]
    ) {
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }

    if (patternIndex < body.length && body[patternIndex] === '*') {
      latestStar = patternIndex;
      latestStarMatch = pathIndex;
      patternIndex += 1;
      continue;
    }

    if (latestStar >= 0) {
      patternIndex = latestStar + 1;
      latestStarMatch += 1;
      pathIndex = latestStarMatch;
      continue;
    }

    return false;
  }

  while (patternIndex < body.length && body[patternIndex] === '*') {
    patternIndex += 1;
  }
  return patternIndex === body.length;
}

function robotsPatternSpecificity(pattern: string): number {
  const normalized = normalizeRobotsOctets(pattern);
  let specificity = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === '*') continue;
    if (normalized[index] === '$' && index === normalized.length - 1) continue;
    if (normalized[index] === '%' && /^[0-9A-F]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      specificity += 1;
      index += 2;
      continue;
    }
    specificity += 1;
  }
  return specificity;
}

function normalizeRobotsOctets(value: string): string {
  let ascii = '';
  const encoder = new TextEncoder();
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      ascii += character;
      continue;
    }
    for (const byte of encoder.encode(character)) {
      ascii += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }

  return ascii.replace(/%[0-9a-fA-F]{2}/g, (encoded) => {
    const decoded = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9._~-]/.test(decoded) ? decoded : encoded.toUpperCase();
  });
}

// ---------------------------------------------------------------------------
// Cache metadata, bounded bodies, and small parsing helpers
// ---------------------------------------------------------------------------

function resolveValidators(
  options: AvailabilitySourceRequest,
): Required<SourceValidators> | SourceValidators {
  const etag = safeRequestHeader(
    options.validators?.etag ?? options.previousCache?.etag ?? undefined,
  );
  const lastModified = safeRequestHeader(
    options.validators?.lastModified ?? options.previousCache?.lastModified ?? undefined,
  );
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

function cacheMetadataFromResponse(
  response: Response,
  checkedAtMs: number,
  previous: SourceCacheMetadata | undefined,
): SourceCacheMetadata {
  const responseCacheControl = safeResponseHeader(responseHeader(response, 'cache-control'));
  const cacheControl = responseCacheControl ?? previous?.cacheControl ?? null;
  const directives = parseCacheControl(cacheControl);
  const priorMaxAge = previous?.maxAgeSeconds ?? null;
  const maxAgeSeconds = directives.maxAgeSeconds ?? (response.status === 304 ? priorMaxAge : null);
  const ageHeader = parseNonnegativeInteger(responseHeader(response, 'age'));
  const ageSeconds = ageHeader ?? 0;
  const freshnessDisabled = directives.noCache || directives.noStore || maxAgeSeconds === null;
  const freshForSeconds = freshnessDisabled
    ? 0
    : Math.min(Math.max(0, maxAgeSeconds - ageSeconds), MAX_CACHE_FRESHNESS_SECONDS);
  const etag =
    safeResponseHeader(responseHeader(response, 'etag')) ??
    (response.status === 304 ? (previous?.etag ?? null) : null);
  const lastModified =
    safeResponseHeader(responseHeader(response, 'last-modified')) ??
    (response.status === 304 ? (previous?.lastModified ?? null) : null);

  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    cacheControl,
    ageSeconds,
    maxAgeSeconds,
    freshForSeconds,
    freshUntil: new Date(checkedAtMs + freshForSeconds * 1000).toISOString(),
    etag,
    lastModified,
  };
}

interface CacheControlDirectives {
  maxAgeSeconds: number | null;
  noCache: boolean;
  noStore: boolean;
}

function parseCacheControl(value: string | null): CacheControlDirectives {
  if (value === null) {
    return { maxAgeSeconds: null, noCache: false, noStore: false };
  }

  let sharedMaxAge: number | null = null;
  let maxAge: number | null = null;
  let noCache = false;
  let noStore = false;

  for (const rawDirective of value.split(',')) {
    const [rawName, ...rawValue] = rawDirective.trim().split('=');
    const name = rawName?.toLowerCase();
    const directiveValue = rawValue.join('=').replace(/^"|"$/g, '');
    if (name === 'no-cache') noCache = true;
    if (name === 'no-store') noStore = true;
    if (name === 's-maxage') {
      sharedMaxAge = parseNonnegativeInteger(directiveValue);
    } else if (name === 'max-age') {
      maxAge = parseNonnegativeInteger(directiveValue);
    }
  }

  return {
    maxAgeSeconds: sharedMaxAge ?? maxAge,
    noCache,
    noStore,
  };
}

function parseRetryAfter(raw: string | null, observedAtMs: number): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds)) {
      return Math.min(seconds, 86_400) * 1000;
    }
    return null;
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(Math.max(0, retryAt - observedAtMs), 86_400_000);
}

async function readBoundedBody(
  response: Response,
  deadline: Promise<never>,
  label: string,
  maxBytes: number,
): Promise<string> {
  const declaredLength = parseNonnegativeInteger(responseHeader(response, 'content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelResponseBody(response, deadline, 'response byte limit exceeded');
    throw new FetchError(0, `${label} exceeds ${maxBytes}-byte response limit`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await Promise.race([response.text(), deadline]);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new FetchError(0, `${label} exceeds ${maxBytes}-byte response limit`);
    }
    return text;
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  for (;;) {
    const chunk = await Promise.race([reader.read(), deadline]);
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxBytes) {
      await cancelWithinDeadline(() => reader.cancel('response byte limit exceeded'), deadline);
      throw new FetchError(0, `${label} exceeds ${maxBytes}-byte response limit`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function cancelResponseBody(
  response: Response,
  deadline: Promise<never>,
  reason: string,
): Promise<void> {
  if (!response.body) return;
  await cancelWithinDeadline(() => response.body!.cancel(reason), deadline);
}

async function cancelWithinDeadline(
  cancel: () => Promise<void>,
  deadline: Promise<never>,
): Promise<void> {
  try {
    await Promise.race([cancel(), deadline]);
  } catch {
    // Cleanup is best effort; preserve the more useful status/limit outcome.
  }
}

function configuredBodyLimit(): number {
  return Math.min(
    parsePositiveInteger(process.env.FETCH_MAX_BODY_BYTES) ?? 1_048_576,
    10 * 1_048_576,
  );
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = parsePositiveInteger(raw);
  return parsed ?? fallback;
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = parseNonnegativeInteger(raw);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseNonnegativeInteger(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeRequestHeader(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_HEADER_VALUE_LENGTH ||
    /\p{Cc}/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function safeResponseHeader(value: string | null): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > MAX_HEADER_VALUE_LENGTH ||
    /\p{Cc}/u.test(value)
  ) {
    return null;
  }
  return value;
}

function responseHeader(response: Response, name: string): string | null {
  return response.headers?.get?.(name) ?? null;
}

function resolveUserAgent(): string {
  return process.env.FETCH_USER_AGENT ?? 'berkeley-seat-sniper/1 (contact: operator@example.com)';
}

function resolveRobotsProductToken(): string {
  const match = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+/.exec(resolveUserAgent().trim());
  return (match?.[0] ?? 'berkeley-seat-sniper').toLowerCase();
}

function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>]/g, '')
    .slice(0, 280);
}

// Keep this import-visible for adapters that want to type their metrics sink.
export type { ScraperTelemetryEvent };
