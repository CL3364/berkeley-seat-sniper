/**
 * Unit tests for normalizeClassKey — spec FR-1, AC-2, §4.
 *
 * Contract: pure + total — never throws, never invents a term, zero-pads section
 * and component numbers to 3 digits. Invalid input → { ok: false }; never a
 * partial or guessed key.
 *
 * Seed cases are drawn from the trace table in src/shared/class-key.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeClassKey,
  CLASS_KEY_PATTERN,
  ClassKeyInputSchema,
  ClassKeySchema,
  TERM_SEASONS,
  CLASS_COMPONENTS,
} from '../../src/shared/class-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the result is a canonical key matching both the pattern and the expected value. */
function expectKey(result: ReturnType<typeof normalizeClassKey>, expected: string): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return; // narrow
  expect(result.key).toBe(expected);
  expect(CLASS_KEY_PATTERN.test(result.key)).toBe(true);
}

function expectFail(
  result: ReturnType<typeof normalizeClassKey>,
  reason?: 'empty' | 'unrecognized-format' | 'invalid-field',
): void {
  expect(result.ok).toBe(false);
  if (!result.ok && reason !== undefined) {
    expect(result.reason).toBe(reason);
  }
}

// ---------------------------------------------------------------------------
// URL inputs
// ---------------------------------------------------------------------------

