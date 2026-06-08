/**
 * Unit tests for ParseResult discriminated union — spec FR-6, AC-5.
 *
 * Covers:
 *   - isParserBroke / isSeatState narrowing helpers
 *   - A parser-broke value is NEVER mistaken for a SeatState (structural
 *     disjointness — the two arms cannot masquerade as each other)
 *   - ParseResultSchema accepts/rejects both arms correctly
 *   - SeatState and ParserBroke schema validation
 */

import { describe, it, expect } from 'vitest';
import {
  isParserBroke,
  isSeatState,
  ParseResultSchema,
  SeatStateSchema,
  ParserBrokeSchema,
  PARSER_BROKE,
  SEAT_STATUSES,
  SeatStatusSchema,
} from '../../src/shared/seat-state';
import type { ParseResult, SeatState, ParserBroke } from '../../src/shared/seat-state';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeSeatState(overrides?: Partial<SeatState>): SeatState {
  return {
    classKey: '2026-fall-compsci-189-001-lec-001' as SeatState['classKey'],
    status: 'open',
    openSeats: 3,
    waitlistOpen: false,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeParserBroke(overrides?: Partial<ParserBroke>): ParserBroke {
  return {
    kind: PARSER_BROKE,
    classKey: '2026-fall-compsci-189-001-lec-001' as ParserBroke['classKey'],
    detail: 'seat-count node not found',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isParserBroke narrowing
// ---------------------------------------------------------------------------

describe('isParserBroke', () => {
  it('returns true for a parser-broke value', () => {
    const pb: ParseResult = makeParserBroke();
    expect(isParserBroke(pb)).toBe(true);
  });

  it('returns false for a SeatState value', () => {
    const ss: ParseResult = makeSeatState();
    expect(isParserBroke(ss)).toBe(false);
  });

  it('narrows type correctly — can access kind on parser-broke arm', () => {
    const result: ParseResult = makeParserBroke();
    if (isParserBroke(result)) {
      // TypeScript narrows to ParserBroke here; kind must be the literal.
      expect(result.kind).toBe(PARSER_BROKE);
      expect(result.detail).toBeDefined();
    } else {
      // Should not reach this branch in this test.
      expect.fail('Expected parser-broke, got SeatState');
    }
  });

  it('returns false for all SeatState status variants', () => {
    for (const status of SEAT_STATUSES) {
      const ss: ParseResult = makeSeatState({ status });
      expect(isParserBroke(ss)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isSeatState narrowing
// ---------------------------------------------------------------------------

describe('isSeatState', () => {
  it('returns true for a SeatState value', () => {
    const ss: ParseResult = makeSeatState();
    expect(isSeatState(ss)).toBe(true);
  });

  it('returns false for a parser-broke value', () => {
    const pb: ParseResult = makeParserBroke();
    expect(isSeatState(pb)).toBe(false);
  });

  it('narrows type correctly — can access status on SeatState arm', () => {
    const result: ParseResult = makeSeatState({ status: 'open', openSeats: 5 });
    if (isSeatState(result)) {
      expect(result.status).toBe('open');
      expect(result.openSeats).toBe(5);
    } else {
      expect.fail('Expected SeatState, got parser-broke');
    }
  });

  it('returns true for all SeatState status variants', () => {
    for (const status of SEAT_STATUSES) {
      const ss: ParseResult = makeSeatState({ status });
      expect(isSeatState(ss)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isParserBroke and isSeatState are strict opposites
// ---------------------------------------------------------------------------

describe('isParserBroke / isSeatState — mutual exclusion', () => {
  it('exactly one of {isParserBroke, isSeatState} is true for any ParseResult', () => {
    const values: ParseResult[] = [
      makeSeatState({ status: 'open' }),
      makeSeatState({ status: 'waitlist' }),
      makeSeatState({ status: 'closed' }),
      makeParserBroke(),
      makeParserBroke({ detail: 'unexpected DOM structure' }),
    ];
    for (const v of values) {
      const pb = isParserBroke(v);
      const ss = isSeatState(v);
      expect(pb !== ss).toBe(true); // XOR: exactly one is true
    }
  });

  it('a parser-broke value has no status field — cannot masquerade as SeatState', () => {
    const pb = makeParserBroke();
    // isSeatState is false, so the status property must not exist meaningfully.
    expect(isSeatState(pb)).toBe(false);
    // TypeScript guard ensures we cannot access pb.status without narrowing.
    // At runtime we verify there is no status property on the parser-broke shape.
    expect('status' in pb).toBe(false);
  });

  it('a SeatState value has no kind field — cannot masquerade as ParserBroke', () => {
    const ss = makeSeatState();
    expect(isParserBroke(ss)).toBe(false);
    expect('kind' in ss).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ParseResultSchema — accepts both arms, rejects invalid values
// ---------------------------------------------------------------------------

describe('ParseResultSchema', () => {
  it('accepts a valid SeatState (status=open)', () => {
    const result = ParseResultSchema.safeParse(makeSeatState({ status: 'open', openSeats: 2 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isSeatState(result.data)).toBe(true);
    }
  });

  it('accepts a valid SeatState (status=waitlist)', () => {
    const result = ParseResultSchema.safeParse(
      makeSeatState({ status: 'waitlist', waitlistOpen: true }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a valid SeatState (status=closed)', () => {
    const result = ParseResultSchema.safeParse(makeSeatState({ status: 'closed', openSeats: 0 }));
    expect(result.success).toBe(true);
  });

  it('accepts a valid ParserBroke', () => {
    const result = ParseResultSchema.safeParse(makeParserBroke());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isParserBroke(result.data)).toBe(true);
    }
  });

  it('rejects an empty object', () => {
    expect(ParseResultSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a value with no classKey', () => {
    expect(
      ParseResultSchema.safeParse({
        status: 'open',
        openSeats: 0,
        waitlistOpen: false,
        fetchedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });

  it('rejects a SeatState with a non-canonical classKey', () => {
    expect(
      ParseResultSchema.safeParse(makeSeatState({ classKey: 'COMPSCI 189' as any })).success,
    ).toBe(false);
  });

  it('rejects a ParserBroke with a non-canonical classKey', () => {
    expect(
      ParseResultSchema.safeParse(makeParserBroke({ classKey: 'BAD KEY' as any })).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SeatStateSchema — field-level validation
// ---------------------------------------------------------------------------

describe('SeatStateSchema', () => {
  it('accepts a complete valid SeatState', () => {
    const result = SeatStateSchema.safeParse(makeSeatState());
    expect(result.success).toBe(true);
  });

  it('rejects a negative openSeats count', () => {
    const result = SeatStateSchema.safeParse(makeSeatState({ openSeats: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer openSeats (float)', () => {
    const result = SeatStateSchema.safeParse(makeSeatState({ openSeats: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('accepts openSeats = 0 (closed class)', () => {
    const result = SeatStateSchema.safeParse(makeSeatState({ status: 'closed', openSeats: 0 }));
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = SeatStateSchema.safeParse(makeSeatState({ status: 'unknown' as any }));
    expect(result.success).toBe(false);
  });

  it('rejects a malformed fetchedAt (not ISO-8601)', () => {
    const result = SeatStateSchema.safeParse(makeSeatState({ fetchedAt: 'not-a-date' }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid SeatStatus values', () => {
    for (const status of SEAT_STATUSES) {
      const result = SeatStateSchema.safeParse(makeSeatState({ status }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing waitlistOpen field', () => {
    const { waitlistOpen: _omit, ...rest } = makeSeatState();
    expect(SeatStateSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ParserBrokeSchema — field-level validation
// ---------------------------------------------------------------------------

describe('ParserBrokeSchema', () => {
  it('accepts a complete valid ParserBroke', () => {
    const result = ParserBrokeSchema.safeParse(makeParserBroke());
    expect(result.success).toBe(true);
  });

  it('rejects an empty detail string', () => {
    const result = ParserBrokeSchema.safeParse(makeParserBroke({ detail: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects a detail string longer than 280 characters', () => {
    const result = ParserBrokeSchema.safeParse(makeParserBroke({ detail: 'x'.repeat(281) }));
    expect(result.success).toBe(false);
  });

  it('accepts a detail string of exactly 280 characters', () => {
    const result = ParserBrokeSchema.safeParse(makeParserBroke({ detail: 'x'.repeat(280) }));
    expect(result.success).toBe(true);
  });

  it('rejects a wrong kind literal', () => {
    const result = ParserBrokeSchema.safeParse({
      ...makeParserBroke(),
      kind: 'parser-ok', // wrong literal
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing kind field', () => {
    const { kind: _omit, ...rest } = makeParserBroke();
    expect(ParserBrokeSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing classKey field', () => {
    const { classKey: _omit, ...rest } = makeParserBroke();
    expect(ParserBrokeSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing detail field', () => {
    const { detail: _omit, ...rest } = makeParserBroke();
    expect(ParserBrokeSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SeatStatusSchema — standalone
// ---------------------------------------------------------------------------

describe('SeatStatusSchema', () => {
  it('accepts "open"', () => expect(SeatStatusSchema.safeParse('open').success).toBe(true));
  it('accepts "waitlist"', () => expect(SeatStatusSchema.safeParse('waitlist').success).toBe(true));
  it('accepts "closed"', () => expect(SeatStatusSchema.safeParse('closed').success).toBe(true));
  it('rejects "unknown"', () => expect(SeatStatusSchema.safeParse('unknown').success).toBe(false));
  it('rejects ""', () => expect(SeatStatusSchema.safeParse('').success).toBe(false));
  it('rejects null', () => expect(SeatStatusSchema.safeParse(null).success).toBe(false));
});

// ---------------------------------------------------------------------------
// PARSER_BROKE constant integrity
// ---------------------------------------------------------------------------

describe('PARSER_BROKE constant', () => {
  it('equals the literal string "parser-broke"', () => {
    expect(PARSER_BROKE).toBe('parser-broke');
  });

  it('a ParserBroke created with the constant matches kind checks', () => {
    const pb = makeParserBroke();
    expect(pb.kind).toBe(PARSER_BROKE);
    expect(pb.kind === 'parser-broke').toBe(true);
  });
});
