import { describe, expect, it } from 'vitest';

import { readSourceCapacityConfig } from './repo';

describe('source-capacity configuration', () => {
  it('keeps the bounded default at one request per second and 96 unique Sections', () => {
    expect(readSourceCapacityConfig({})).toEqual({
      requestsPerSecond: 1,
      visibleTargetSeconds: 120,
      maxUniqueSections: 96,
    });
  });

  it.each(['1.000001', '2', '1000'])(
    'rejects a SOURCE_REQUESTS_PER_SECOND ceiling above one (%s)',
    (requestsPerSecond) => {
      expect(() =>
        readSourceCapacityConfig({
          SOURCE_REQUESTS_PER_SECOND: requestsPerSecond,
          SOURCE_VISIBLE_TARGET_SECONDS: '1',
        }),
      ).toThrow(/SOURCE_REQUESTS_PER_SECOND must be no greater than 1/);
    },
  );

  it.each(['0', '-0.1', 'NaN', 'Infinity'])(
    'rejects a non-finite or non-positive SOURCE_REQUESTS_PER_SECOND value (%s)',
    (requestsPerSecond) => {
      expect(() =>
        readSourceCapacityConfig({
          SOURCE_REQUESTS_PER_SECOND: requestsPerSecond,
        }),
      ).toThrow(/SOURCE_REQUESTS_PER_SECOND must be a positive number/);
    },
  );

  it('accepts a fractional 1/60 request-per-second ceiling and computes one slot', () => {
    const requestsPerSecond = 1 / 60;

    expect(
      readSourceCapacityConfig({
        SOURCE_REQUESTS_PER_SECOND: String(requestsPerSecond),
        SOURCE_VISIBLE_TARGET_SECONDS: '120',
      }),
    ).toEqual({
      requestsPerSecond,
      visibleTargetSeconds: 120,
      maxUniqueSections: 1,
    });
  });

  it('fails closed when a valid fractional rate yields zero unique-Section capacity', () => {
    expect(() =>
      readSourceCapacityConfig({
        SOURCE_REQUESTS_PER_SECOND: String(1 / 120),
        SOURCE_VISIBLE_TARGET_SECONDS: '120',
      }),
    ).toThrow(/SOURCE_REQUESTS_PER_SECOND and SOURCE_VISIBLE_TARGET_SECONDS yield zero capacity/);
  });
});
