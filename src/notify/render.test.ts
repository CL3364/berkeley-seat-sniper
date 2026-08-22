/**
 * Alert-copy tests (FR-27).
 *
 * The seat-open email is the highest-stakes output in the product — it is the only
 * thing a Subscriber actually receives — and before this file it had NO coverage at
 * all. What it says about reserved seats decides whether a student rearranges their
 * schedule for a seat they cannot take.
 */
import { describe, expect, it } from 'vitest';

import type { ClassKey } from '../shared/class-key';
import type { NotifyEvent } from '../shared/seat-state';

import { renderSeatOpenEmail } from './render';

const BASE: NotifyEvent = {
  subscriberId: 'sub_test',
  email: 'oski@example.com',
  classKey: '2026-fall-compsci-189-001-lec-001' as ClassKey,
  reason: 'seats-open',
  openSeats: 41,
  openedAt: '2026-08-21T22:19:15.592Z',
};

describe('renderSeatOpenEmail — reserved-seat disclosure', () => {
  it('says ALL seats are reserved when openReserved covers openSeats', () => {
    // The exact shape observed live on 2026-08-21: 41 open, 41 reserved.
    const { body } = renderSeatOpenEmail({ ...BASE, openReserved: 41 });

    expect(body).toContain('ALL 41 of those seats are RESERVED');
    expect(body).toContain('you will not be able to take them');
    // Must not also emit the hedging variant.
    expect(body).not.toContain('did not say how many are');
  });

  it('names the split when only some seats are reserved', () => {
    const { body } = renderSeatOpenEmail({ ...BASE, openSeats: 10, openReserved: 3 });

    expect(body).toContain('3 of those 10 seats are RESERVED');
    expect(body).toContain('only the remainder are generally available');
    expect(body).not.toContain('ALL 10');
  });

  it('keeps the generic caveat when the page published no reserved line', () => {
    // null is NOT "none reserved" — it is "unknown". Claiming zero would assert
    // something never observed.
    const { body } = renderSeatOpenEmail({ ...BASE, openReserved: null });

    expect(body).toContain('did not say how many are');
    expect(body).not.toContain('RESERVED for a specific');
  });

  it('treats an absent field exactly like null', () => {
    const { body } = renderSeatOpenEmail(BASE);

    expect(body).toContain('did not say how many are');
  });

  it('distinguishes OBSERVED zero from unknown — zero must not hedge', () => {
    // I originally collapsed 0 into the null branch and wrote a test asserting it,
    // which enshrined the bug. They are different facts: null means the page was
    // silent, 0 means the page told us none are reserved. Hedging on an observed
    // zero understates what we actually learned.
    const { body } = renderSeatOpenEmail({ ...BASE, openReserved: 0 });

    expect(body).not.toContain('did not say how many are');
    expect(body).not.toContain('RESERVED');
    expect(body).not.toContain('0 of those');
    // The alert itself is unaffected.
    expect(body).toContain('Open seats: 41');
  });

  it('never renders a reservation-group name, which is untrusted third-party text', () => {
    const { body } = renderSeatOpenEmail({ ...BASE, openReserved: 41 });

    // Only the count crosses the boundary. The group description lives on a page
    // we do not control and must never reach an outbound email.
    expect(body).not.toMatch(/Students with Enrollment Permission/i);
  });

  it('still alerts for a fully-reserved opening — FR-27 does not gate alerting', () => {
    const { subject, body } = renderSeatOpenEmail({ ...BASE, openReserved: 41 });

    expect(subject).toBeTruthy();
    expect(body).toContain('Open seats: 41');
    expect(body).toContain('classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001');
  });
});
