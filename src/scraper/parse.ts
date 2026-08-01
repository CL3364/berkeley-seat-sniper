/**
 * Pure parser for the public Berkeley class-page representation.
 *
 * The upstream HTML is untrusted data. This module only performs structural
 * extraction with node-html-parser: it never evaluates page content, follows a
 * page-provided URL, or exposes raw HTML in an operator-facing result.
 *
 * The current public page has exactly one `section.current-enrollment` region:
 *
 *   <section class="collapsable current-enrollment open">
 *     <h3><a>Current Enrollment</a></h3>
 *     <div class="section-content">
 *       <div class="top"><strong>Total Open Seats:</strong><span>8</span></div>
 *       <div class="stats">
 *         <div><strong>Waitlisted:</strong> 40</div>
 *         <div><strong>Waitlist Max:</strong> 100</div>
 *       </div>
 *     </div>
 *   </section>
 *
 * We deliberately bind to the labels inside that region rather than incidental
 * classes on the value nodes. Missing/duplicate/malformed fields are a loud
 * parser-broke result; they are never guessed as zero.
 */

import { parse as parseHtml } from 'node-html-parser';
import type { ClassKey } from '../shared/class-key';
import { MAX_OBSERVED_COUNT, type ParseResult, type SeatStatus } from '../shared/seat-state';

const BERKELEY_ORIGIN = 'https://classes.berkeley.edu';
const ENROLLMENT_SECTION_SELECTOR = 'section.current-enrollment';
const MAX_DISPLAY_NAME_LENGTH = 256;

const FIELD_LABELS = {
  openSeats: 'total open seats',
  enrolled: 'enrolled',
  capacity: 'capacity',
  waitlisted: 'waitlisted',
  waitlistMax: 'waitlist max',
} as const;

/** Operator-safe parser telemetry. It contains no page text, URL, or PII. */
export type ScraperTelemetryEvent = {
  event: 'negative-open-seats-normalized';
  classKey: ClassKey;
  observedOpenSeats: number;
  normalizedOpenSeats: 0;
};

export interface ParseClassPageOptions {
  /** Fetch completion time supplied by the source wrapper. Defaults to now. */
  fetchedAt?: string;
  /** Optional metrics/log adapter. Observer failures never change parse truth. */
  onTelemetry?: (event: ScraperTelemetryEvent) => void;
}

/**
 * Parse one public class page into the shared ParseResult contract.
 *
 * Successful parsing requires:
 * - exactly one canonical link matching the requested ClassKey;
 * - exactly one current-enrollment section with the expected heading;
 * - exactly one of each required labeled field in that section;
 * - safe plain integers and a non-contradictory waitlist count/capacity.
 */
