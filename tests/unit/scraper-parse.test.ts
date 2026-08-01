/**
 * Unit tests for the cache-visible public-page parser — FR-6, FR-16, AC-5,
 * AC-17.
 *
 * Saved fixtures are sanitized but retain the current Berkeley enrollment DOM:
 * one canonical identity, one `section.current-enrollment`, and the labeled
 * Total Open Seats / Waitlisted / Waitlist Max fields. No test performs I/O
 * beyond reading those repository fixtures.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isNotFoundPage, parseClassPage } from '../../src/scraper/parse';
import { MAX_OBSERVED_COUNT, isParserBroke, isSeatState } from '../../src/shared/seat-state';
import type { ClassKey } from '../../src/shared/class-key';

const FIXTURE_DIR = fileURLToPath(new URL('../../src/scraper/fixtures/', import.meta.url));
const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;

function loadFixture(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf-8');
}

function livePage(
  fields: {
    openSeats?: string;
    waitlisted?: string;
    waitlistMax?: string;
    heading?: string | null;
    enrolled?: string | null;
    capacity?: string | null;
    extraHeadings?: string;
    extraFields?: string;
  } = {},
  identity: ClassKey = CK,
): string {
  const {
    openSeats = '0',
    waitlisted = '0',
    waitlistMax = '0',
    heading = null,
    enrolled = null,
    capacity = null,
    extraHeadings = '',
    extraFields = '',
  } = fields;
  return `<!doctype html>
    <html>
      <head>
        <link rel="canonical" href="https://classes.berkeley.edu/content/${identity}" />
      </head>
      <body>
        ${heading === null ? '' : `<h1>${heading}</h1>`}
        ${extraHeadings}
        <section class="collapsable current-enrollment open">
          <h3><a>Current Enrollment</a></h3>
          <div class="section-content">
            <div class="top"><strong>Total Open Seats:</strong><span>${openSeats}</span></div>
            <div class="stats">
              ${enrolled === null ? '' : `<div><strong>Enrolled:</strong> ${enrolled}</div>`}
              <div><strong>Waitlisted:</strong> ${waitlisted}</div>
              ${capacity === null ? '' : `<div><strong>Capacity:</strong> ${capacity}</div>`}
              <div><strong>Waitlist Max:</strong> ${waitlistMax}</div>
              ${extraFields}
            </div>
          </div>
        </section>
      </body>
    </html>`;
}

describe('parseClassPage — sanitized live-shaped fixtures', () => {
  it.each([
    ['open-seats.html', 'open', 3, false, 347, 350, 100, 100],
    ['zero-seats.html', 'closed', 0, false, 350, 350, 100, 100],
    ['waitlist-open.html', 'waitlist', 0, true, 350, 350, 39, 40],
  ] as const)(
    '%s parses to status=%s, openSeats=%i, waitlistOpen=%s',
    (fixture, status, openSeats, waitlistOpen, enrolled, capacity, waitlisted, waitlistMax) => {
      const result = parseClassPage(loadFixture(fixture), CK, {
        fetchedAt: '2026-07-23T20:00:00.000Z',
      });

      expect(isSeatState(result)).toBe(true);
      expect(isParserBroke(result)).toBe(false);
      if (!isSeatState(result)) return;
      expect(result).toEqual({
        classKey: CK,
        status,
        openSeats,
        waitlistOpen,
        fetchedAt: '2026-07-23T20:00:00.000Z',
        displayName: 'COMPSCI 189 001 - LEC 001',
        enrolled,
        capacity,
        waitlisted,
        waitlistMax,
      });
    },
  );

  it('normalizes the sole bounded h1 and captures lenient enrollment totals', () => {
    const result = parseClassPage(
      livePage({
        heading: '  COMPSCI\n  189 001  -  LEC 001  ',
        enrolled: '347',
        capacity: '350',
      }),
      CK,
    );

    expect(isSeatState(result)).toBe(true);
    expect(result).toMatchObject({
      displayName: 'COMPSCI 189 001 - LEC 001',
      enrolled: 347,
      capacity: 350,
      waitlisted: 0,
      waitlistMax: 0,
    });
  });

  it('returns explicit null observations when optional markup is absent', () => {
    const result = parseClassPage(livePage(), CK);

    expect(isSeatState(result)).toBe(true);
    expect(result).toMatchObject({
      displayName: null,
      enrolled: null,
      capacity: null,
      waitlisted: 0,
      waitlistMax: 0,
    });
  });

  it.each([
    {
      label: 'multiple headings',
      html: livePage({ heading: 'First', extraHeadings: '<h1>Second</h1>' }),
      expected: { displayName: null },
    },
    {
      label: 'blank heading',
      html: livePage({ heading: '   ' }),
      expected: { displayName: null },
    },
    {
      label: 'overlong heading',
      html: livePage({ heading: 'x'.repeat(257) }),
      expected: { displayName: null },
    },
    {
      label: 'malformed enrollment',
      html: livePage({ enrolled: '347 students' }),
      expected: { enrolled: null },
    },
    {
      label: 'negative capacity',
      html: livePage({ capacity: '-1' }),
      expected: { capacity: null },
    },
    {
      label: 'duplicate enrollment',
      html: livePage({
        enrolled: '347',
        extraFields: '<div><strong>Enrolled:</strong> 348</div>',
      }),
      expected: { enrolled: null },
    },
    {
      label: 'out-of-storage-range totals',
      html: livePage({ enrolled: '2147483648', capacity: '2147483648' }),
      expected: { enrolled: null, capacity: null },
    },
  ])('keeps polling and returns null for $label', ({ html, expected }) => {
    const result = parseClassPage(html, CK);

    expect(isSeatState(result)).toBe(true);
    expect(isParserBroke(result)).toBe(false);
    expect(result).toMatchObject(expected);
  });

  it('keeps strict waitlist parsing while nulling counts too large for storage', () => {
    const result = parseClassPage(
      livePage({ waitlisted: '2147483648', waitlistMax: '2147483648' }),
      CK,
    );

    expect(isSeatState(result)).toBe(true);
    expect(result).toMatchObject({
      status: 'closed',
      waitlistOpen: false,
      waitlisted: null,
      waitlistMax: null,
    });
  });

  it('treats a zero-capacity waitlist as unavailable rather than open', () => {
    const result = parseClassPage(
      livePage({ openSeats: '0', waitlisted: '0', waitlistMax: '0' }),
      CK,
    );
    expect(result).toMatchObject({
      classKey: CK,
      status: 'closed',
      openSeats: 0,
      waitlistOpen: false,
      displayName: null,
      enrolled: null,
      capacity: null,
      waitlisted: 0,
      waitlistMax: 0,
    });
  });

  it('treats a full waitlist as unavailable', () => {
    const result = parseClassPage(
      livePage({ openSeats: '0', waitlisted: '40', waitlistMax: '40' }),
      CK,
    );
    expect(result).toMatchObject({ status: 'closed', waitlistOpen: false });
  });

  it('seats-open wins when seats and a waitlist slot are both available', () => {
    const result = parseClassPage(
      livePage({ openSeats: '2', waitlisted: '39', waitlistMax: '40' }),
      CK,
    );
    expect(result).toMatchObject({ status: 'open', openSeats: 2, waitlistOpen: true });
  });

  it('normalizes a negative open-seat count to zero and emits bounded telemetry', () => {
    const onTelemetry = vi.fn();
    const result = parseClassPage(loadFixture('negative-seats.html'), CK, { onTelemetry });

    expect(result).toMatchObject({
      classKey: CK,
      status: 'closed',
      openSeats: 0,
      waitlistOpen: false,
      displayName: null,
      enrolled: null,
      capacity: null,
      waitlisted: 500,
      waitlistMax: 500,
    });
    expect(onTelemetry).toHaveBeenCalledOnce();
    expect(onTelemetry).toHaveBeenCalledWith({
      event: 'negative-open-seats-normalized',
      classKey: CK,
      observedOpenSeats: -57,
      normalizedOpenSeats: 0,
    });
  });

  it('does not let a broken telemetry adapter change parse truth', () => {
    const result = parseClassPage(loadFixture('negative-seats.html'), CK, {
      onTelemetry: () => {
        throw new Error('metrics backend unavailable');
      },
    });
    expect(isSeatState(result)).toBe(true);
    expect(result).toMatchObject({ status: 'closed', openSeats: 0 });
  });
});

describe('parseClassPage — parser-broke classification', () => {
  it('accepts the storage maximum and rejects a larger Total Open Seats value', () => {
    const atBound = parseClassPage(livePage({ openSeats: String(MAX_OBSERVED_COUNT) }), CK);
    expect(isSeatState(atBound)).toBe(true);
    expect(atBound).toMatchObject({ openSeats: MAX_OBSERVED_COUNT, status: 'open' });

    const aboveBound = parseClassPage(livePage({ openSeats: String(MAX_OBSERVED_COUNT + 1) }), CK);
    expect(isParserBroke(aboveBound)).toBe(true);
    expect(aboveBound).toMatchObject({
      kind: 'parser-broke',
      detail: 'Total Open Seats exceeds the supported count bound',
    });
  });

  it.each([
    ['changed-shape.html', 'shape change'],
    ['duplicate-enrollment-fields.html', 'duplicate label'],
    ['contradictory-waitlist.html', 'contradictory counts'],
    ['identity-mismatch.html', 'page identity mismatch'],
  ])('%s is parser-broke (%s), never a closed SeatState', (fixture) => {
    const result = parseClassPage(loadFixture(fixture), CK);
    expect(isParserBroke(result)).toBe(true);
    expect(isSeatState(result)).toBe(false);
    if (!isParserBroke(result)) return;
    expect(result.classKey).toBe(CK);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail.length).toBeLessThanOrEqual(280);
    expect(result.detail).not.toMatch(/[<>]/);
  });

  it.each([
    ['Total Open Seats', livePage({ openSeats: '' })],
    [
      'Waitlisted',
      `<!doctype html><html><head><link rel="canonical" href="https://classes.berkeley.edu/content/${CK}" /></head><body>
       <section class="current-enrollment"><h3>Current Enrollment</h3>
       <div><strong>Total Open Seats:</strong>0</div><div><strong>Waitlist Max:</strong>0</div>
       </section></body></html>`,
    ],
    [
      'Waitlist Max',
      `<!doctype html><html><head><link rel="canonical" href="https://classes.berkeley.edu/content/${CK}" /></head><body>
       <section class="current-enrollment"><h3>Current Enrollment</h3>
       <div><strong>Total Open Seats:</strong>0</div><div><strong>Waitlisted:</strong>0</div>
       </section></body></html>`,
    ],
  ])('a missing/empty %s field is parser-broke', (_label, html) => {
    expect(isParserBroke(parseClassPage(html, CK))).toBe(true);
  });

  it.each([
    [
      'Total Open Seats',
      livePage({ extraFields: '<div><strong>Total Open Seats:</strong> 1</div>' }),
    ],
    ['Waitlisted', livePage({ extraFields: '<div><strong>Waitlisted:</strong> 1</div>' })],
    ['Waitlist Max', livePage({ extraFields: '<div><strong>Waitlist Max:</strong> 1</div>' })],
  ])('a duplicate %s label is parser-broke', (_label, html) => {
    expect(isParserBroke(parseClassPage(html, CK))).toBe(true);
  });

  it.each([
    ['open seats', { openSeats: '1x' }],
    ['decimal open seats', { openSeats: '1.5' }],
    ['unsafe open seats', { openSeats: '9007199254740992' }],
    ['negative waitlisted', { waitlisted: '-1' }],
    ['decimal waitlist max', { waitlistMax: '10.5' }],
    ['unsafe waitlist max', { waitlistMax: '9007199254740992' }],
  ])('malformed %s is parser-broke', (_case, fields) => {
    expect(isParserBroke(parseClassPage(livePage(fields), CK))).toBe(true);
  });

  it('requires exactly one enrollment region with the correct heading', () => {
    const page = livePage();
    const sectionStart = page.indexOf('<section');
    const sectionEnd = page.indexOf('</section>') + '</section>'.length;
    const duplicateSection = page.slice(sectionStart, sectionEnd);
    expect(
      isParserBroke(parseClassPage(page.replace('</body>', `${duplicateSection}</body>`), CK)),
    ).toBe(true);
    expect(
      isParserBroke(parseClassPage(page.replace('Current Enrollment', 'Enrollment Summary'), CK)),
    ).toBe(true);
  });

  it('requires exactly one canonical identity on the approved origin and path', () => {
    const withoutCanonical = livePage().replace(
      `<link rel="canonical" href="https://classes.berkeley.edu/content/${CK}" />`,
      '',
    );
    const duplicateCanonical = livePage().replace(
      '</head>',
      `<link rel="canonical" href="https://classes.berkeley.edu/content/${CK}" /></head>`,
    );
    const crossOrigin = livePage().replace(
      'https://classes.berkeley.edu/content/',
      'https://example.com/content/',
    );

    for (const html of [withoutCanonical, duplicateCanonical, crossOrigin]) {
      expect(isParserBroke(parseClassPage(html, CK))).toBe(true);
    }
  });
});

describe('isNotFoundPage — soft class-gone recognition', () => {
  it('recognizes the sanitized soft-404 fixture', () => {
    expect(isNotFoundPage(loadFixture('class-not-found.html'))).toBe(true);
  });

  it('does not retire a live class because unrelated copy contains not-found wording', () => {
    const html = livePage().replace(
      '</body>',
      '<footer><p>Page not found help article</p></footer></body>',
    );
    expect(isNotFoundPage(html)).toBe(false);
  });
});
