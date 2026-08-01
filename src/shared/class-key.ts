import { z } from 'zod';

/**
 * Canonical class key — the single normalized identity for a watched class.
 *
 * Ties to FR-1 (subscribe normalizes a class URL/code to a canonical key) and
 * FR-3 (the poller fetches each UNIQUE class once, keyed by this value, then
 * fans out). Every layer — db `class_key` column, worker dedupe map, notifier
 * payload — uses this exact string so a URL and the equivalent code collapse to
 * one watch.
 *
 * Canonical form (lowercase, hyphen-delimited, fixed slot count):
 *
 *   `<term-year>-<term-season>-<subject>-<course>-<section-num>-<component>-<component-num>`
 *
 * Example: `2026-fall-compsci-189-001-lec-001`
 *
 *  - term-year      4 digits                e.g. `2026`
 *  - term-season    `fall` | `spring` | `summer`
 *  - subject        lowercase alnum slug    e.g. `compsci`
 *  - course         alnum, may include a letter suffix, e.g. `189`, `61a`
 *  - section-id     3–8 digits, or 1–8 lowercase alnum containing a letter
 *                                             e.g. `001`, `999l`
 *  - component      2–8 lowercase letters   e.g. `lec`, `col`, `grp`, `slf`
 *  - component-id   3–8 digits, or 1–8 lowercase alnum containing a letter
 *                                             e.g. `001`, `999l`
 *
 * The canonical form is deliberately the same slug Berkeley uses in its public
 * page path (`classes.berkeley.edu/content/<canonical>`), so URL inputs require
 * only extraction, and code inputs require only formatting.
 */

/** Branded string so a raw `string` cannot be passed where a normalized key is required. */
export type ClassKey = string & { readonly __brand: 'ClassKey' };

/** Allowed term seasons in the canonical key. */
export const TERM_SEASONS = ['fall', 'spring', 'summer'] as const;
export type TermSeason = (typeof TERM_SEASONS)[number];

/**
 * Common component codes retained for UI suggestions and compatibility.
 * This is intentionally not exhaustive: Berkeley currently publishes other
 * alphabetic codes such as `col`, `grp`, `slf`, and `tut`.
 */
export const CLASS_COMPONENTS = ['lec', 'dis', 'lab', 'sem', 'fld', 'ind', 'stu', 'wbn'] as const;
export type CommonClassComponent = (typeof CLASS_COMPONENTS)[number];

/** Validated component code; the public catalog, not this app, owns the vocabulary. */
export type ClassComponent = string & { readonly __brand: 'ClassComponent' };

/**
 * Defensive external-input bounds. Berkeley subject/course identifiers are far
 * shorter than this in practice; 32 characters preserves ample catalog headroom
 * while keeping the canonical key safely indexable by PostgreSQL.
 */
export const CLASS_KEY_COMPONENT_MAX_LENGTH = 32;
export const CLASS_KEY_IDENTIFIER_MAX_LENGTH = 8;
export const CLASS_KEY_COMPONENT_CODE_MAX_LENGTH = 8;
export const CLASS_KEY_INPUT_MAX_LENGTH = 512;
export const CLASS_KEY_MAX_LENGTH = 104;

/**
 * The canonical-form regex. Anchored, lowercase only. A value matching this is,
 * by definition, already canonical.
 *
 * MIRRORED in public/sw.js (service workers cannot import this module) — update
 * both together.
 */