export function parseClassPage(
  html: string,
  classKey: ClassKey,
  options: ParseClassPageOptions = {},
): ParseResult {
  const root = parseHtml(html);

  const identityProblem = validatePageIdentity(root, classKey);
  if (identityProblem !== null) return parserBroke(classKey, identityProblem);

  const enrollmentSections = root.querySelectorAll(ENROLLMENT_SECTION_SELECTOR);
  if (enrollmentSections.length !== 1) {
    return parserBroke(
      classKey,
      `expected exactly one current-enrollment region; found ${enrollmentSections.length}`,
    );
  }

  const enrollment = enrollmentSections[0];
  const heading = normalizeText(enrollment.querySelector('h3')?.text ?? '');
  if (heading !== 'current enrollment') {
    return parserBroke(classKey, 'current-enrollment region heading is missing or unrecognized');
  }

  const openSeatsText = extractLabeledValue(enrollment, FIELD_LABELS.openSeats);
  if (!openSeatsText.ok) return parserBroke(classKey, openSeatsText.detail);
  const waitlistedText = extractLabeledValue(enrollment, FIELD_LABELS.waitlisted);
  if (!waitlistedText.ok) return parserBroke(classKey, waitlistedText.detail);
  const waitlistMaxText = extractLabeledValue(enrollment, FIELD_LABELS.waitlistMax);
  if (!waitlistMaxText.ok) return parserBroke(classKey, waitlistMaxText.detail);

  const observedOpenSeats = parseSafeInteger(openSeatsText.value, true);
  if (observedOpenSeats === null) {
    return parserBroke(classKey, 'Total Open Seats is not a signed plain integer');
  }
  if (observedOpenSeats > MAX_OBSERVED_COUNT) {
    return parserBroke(classKey, 'Total Open Seats exceeds the supported count bound');
  }
  const waitlisted = parseSafeInteger(waitlistedText.value, false);
  if (waitlisted === null) {
    return parserBroke(classKey, 'Waitlisted is not a nonnegative plain integer');
  }
  const waitlistMax = parseSafeInteger(waitlistMaxText.value, false);
  if (waitlistMax === null) {
    return parserBroke(classKey, 'Waitlist Max is not a nonnegative plain integer');
  }

  if (waitlisted > waitlistMax) {
    return parserBroke(classKey, 'waitlist count exceeds Waitlist Max');
  }

  const openSeats = observedOpenSeats > 0 ? observedOpenSeats : 0;
  if (observedOpenSeats < 0) {
    emitTelemetry(options.onTelemetry, {
      event: 'negative-open-seats-normalized',
      classKey,
      observedOpenSeats,
      normalizedOpenSeats: 0,
    });
  }

  const waitlistOpen = waitlistMax > 0 && waitlisted < waitlistMax;
  const status: SeatStatus = openSeats > 0 ? 'open' : waitlistOpen ? 'waitlist' : 'closed';

  return {
    classKey,
    status,
    openSeats,
    waitlistOpen,
    fetchedAt: resolveFetchedAt(options.fetchedAt),
    displayName: extractDisplayName(root),
    enrolled: extractOptionalCount(enrollment, FIELD_LABELS.enrolled),
    capacity: extractOptionalCount(enrollment, FIELD_LABELS.capacity),
    waitlisted: persistedCountOrNull(waitlisted),
    waitlistMax: persistedCountOrNull(waitlistMax),
  };
}

/**
 * Recognize a 200 soft-not-found page so the fetcher can return class-gone.
 *
 * The detector is intentionally conservative. Any page containing the real
 * current-enrollment region wins over not-found copy elsewhere in the document,
 * preventing a stray phrase from retiring a live watch.
 */
export function isNotFoundPage(html: string): boolean {
  const root = parseHtml(html);
  if (root.querySelector(ENROLLMENT_SECTION_SELECTOR)) return false;

  if (
    root.querySelector('.not-found') ||
    root.querySelector('.page-not-found') ||
    root.querySelector('[data-status="not-found"]')
  ) {
    return true;
  }

  const title = normalizeText(root.querySelector('title')?.text ?? '');
  const h1 = normalizeText(root.querySelector('h1')?.text ?? '');
  return NOT_FOUND_PHRASES.test(title) || NOT_FOUND_PHRASES.test(h1);
}

const NOT_FOUND_PHRASES =
  /\b(page not found|class not found|section not found|no longer (available|offered)|not currently offered)\b/i;

type RootNode = ReturnType<typeof parseHtml>;
type HtmlNode = ReturnType<RootNode['querySelectorAll']>[number];

function validatePageIdentity(root: RootNode, classKey: ClassKey): string | null {
  const canonicalLinks = root.querySelectorAll('link').filter((link) => {
    const rel = link.getAttribute('rel') ?? '';
    return rel.toLowerCase().split(/\s+/).includes('canonical');
  });

  if (canonicalLinks.length !== 1) {
    return `expected exactly one canonical page identity; found ${canonicalLinks.length}`;
  }

  const href = canonicalLinks[0].getAttribute('href');
  if (!href || href.length > 2048) return 'canonical page identity is missing or invalid';

  let canonical: URL;
  try {
    canonical = new URL(href, BERKELEY_ORIGIN);
  } catch {
    return 'canonical page identity is missing or invalid';
  }

  const expectedPath = `/content/${classKey}`;
  if (
    canonical.origin !== BERKELEY_ORIGIN ||
    canonical.pathname !== expectedPath ||
    canonical.search !== '' ||
    canonical.hash !== ''
  ) {
    return 'canonical page identity does not match the requested class';
  }

  return null;
}