describe('normalizeClassKey — Berkeley URL inputs', () => {
  it('accepts a full canonical URL and extracts the slug', () => {
    expectKey(
      normalizeClassKey('https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('accepts a URL without a scheme (scheme-less host path)', () => {
    expectKey(
      normalizeClassKey('classes.berkeley.edu/content/2026-spring-compsci-61a-001-lec-001'),
      '2026-spring-compsci-61a-001-lec-001',
    );
  });

  it('accepts a bare content/<slug> path (no host)', () => {
    expectKey(
      normalizeClassKey('content/2026-fall-compsci-189-001-lec-001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('is case-insensitive on the URL content segment', () => {
    expectKey(
      normalizeClassKey('https://classes.berkeley.edu/content/2026-FALL-COMPSCI-189-001-LEC-001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('strips trailing slash from URL', () => {
    expectKey(
      normalizeClassKey('https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001/'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('strips query string from URL', () => {
    expectKey(
      normalizeClassKey(
        'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001?foo=bar',
      ),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('strips hash fragment from URL', () => {
    expectKey(
      normalizeClassKey(
        'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001#section',
      ),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('rejects a URL with a non-canonical content slug — never partial/guessed', () => {
    const result = normalizeClassKey('https://classes.berkeley.edu/content/not-a-valid-key');
    expectFail(result, 'unrecognized-format');
  });

  it('rejects a URL missing content/ segment — not treated as a human code', () => {
    const result = normalizeClassKey(
      'https://classes.berkeley.edu/schedule/2026-fall-compsci-189-001-lec-001',
    );
    expectFail(result);
  });

  it('handles all valid term seasons in URLs', () => {
    for (const season of TERM_SEASONS) {
      expectKey(
        normalizeClassKey(
          `https://classes.berkeley.edu/content/2026-${season}-compsci-189-001-lec-001`,
        ),
        `2026-${season}-compsci-189-001-lec-001`,
      );
    }
  });

  it('handles all valid class components in URLs', () => {
    for (const component of CLASS_COMPONENTS) {
      expectKey(
        normalizeClassKey(
          `https://classes.berkeley.edu/content/2026-fall-compsci-189-001-${component}-001`,
        ),
        `2026-fall-compsci-189-001-${component}-001`,
      );
    }
  });

  it('preserves alphanumeric course suffix in URL (e.g. 61a)', () => {
    expectKey(
      normalizeClassKey('https://classes.berkeley.edu/content/2026-fall-compsci-61a-001-lec-001'),
      '2026-fall-compsci-61a-001-lec-001',
    );
  });
});

// ---------------------------------------------------------------------------
// Human code inputs — fully-qualified (year + season required)
// ---------------------------------------------------------------------------

describe('normalizeClassKey — human code inputs', () => {
  it('accepts a fully-qualified human code: 2026 Fall COMPSCI 189 001 LEC 001', () => {
    expectKey(
      normalizeClassKey('2026 Fall COMPSCI 189 001 LEC 001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('accepts lowercase human code: 2026 fall compsci 61a 1 lec', () => {
    // Section 1 → 001; component number defaults to 001 when omitted.
    expectKey(
      normalizeClassKey('2026 fall compsci 61a 1 lec'),
      '2026-fall-compsci-61a-001-lec-001',
    );
  });

  it('zero-pads section number from 1 to 001', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 1 lec 1'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('zero-pads section number from 01 to 001', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 01 lec 01'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('preserves 3-digit section number as-is', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 003 lec 002'),
      '2026-fall-compsci-189-003-lec-002',
    );
  });

  it('defaults component number to 001 when omitted', () => {
    expectKey(
      normalizeClassKey('2026 Fall COMPSCI 189 001 LEC'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('accepts long-form component "lecture"', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 001 lecture 001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('accepts long-form component "discussion"', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 001 discussion 001'),
      '2026-fall-compsci-189-001-dis-001',
    );
  });

  it('accepts long-form component "laboratory"', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 001 laboratory 001'),
      '2026-fall-compsci-189-001-lab-001',
    );
  });

  it('accepts long-form component "seminar"', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 001 seminar 001'),
      '2026-fall-compsci-189-001-sem-001',
    );
  });

  it('is case-insensitive on season and component in human code', () => {
    expectKey(
      normalizeClassKey('2026 FALL COMPSCI 189 001 LEC 001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('handles hyphen-separated human code', () => {
    expectKey(
      normalizeClassKey('2026-fall-compsci-189-001-lec-001'),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('trims leading/trailing whitespace', () => {
    expectKey(
      normalizeClassKey('  2026 fall compsci 189 001 lec 001  '),
      '2026-fall-compsci-189-001-lec-001',
    );
  });

  it('normalizes a spring-term class', () => {
    expectKey(
      normalizeClassKey('2026 Spring MATH 110 001 LEC 001'),
      '2026-spring-math-110-001-lec-001',
    );
  });

  it('normalizes a summer-term class', () => {
    expectKey(
      normalizeClassKey('2026 Summer EECS 126 001 LEC 001'),
      '2026-summer-eecs-126-001-lec-001',
    );
  });
});

// ---------------------------------------------------------------------------
// Never invents a term
// ---------------------------------------------------------------------------

describe('normalizeClassKey — never invents a term', () => {
  it('rejects a code with no year and no season (COMPSCI 189 LEC 001)', () => {
    // Only 4 tokens — below minimum 6.
    expectFail(normalizeClassKey('COMPSCI 189 LEC 001'), 'unrecognized-format');
  });

  it('rejects a code with a season but no year', () => {
    // Tokens: fall, compsci, 189, 001, lec, 001 → first token "fall" is not a 4-digit year.
    expectFail(normalizeClassKey('fall compsci 189 001 lec 001'), 'unrecognized-format');
  });

  it('rejects a code with a year but no season', () => {
    // Tokens: 2026, compsci, 189, 001, lec, 001 → second token "compsci" is not a known season.
    expectFail(normalizeClassKey('2026 compsci 189 001 lec 001'), 'unrecognized-format');
  });

  it('rejects a code with an unknown season "winter" — never invented', () => {
    expectFail(normalizeClassKey('2026 winter compsci 189 001 lec 001'), 'unrecognized-format');
  });

  it('rejects a code with an unknown season "autumn"', () => {
    expectFail(normalizeClassKey('2026 autumn compsci 189 001 lec 001'), 'unrecognized-format');
  });
});

// ---------------------------------------------------------------------------
// Failure cases — empty and unrecognizable
// ---------------------------------------------------------------------------

describe('normalizeClassKey — failure cases', () => {
  it('returns empty reason for an empty string', () => {
    expectFail(normalizeClassKey(''), 'empty');
  });

  it('returns empty reason for a whitespace-only string', () => {
    expectFail(normalizeClassKey('   '), 'empty');
  });

  it('never throws on non-string input (null cast to any)', () => {
    expect(() => normalizeClassKey(null as any)).not.toThrow();
    const result = normalizeClassKey(null as any);
    expect(result.ok).toBe(false);
  });

  it('never throws on undefined input (cast to any)', () => {
    expect(() => normalizeClassKey(undefined as any)).not.toThrow();
    const result = normalizeClassKey(undefined as any);
    expect(result.ok).toBe(false);
  });

  it('never throws on a number input (cast to any)', () => {
    expect(() => normalizeClassKey(12345 as any)).not.toThrow();
  });

  it('rejects an unknown component token', () => {
    expectFail(normalizeClassKey('2026 fall compsci 189 001 online 001'), 'unrecognized-format');
  });

  it('rejects missing component field', () => {
    // Only 5 tokens: year, season, subject, course, section — missing component.
    expectFail(normalizeClassKey('2026 fall compsci 189 001'), 'unrecognized-format');
  });

  it('rejects extra trailing tokens', () => {
    expectFail(normalizeClassKey('2026 fall compsci 189 001 lec 001 extra'), 'unrecognized-format');
  });

  it('rejects a non-numeric section number', () => {
    expectFail(normalizeClassKey('2026 fall compsci 189 abc lec 001'), 'invalid-field');
  });

  it('rejects a section number > 3 digits', () => {
    // 4-digit section fails the \d{1,3} check.
    expectFail(normalizeClassKey('2026 fall compsci 189 0001 lec 001'), 'invalid-field');
  });

  it('rejects a non-content URL with a malformed content segment', () => {
    expectFail(
      normalizeClassKey('https://classes.berkeley.edu/content/bad slug here'),
      'unrecognized-format',
    );
  });

  it('returns unrecognized-format for a random string', () => {
    expectFail(normalizeClassKey('not a class at all'), 'unrecognized-format');
  });
});

// ---------------------------------------------------------------------------
// Zero-padding guarantee — exhaustive spot-checks
// ---------------------------------------------------------------------------

describe('normalizeClassKey — zero-padding guarantee', () => {
  it('pads section 1 to 001 and component-num 1 to 001', () => {
    const r = normalizeClassKey('2026 fall compsci 189 1 lec 1');
    expectKey(r, '2026-fall-compsci-189-001-lec-001');
  });

  it('pads section 10 to 010 and component-num 2 to 002', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 10 lec 2'),
      '2026-fall-compsci-189-010-lec-002',
    );
  });

  it('preserves already-3-digit numbers unchanged', () => {
    expectKey(
      normalizeClassKey('2026 fall compsci 189 100 lec 100'),
      '2026-fall-compsci-189-100-lec-100',
    );
  });
});

// ---------------------------------------------------------------------------
// URL and code for the same class produce identical canonical keys
// ---------------------------------------------------------------------------

describe('normalizeClassKey — URL and code collapse to one canonical key', () => {
  const cases: Array<[string, string]> = [
    [
      'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
      '2026 Fall COMPSCI 189 001 LEC 001',
    ],
    [
      'https://classes.berkeley.edu/content/2026-spring-compsci-61a-001-lec-001',
      '2026 spring COMPSCI 61a 1 lec 1',
    ],
    ['content/2026-summer-math-110-001-dis-002', '2026 Summer MATH 110 001 DIS 002'],
  ];

  for (const [url, code] of cases) {
    it(`URL "${url}" and code "${code}" yield the same key`, () => {
      const r1 = normalizeClassKey(url);
      const r2 = normalizeClassKey(code);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.key).toBe(r2.key);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ClassKeySchema (strict schema — already canonical inputs only)
// ---------------------------------------------------------------------------

describe('ClassKeySchema — already-canonical inputs', () => {
  it('accepts a valid canonical key', () => {
    const result = ClassKeySchema.safeParse('2026-fall-compsci-189-001-lec-001');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('2026-fall-compsci-189-001-lec-001');
    }
  });

  it('rejects an uppercase canonical key (not canonical)', () => {
    const result = ClassKeySchema.safeParse('2026-FALL-COMPSCI-189-001-LEC-001');
    expect(result.success).toBe(false);
  });

  it('rejects a key with a missing segment', () => {
    const result = ClassKeySchema.safeParse('2026-fall-compsci-189-001-lec');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = ClassKeySchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects a key with an unknown season', () => {
    const result = ClassKeySchema.safeParse('2026-winter-compsci-189-001-lec-001');
    expect(result.success).toBe(false);
  });

  it('rejects a key with an unknown component', () => {
    const result = ClassKeySchema.safeParse('2026-fall-compsci-189-001-online-001');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClassKeyInputSchema (normalizing schema — accepts raw URL or code)
// ---------------------------------------------------------------------------

describe('ClassKeyInputSchema — normalizes URL and code to canonical key', () => {
  it('normalizes a URL to a canonical key', () => {
    const result = ClassKeyInputSchema.safeParse(
      'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('2026-fall-compsci-189-001-lec-001');
      expect(CLASS_KEY_PATTERN.test(result.data)).toBe(true);
    }
  });

  it('normalizes a human code to the same canonical key as the URL', () => {
    const urlResult = ClassKeyInputSchema.safeParse(
      'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001',
    );
    const codeResult = ClassKeyInputSchema.safeParse('2026 Fall COMPSCI 189 001 LEC 001');
    expect(urlResult.success).toBe(true);
    expect(codeResult.success).toBe(true);
    if (urlResult.success && codeResult.success) {
      expect(urlResult.data).toBe(codeResult.data);
    }
  });

  it('fails validation for an unrecognizable input (AC-2)', () => {
    const result = ClassKeyInputSchema.safeParse('not a class');
    expect(result.success).toBe(false);
  });

  it('fails validation for an empty string (AC-2)', () => {
    const result = ClassKeyInputSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('fails validation for input missing a term (no invented term)', () => {
    const result = ClassKeyInputSchema.safeParse('COMPSCI 189 LEC 001');
    expect(result.success).toBe(false);
  });

  it('fails validation for unknown season "winter"', () => {
    const result = ClassKeyInputSchema.safeParse('2026 winter compsci 189 001 lec 001');
    expect(result.success).toBe(false);
  });
});