export const CLASS_KEY_PATTERN =
  /^(?<year>\d{4})-(?<season>fall|spring|summer)-(?<subject>[a-z0-9]{1,32})-(?<course>[a-z0-9]{1,32})-(?<section>(?:\d{3,8}|(?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+))-(?<component>[a-z]{2,8})-(?<componentNum>(?:\d{3,8}|(?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+))$/;

/**
 * Zod schema for an ALREADY-canonical class key. Use this where a value is
 * expected to be canonical (db rows, internal payloads, NotifyEvent). For
 * accepting raw user input (a URL OR a code), use {@link ClassKeyInputSchema},
 * which normalizes.
 */
export const ClassKeySchema = z
  .string()
  .max(CLASS_KEY_MAX_LENGTH, 'canonical class key is too long')
  .regex(CLASS_KEY_PATTERN, 'must be a canonical class key, e.g. 2026-fall-compsci-189-001-lec-001')
  .transform((v) => v as ClassKey);

/** Canonical origin of the public Berkeley class pages. */
export const BERKELEY_CLASS_ORIGIN = 'https://classes.berkeley.edu';

/**
 * The official public page for a class, DERIVED from the canonical {@link ClassKey}.
 *
 * The dashboard's per-class link and the alert email's link must be the same URL, and
 * the spec (§4, FR-25) requires it be derived rather than stored per row or scraped from
 * the page — a stored URL can drift from the key that identifies the watch, and a scraped
 * one is attacker-influenced input from a third-party page.
 *
 * Pure and total: no I/O, never follows the URL. The input is already canonical (it came
 * from {@link ClassKeySchema} or a prior API response), so this is a pure concatenation.
 */
export function classPageUrl(classKey: ClassKey): string {
  return `${BERKELEY_CLASS_ORIGIN}/content/${classKey}`;
}

/**
 * Result of attempting to normalize raw input into a {@link ClassKey}.
 * `normalizeClassKey` never throws; callers branch on `ok`.
 */
export type NormalizeResult =
  | { ok: true; key: ClassKey }
  | { ok: false; reason: 'empty' | 'unrecognized-format' | 'invalid-field' };

/**
 * Normalize a raw class identifier — either a full/partial Berkeley class URL
 * (e.g. `https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001`)
 * OR a class code in a tolerated human form (e.g. `COMPSCI 189 LEC 001`,
 * `2026 Fall COMPSCI 189 001 LEC 001`) — into the canonical {@link ClassKey}.
 *
 * Contract (implemented by the backend/shared layer, tested by test-engineer):
 *  - Pure and total: NEVER throws, NEVER performs I/O, NEVER follows the URL.
 *    The input is UNTRUSTED data (constitution: prompt-injection surface) — it is
 *    only string-parsed, never executed or fetched.
 *  - Case-insensitive on input; emits lowercase canonical output.
 *  - Trims surrounding whitespace and ignores the URL scheme/host/path prefix,
 *    extracting only the `content/<slug>` segment for URL inputs.
 *  - Zero-pads numeric section and component identifiers to at least 3 digits;
 *    preserves bounded alphanumeric identifiers such as `999L` as `999l`.
 *  - Returns `{ ok: false }` (never a partial/guessed key) when the term, season,
 *    or component cannot be determined — the UI surfaces this as an inline error
 *    (FR-1 / AC-2) rather than silently creating a wrong watch.
 *
 * Note: when input omits a term, the implementation MUST NOT invent one; it
 * returns `{ ok: false, reason: 'unrecognized-format' }`. The subscribe form is
 * responsible for collecting a fully-qualified identifier.
 */
export function normalizeClassKey(input: string): NormalizeResult {
  // Total: guard non-string / nullish without throwing (callers are untyped at
  // the boundary; the input is UNTRUSTED).
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  if (input.length > CLASS_KEY_INPUT_MAX_LENGTH) {
    return { ok: false, reason: 'invalid-field' };
  }

  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  // 1) URL form: extract ONLY the `content/<slug>` segment. We never follow the
  //    URL and never trust the host — we only string-match the path. Accept a
  //    full URL, a scheme-less host path, or a bare `content/<slug>`.
  const fromUrl = extractContentSlug(trimmed);
  const candidate = fromUrl ?? trimmed;

  // 2) If the candidate is already the canonical slug (the same form Berkeley
  //    uses in its path), accept it directly after lowercasing.
  const lowered = candidate.toLowerCase();
  if (CLASS_KEY_PATTERN.test(lowered)) {
    return { ok: true, key: lowered as ClassKey };
  }

  // A URL whose slug was NOT canonical is unrecognized — do not fall through to
  // human-code parsing, which could mis-read a malformed slug.
  if (fromUrl !== null) return { ok: false, reason: 'unrecognized-format' };

  // 3) Human code form. Split on whitespace, hyphens, slashes, commas. Example
  //    inputs: `2026 Fall COMPSCI 189 001 LEC 001`, `COMPSCI 189 LEC 001`
  //    (the latter has NO term and is therefore rejected — we never invent one).
  return normalizeHumanCode(lowered);
}

/**
 * Pull the `content/<slug>` segment out of a Berkeley class URL. Returns the raw
 * slug (still un-lowercased) or `null` if the input is not URL-shaped. Pure
 * string matching only — no URL parsing that could throw on malformed input, no
 * network. We deliberately ignore scheme/host and look for the `content/` marker.
 */
function extractContentSlug(raw: string): string | null {
  // Match `.../content/<slug>` allowing an optional trailing slash, query, or
  // hash, which we strip. Case-insensitive on the `content` marker only.
  const m = raw.match(/(?:^|\/)content\/([^/?#\s]+)/i);
  if (m && m[1]) return m[1];

  // Not URL-shaped. If it merely looks like it tried to be a URL (has a scheme
  // or a host with a slash but no recognizable `content/` segment), signal that
  // by returning null so the caller treats it as unrecognized rather than as a
  // human code. We detect "URL-ish" cheaply.
  return null;
}

/** Maps long-form / common component words to their canonical catalog code. */
const COMPONENT_ALIASES: Record<string, string> = {
  lec: 'lec',
  lecture: 'lec',
  dis: 'dis',
  discussion: 'dis',
  lab: 'lab',
  laboratory: 'lab',
  sem: 'sem',
  seminar: 'sem',
  fld: 'fld',
  field: 'fld',
  ind: 'ind',
  independent: 'ind',
  stu: 'stu',
  studio: 'stu',
  wbn: 'wbn',
  webinar: 'wbn',
};

const SEASON_SET = new Set<string>(TERM_SEASONS);

/**
 * Parse a tolerated human code form into the canonical key. Expects, in order
 * (with arbitrary whitespace/hyphen/slash/comma separators):
 *   <year> <season> <subject> <course> <section> <component> [<componentNum>]
 * Year and season are REQUIRED (we never invent a term). `componentNum` defaults
 * to `001` when omitted. Numeric section and component identifiers are
 * zero-padded to at least 3; alphanumeric identifiers are preserved.
 *
 * `lowered` is already lowercased + trimmed.
 */
function normalizeHumanCode(lowered: string): NormalizeResult {
  const tokens = lowered.split(/[\s\-/,]+/).filter((t) => t.length > 0);
  // Minimum: year, season, subject, course, section, component = 6 tokens.
  if (tokens.length < 6) return { ok: false, reason: 'unrecognized-format' };

  let i = 0;

  // year — exactly 4 digits, required.
  const year = tokens[i++];
  if (!/^\d{4}$/.test(year)) return { ok: false, reason: 'unrecognized-format' };

  // season — required, must be a known season (never invented).
  const season = tokens[i++];
  if (!SEASON_SET.has(season)) return { ok: false, reason: 'unrecognized-format' };

  // subject — alnum slug.
  const subject = tokens[i++];
  if (subject.length > CLASS_KEY_COMPONENT_MAX_LENGTH || !/^[a-z0-9]+$/.test(subject)) {
    return { ok: false, reason: 'invalid-field' };
  }

  // course — alnum, may carry a letter suffix (e.g. `61a`).
  const course = tokens[i++];
  if (course.length > CLASS_KEY_COMPONENT_MAX_LENGTH || !/^[a-z0-9]+$/.test(course)) {
    return { ok: false, reason: 'invalid-field' };
  }

  // section identifier — bounded catalog id; numeric forms are zero-padded.
  const sectionRaw = tokens[i++];
  const section = normalizeCatalogIdentifier(sectionRaw);
  if (!section) return { ok: false, reason: 'invalid-field' };

  // component — accept aliases plus any bounded alphabetic catalog code. Page
  // identity validation in the scraper remains the authority that it exists.
  const componentToken = tokens[i++];
  const component =
    COMPONENT_ALIASES[componentToken] ??
    (/^[a-z]{2,8}$/.test(componentToken) ? componentToken : undefined);
  if (!component) return { ok: false, reason: 'unrecognized-format' };

  // component identifier — optional; default `001`, numeric forms zero-padded.
  let componentNum = '001';
  if (i < tokens.length) {
    const compNumRaw = tokens[i++];
    const normalizedComponentNum = normalizeCatalogIdentifier(compNumRaw);
    if (!normalizedComponentNum) return { ok: false, reason: 'invalid-field' };
    componentNum = normalizedComponentNum;
  }

  // Any leftover tokens mean the input did not match the expected shape.
  if (i < tokens.length) return { ok: false, reason: 'unrecognized-format' };

  const key = `${year}-${season}-${subject}-${course}-${section}-${component}-${componentNum}`;

  // Defensive: the assembled key must satisfy the canonical pattern. This can
  // only fail on an out-of-range field we somehow let through; treat as invalid.
  if (!CLASS_KEY_PATTERN.test(key)) return { ok: false, reason: 'invalid-field' };

  return { ok: true, key: key as ClassKey };
}

/**
 * Normalize one Berkeley section/component identifier. Purely numeric values
 * are padded to the public-path minimum of three digits; longer numeric values
 * and bounded alphanumeric values are preserved.
 */
function normalizeCatalogIdentifier(raw: string): string | null {
  if (!/^[a-z0-9]{1,8}$/.test(raw)) return null;
  return /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw;
}

/**
 * Zod schema that accepts RAW user input (URL or code) and yields a canonical
 * {@link ClassKey}, or fails validation with a safe message. This is what the
 * API request schemas use so the boundary normalizes once (constitution: validate
 * all external input at the boundary). Backed by {@link normalizeClassKey}.
 */
export const ClassKeyInputSchema = z
  .string()
  .max(CLASS_KEY_INPUT_MAX_LENGTH, 'class identifier is too long')
  .trim()
  .min(1, 'class identifier is required')
  .superRefine((raw, ctx) => {
    const result = normalizeClassKey(raw);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'could not recognize this as a Berkeley class URL or code; expected e.g. 2026-fall-compsci-189-001-lec-001',
      });
    }
  })
  .transform((raw) => {
    // Safe: superRefine above guarantees ok === true by the time we transform.
    const result = normalizeClassKey(raw);
    return (result.ok ? result.key : raw) as ClassKey;
  });
