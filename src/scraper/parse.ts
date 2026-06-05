/**
 * Pure HTML parser for Berkeley class pages. No I/O — accepts raw HTML string
 * and returns a typed ParseResult. Isolated from fetch so both halves are
 * independently testable against saved fixtures.
 *
 * Security: the `html` argument is treated strictly as DATA. It is handed to
 * node-html-parser for structural extraction only. We never eval/exec page
 * content, never derive file paths or shell commands from it, and never follow
 * any URL found in it. The `detail` field in parser-broke results is a short
 * operator string — no raw HTML, no PII.
 *
 * Selectors relied on (update this list and the fixtures together when upstream changes):
 *   - `.enroll-numbers .available .count` — integer open seat count
 *   - `.waitlist-status`                  — text node; "open" (case-insensitive)
 *                                           means the waitlist is accepting entries
 *
 * Status mapping (per spec §4 / seat-state.ts):
 *   openSeats > 0                         → 'open'
 *   openSeats === 0 && waitlistOpen       → 'waitlist'
 *   openSeats === 0 && !waitlistOpen      → 'closed'
 */

import { parse as parseHtml } from 'node-html-parser';
import type { ClassKey } from '../shared/class-key';
import type { ParseResult, SeatStatus } from '../shared/seat-state';

/**
 * Parse a Berkeley class page HTML string into a typed ParseResult.
 *
 * @param html     Raw HTML string fetched from the class page. Treated as
 *                 untrusted data — never executed.
 * @param classKey Canonical class key for the page being parsed. Included in
 *                 both success and parser-broke results for traceability.
 * @returns        SeatState on success, or { kind: 'parser-broke' } when the
 *                 expected nodes are missing or the seat count is non-numeric.
 *                 NEVER coerces a parse failure into 0 seats / 'closed'.
 */
export function parseClassPage(html: string, classKey: ClassKey): ParseResult {
  // node-html-parser is a real structural parser — not regex on raw HTML.
  // We pass the string as data; the library handles malformed markup safely.
  const root = parseHtml(html);

  // --- Extract open seat count ------------------------------------------------
  // Selector: .enroll-numbers .available .count
  // The `.available` wrapper distinguishes available-seats from enrolled/max counts
  // that also use `.count` inside the same `.enroll-numbers` block.
  const seatNode = root.querySelector('.enroll-numbers .available .count');
  if (!seatNode) {
    return parserBroke(classKey, 'seat-count node not found (.enroll-numbers .available .count)');
  }

  const rawCount = seatNode.text.trim();
  const openSeats = parseInt(rawCount, 10);
  if (!Number.isFinite(openSeats) || openSeats < 0) {
    // Non-numeric or negative seat count — page shape has changed or is corrupt.
    // Never treat this as 0; that would be a false 0 hiding a real open seat.
    return parserBroke(classKey, `seat-count value unparseable: "${sanitize(rawCount)}"`);
  }

  // --- Extract waitlist status ------------------------------------------------
  // Selector: .waitlist-status
  // Text content "Open" (case-insensitive) means the waitlist is accepting entries.
  // Absent node → conservatively treat as waitlist closed (not a parse break,
  // since some classes genuinely have no waitlist and the node may be omitted).
  const waitlistNode = root.querySelector('.waitlist-status');
  const waitlistOpen = waitlistNode
    ? waitlistNode.text.trim().toLowerCase() === 'open'
    : false;

  // --- Map to status ----------------------------------------------------------
  const status: SeatStatus =
    openSeats > 0 ? 'open' : waitlistOpen ? 'waitlist' : 'closed';

  return {
    classKey,
    status,
    openSeats,
    waitlistOpen,
    fetchedAt: new Date().toISOString(),
  };
}

// --- Helpers ------------------------------------------------------------------

/** Construct a parser-broke result. detail MUST be operator-safe: no raw HTML, no PII. */
function parserBroke(
  classKey: ClassKey,
  detail: string,
): Extract<ParseResult, { kind: 'parser-broke' }> {
  return { kind: 'parser-broke', classKey, detail };
}

/**
 * Truncate and strip control characters so a short excerpt from page text is
 * safe to embed in an operator `detail` string. Never include full HTML.
 */
function sanitize(raw: string): string {
  // Keep only printable ASCII/Unicode, truncate to 40 chars.
  return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40);
}