type LabeledValue = { ok: true; value: string } | { ok: false; detail: string };

/**
 * Extract a value paired with one exact <strong> label inside the enrollment
 * region. Only the label's immediate parent is read so adjacent enrollment
 * fields cannot be accidentally concatenated into a plausible number.
 */
function extractLabeledValue(region: HtmlNode, expectedLabel: string): LabeledValue {
  const matches = region
    .querySelectorAll('strong')
    .filter((node) => normalizeLabel(node.text) === expectedLabel);

  if (matches.length !== 1) {
    return {
      ok: false,
      detail: `expected exactly one "${titleCaseLabel(expectedLabel)}" field; found ${matches.length}`,
    };
  }

  const labelNode = matches[0];
  const parent = labelNode.parentNode;
  if (!parent) {
    return { ok: false, detail: `"${titleCaseLabel(expectedLabel)}" field has no value container` };
  }

  const labelText = normalizeText(labelNode.text);
  const combined = normalizeText(parent.text);
  if (!combined.startsWith(labelText)) {
    return {
      ok: false,
      detail: `"${titleCaseLabel(expectedLabel)}" field structure is unrecognized`,
    };
  }

  const value = combined.slice(labelText.length).trim();
  if (value === '') {
    return { ok: false, detail: `"${titleCaseLabel(expectedLabel)}" field is empty` };
  }
  return { ok: true, value };
}

function parseSafeInteger(raw: string, signed: boolean): number | null {
  const pattern = signed ? /^[+-]?\d+$/ : /^\d+$/;
  if (!pattern.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Dashboard-only counts are deliberately lenient. The strict availability
 * fields above still decide whether a page is parseable; a missing, duplicate,
 * malformed, or PostgreSQL-integer-out-of-range dashboard value only renders
 * as unknown and can never page the operator or suppress subscriber alerts.
 */
function extractOptionalCount(region: HtmlNode, expectedLabel: string): number | null {
  const extracted = extractLabeledValue(region, expectedLabel);
  if (!extracted.ok) return null;
  const parsed = parseSafeInteger(extracted.value, false);
  return parsed === null ? null : persistedCountOrNull(parsed);
}

function persistedCountOrNull(value: number): number | null {
  return value <= MAX_OBSERVED_COUNT ? value : null;
}

/**
 * A page heading is display-only. Exactly one normalized, nonblank, bounded
 * h1 is useful; every other shape is simply unknown rather than parser-broke.
 */
function extractDisplayName(root: RootNode): string | null {
  const headings = root.querySelectorAll('h1');
  if (headings.length !== 1) return null;
  const value = normalizeDisplayText(headings[0].text);
  return value !== '' && value.length <= MAX_DISPLAY_NAME_LENGTH ? value : null;
}

function normalizeLabel(value: string): string {
  return normalizeText(value).replace(/:\s*$/, '');
}

function normalizeText(value: string): string {
  return normalizeDisplayText(value).toLowerCase();
}

function normalizeDisplayText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleCaseLabel(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function resolveFetchedAt(value: string | undefined): string {
  if (value !== undefined) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function emitTelemetry(
  observer: ParseClassPageOptions['onTelemetry'],
  event: ScraperTelemetryEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Telemetry is deliberately non-authoritative. A broken metrics adapter must
    // not turn an otherwise valid source observation into parser-broke.
  }
}

/** Construct a bounded, operator-safe parser-broke result. */
function parserBroke(
  classKey: ClassKey,
  detail: string,
): Extract<ParseResult, { kind: 'parser-broke' }> {
  return { kind: 'parser-broke', classKey, detail: sanitizeDetail(detail) };
}

function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>]/g, '')
    .slice(0, 280);
}
