/**
 * Unit tests for parseClassPage — spec FR-6, AC-5.
 *
 * All tests use SAVED FIXTURES under src/scraper/fixtures/ so the network is
 * never touched. Tests assert the exact ParseResult shape produced by each
 * fixture and ensure the parser-broke arm is structurally distinct from any
 * SeatState (FR-6: a parse failure MUST NOT be coerced into "0 seats").
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseClassPage } from '../../src/scraper/parse';
import { isParserBroke, isSeatState } from '../../src/shared/seat-state';
import type { ClassKey } from '../../src/shared/class-key';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL('../../src/scraper/fixtures/', import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf-8');
}

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;

// ---------------------------------------------------------------------------
// open-seats.html — 3 open seats, waitlist closed → status 'open'
// ---------------------------------------------------------------------------

describe('parseClassPage — open-seats.html', () => {
  const html = loadFixture('open-seats.html');

  it('returns a SeatState (not parser-broke)', () => {
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
    expect(isParserBroke(result)).toBe(false);
  });

  it('status is "open"', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('open');
  });

  it('openSeats is 3', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.openSeats).toBe(3);
  });

  it('waitlistOpen is false', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.waitlistOpen).toBe(false);
  });

  it('classKey matches the input', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.classKey).toBe(CK);
  });

  it('fetchedAt is a valid ISO-8601 datetime', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(() => new Date(result.fetchedAt)).not.toThrow();
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  });
});

// ---------------------------------------------------------------------------
// zero-seats.html — 0 open seats, waitlist closed → status 'closed'
// ---------------------------------------------------------------------------

describe('parseClassPage — zero-seats.html', () => {
  const html = loadFixture('zero-seats.html');

  it('returns a SeatState (not parser-broke)', () => {
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
  });

  it('status is "closed"', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('closed');
  });

  it('openSeats is 0', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.openSeats).toBe(0);
  });

  it('waitlistOpen is false', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.waitlistOpen).toBe(false);
  });

  it('CRITICAL: closed status is NOT produced by a parse failure — it is a real SeatState', () => {
    // FR-6: a parser-broke must never masquerade as 0 seats / closed. Here we
    // confirm the inverse: a genuine 0-seat parse IS a SeatState with status
    // 'closed', not parser-broke. Both arms must be structurally distinct.
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
    expect(isParserBroke(result)).toBe(false);
    if (isSeatState(result)) {
      expect(result.status).toBe('closed');
      expect(result.openSeats).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// waitlist-open.html — 0 open seats, waitlist open → status 'waitlist'
// ---------------------------------------------------------------------------

describe('parseClassPage — waitlist-open.html', () => {
  const html = loadFixture('waitlist-open.html');

  it('returns a SeatState (not parser-broke)', () => {
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
  });

  it('status is "waitlist"', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.status).toBe('waitlist');
  });

  it('openSeats is 0', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.openSeats).toBe(0);
  });

  it('waitlistOpen is true', () => {
    const result = parseClassPage(html, CK);
    if (!isSeatState(result)) throw new Error('expected SeatState');
    expect(result.waitlistOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// changed-shape.html — AC-5: parser-broke when enrollment nodes are absent
// ---------------------------------------------------------------------------

describe('parseClassPage — changed-shape.html (AC-5: parser-broke)', () => {
  const html = loadFixture('changed-shape.html');

  it('returns parser-broke (not a SeatState)', () => {
    const result = parseClassPage(html, CK);
    expect(isParserBroke(result)).toBe(true);
    expect(isSeatState(result)).toBe(false);
  });

  it('CRITICAL: does NOT return status="closed" or openSeats=0 for a broken page (FR-6)', () => {
    // This is the core FR-6 contract: a parse failure must never become a SeatState.
    // If it did, false 0-seats would hide a real opening.
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(false);
    // TypeScript: only parser-broke has .kind
    if (isParserBroke(result)) {
      expect(result.kind).toBe('parser-broke');
    }
  });

  it('classKey in parser-broke result matches input', () => {
    const result = parseClassPage(html, CK);
    if (!isParserBroke(result)) throw new Error('expected parser-broke');
    expect(result.classKey).toBe(CK);
  });

  it('detail is a non-empty operator-safe string (no raw HTML)', () => {
    const result = parseClassPage(html, CK);
    if (!isParserBroke(result)) throw new Error('expected parser-broke');
    expect(typeof result.detail).toBe('string');
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail.length).toBeLessThanOrEqual(280);
    // The detail must not contain raw HTML tags (no angle brackets in detail).
    expect(result.detail).not.toMatch(/<[^>]+>/);
  });
});

// ---------------------------------------------------------------------------
// Inline HTML edge cases — additional unhappy paths
// ---------------------------------------------------------------------------

describe('parseClassPage — inline HTML edge cases', () => {
  it('returns parser-broke for completely empty HTML', () => {
    const result = parseClassPage('', CK);
    expect(isParserBroke(result)).toBe(true);
  });

  it('returns parser-broke for HTML with no enroll-numbers block', () => {
    const html = '<html><body><p>nothing here</p></body></html>';
    const result = parseClassPage(html, CK);
    expect(isParserBroke(result)).toBe(true);
  });

  it('returns parser-broke when the .count node contains non-numeric text', () => {
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">N/A</span></div>
        </div>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    expect(isParserBroke(result)).toBe(true);
  });

  it('CRITICAL: non-numeric seat count must never become 0 (false 0 hides a real opening)', () => {
    // FR-6: a non-numeric count must produce parser-broke, not openSeats=0.
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">TBD</span></div>
        </div>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    expect(isParserBroke(result)).toBe(true);
    expect(isSeatState(result)).toBe(false);
  });

  it('returns parser-broke when seat count is negative', () => {
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">-1</span></div>
        </div>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    expect(isParserBroke(result)).toBe(true);
  });

  it('treats absent waitlist node as waitlistOpen=false (not a parse break)', () => {
    // No .waitlist-status node — some classes have no waitlist; should not break.
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">2</span></div>
        </div>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    // Should succeed — absent waitlist node is OK.
    expect(isSeatState(result)).toBe(true);
    if (isSeatState(result)) {
      expect(result.waitlistOpen).toBe(false);
      expect(result.openSeats).toBe(2);
      expect(result.status).toBe('open');
    }
  });

  it('is case-insensitive on waitlist "open" text', () => {
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">0</span></div>
        </div>
        <span class="waitlist-status">OPEN</span>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
    if (isSeatState(result)) {
      expect(result.waitlistOpen).toBe(true);
      expect(result.status).toBe('waitlist');
    }
  });

  it('correctly maps openSeats=1 to status="open"', () => {
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">1</span></div>
        </div>
      </body></html>
    `;
    const result = parseClassPage(html, CK);
    expect(isSeatState(result)).toBe(true);
    if (isSeatState(result)) {
      expect(result.status).toBe('open');
      expect(result.openSeats).toBe(1);
    }
  });

  it('preserves the classKey in a successful parse', () => {
    const html = `
      <html><body>
        <div class="enroll-numbers">
          <div class="available"><span class="count">5</span></div>
        </div>
      </body></html>
    `;
    const differentKey = '2026-spring-math-110-001-dis-002' as ClassKey;
    const result = parseClassPage(html, differentKey);
    if (isSeatState(result)) {
      expect(result.classKey).toBe(differentKey);
    }
  });
});
