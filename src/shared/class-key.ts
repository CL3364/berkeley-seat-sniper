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
 *  - section-num    3 digits, zero-padded   e.g. `001`
 *  - component      `lec` | `dis` | `lab` | `sem` | `fld` | `ind` | `stu` | `wbn`
 *  - component-num  3 digits, zero-padded   e.g. `001`
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

/** Allowed section components in the canonical key. */
export const CLASS_COMPONENTS = ['lec', 'dis', 'lab', 'sem', 'fld', 'ind', 'stu', 'wbn'] as const;
export type ClassComponent = (typeof CLASS_COMPONENTS)[number];

/**
 * The canonical-form regex. Anchored, lowercase only. A value matching this is,
 * by definition, already canonical.
 */
export const CLASS_KEY_PATTERN =
  /^(?<year>\d{4})-(?<season>fall|spring|summer)-(?<subject>[a-z0-9]+)-(?<course>[a-z0-9]+)-(?<section>\d{3})-(?<component>lec|dis|lab|sem|fld|ind|stu|wbn)-(?<componentNum>\d{3})$/;

/**
 * Zod schema for an ALREADY-canonical class key. Use this where a value is
 * expected to be canonical (db rows, internal payloads, NotifyEvent). For
 * accepting raw user input (a URL OR a code), use {@link ClassKeyInputSchema},
 * which normalizes.
 */
export const ClassKeySchema = z
  .string()
  .regex(CLASS_KEY_PATTERN, 'must be a canonical class key, e.g. 2026-fall-compsci-189-001-lec-001')
  .transform((v) => v as ClassKey);

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
 *  - Zero-pads section and component numbers to 3 digits.
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

/** Maps long-form / common component words to their canonical 3-letter code. */
const COMPONENT_ALIASES: Record<string, ClassComponent> = {
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
 * to `001` when omitted. Section and component numbers are zero-padded to 3.
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
  if (!/^[a-z0-9]+$/.test(subject)) return { ok: false, reason: 'invalid-field' };

  // course — alnum, may carry a letter suffix (e.g. `61a`).
  const course = tokens[i++];
  if (!/^[a-z0-9]+$/.test(course)) return { ok: false, reason: 'invalid-field' };

  // section number — numeric, zero-padded to 3.
  const sectionRaw = tokens[i++];
  if (!/^\d{1,3}$/.test(sectionRaw)) return { ok: false, reason: 'invalid-field' };
  const section = sectionRaw.padStart(3, '0');

  // component — required; accept canonical codes and common long forms.
  const componentToken = tokens[i++];
  const component = COMPONENT_ALIASES[componentToken];
  if (!component) return { ok: false, reason: 'unrecognized-format' };

  // component number — optional; default `001`, else numeric zero-padded to 3.
  let componentNum = '001';
  if (i < tokens.length) {
    const compNumRaw = tokens[i++];
    if (!/^\d{1,3}$/.test(compNumRaw)) return { ok: false, reason: 'invalid-field' };
    componentNum = compNumRaw.padStart(3, '0');
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
 * Zod schema that accepts RAW user input (URL or code) and yields a canonical
 * {@link ClassKey}, or fails validation with a safe message. This is what the
 * API request schemas use so the boundary normalizes once (constitution: validate
 * all external input at the boundary). Backed by {@link normalizeClassKey}.
 */
export const ClassKeyInputSchema = z
  .string()
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
