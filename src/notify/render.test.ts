/**
 * Alert-copy tests (FR-27, FR-28).
 *
 * The seat-open email is the highest-stakes output in the product — it is the only
 * thing a Subscriber actually receives — and before this file it had NO coverage at
 * all. What it says about reserved seats decides whether a student rearranges their
 * schedule for a seat they cannot take.
 *
 * The Blind-window email is the second thing a Subscriber receives, and the only
 * one sent in the absence of an Opening. What it says decides whether a student
 * keeps trusting a silence the system did not earn.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ClassKey } from '../shared/class-key';
import type { NotifyEvent } from '../shared/seat-state';

import { renderBlindWindowEmail, renderSeatOpenEmail } from './render';

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

describe('renderBlindWindowEmail — blind-window disclosure (FR-28)', () => {
  const LAST_READ = new Date('2026-08-25T06:14:09.000Z');
  const MANAGE_URL = 'https://seatsniper.example.com/?token=manage-token';

  const render = (): { subject: string; body: string } =>
    renderBlindWindowEmail({ classKey: BASE.classKey, lastReadAt: LAST_READ }, MANAGE_URL);

  it('names the class in both the subject and the body', () => {
    const { subject, body } = render();

    expect(subject).toContain('2026-fall-compsci-189-001-lec-001');
    expect(body).toContain('2026-fall-compsci-189-001-lec-001');
  });

  it('states when the class was last successfully read', () => {
    // Without this the reader cannot size the gap, and a disclosure delivered
    // late would be indistinguishable from one delivered on time.
    expect(render().body).toContain('Last successful read: 2026-08-25T06:14:09.000Z (UTC)');
  });

  it('says outright that silence is not currently evidence', () => {
    // The whole point of the email. A softer phrasing ("we may be delayed")
    // leaves the Subscriber free to keep reading silence as "no seat opened".
    const { body } = render();

    expect(body).toContain('not watching that class at the moment');
    expect(body).toContain('Silence about this class is not currently evidence that nothing');
  });

  it('tells the reader to check Berkeley directly, with the page link', () => {
    const { body } = render();

    expect(body).toContain('check the page yourself');
    expect(body).toContain('classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001');
  });

  it('carries the best-effort caveat inline', () => {
    // ADR 0010 puts pilot expectation-setting in the personal invitation, which
    // is not durable. This email is the only place the caveat survives, so it
    // must appear at the moment it actually matters.
    const { body } = render();

    expect(body).toContain('run by one person');
    expect(body).toContain('Nobody is woken up');
    expect(body).toContain('may not be looked at until the morning');
  });

  it('promises no follow-up, matching the once-per-window rule', () => {
    // The copy must not imply a second email will arrive when the code
    // guarantees it will not.
    expect(render().body).toContain('no further email about this particular gap');
  });

  it('scopes the warning to this class only', () => {
    // A Blind window is per-Section. Reading it as a service-wide outage would
    // make a Subscriber abandon watches that are working fine.
    expect(render().body).toContain('Your other watched classes are unaffected');
  });

  it('never claims a seat count or an opening', () => {
    // We could not read the page, so we know nothing about seats. Any number
    // here would be fabricated, and the word "alert" would misfile it as news.
    const { subject, body } = render();

    expect(body).not.toMatch(/Open seats:/);
    expect(body).not.toMatch(/\bwaitlist movement\b/i);
    expect(subject).not.toMatch(/^Seat alert:/);
  });

  it('never leaks a reservation group, an address, or third-party page text', () => {
    // Same boundary as the Alert: only the class key and a timestamp we
    // generated may cross it. The scraper's failure `detail` is Operator-facing
    // and derived from a page we do not control.
    const { subject, body } = render();
    const rendered = `${subject}\n${body}`;

    expect(rendered).not.toMatch(/Students with Enrollment Permission/i);
    expect(rendered).not.toMatch(/@berkeley\.edu/);
    expect(rendered).not.toMatch(/parser-broke|robots\.txt|Total Open Seats/i);
  });

  it('renders the manage link on its own line via the shared footer', () => {
    const lines = render().body.split('\n');

    expect(lines).toContain(MANAGE_URL);
    expect(render().body).toContain('never asks for your CalNet login or password');
  });

  it('still renders without a manage link', () => {
    const { body } = renderBlindWindowEmail({
      classKey: BASE.classKey,
      lastReadAt: LAST_READ,
    });

    expect(body).toContain('Last successful read: 2026-08-25T06:14:09.000Z (UTC)');
    expect(body).not.toContain('?token=');
  });

  it('depends on no clock, so a retry hours later renders a byte-identical body', () => {
    // The dispatcher re-renders on every retry. A body that moved with the
    // current time would make the provider see a different message under one
    // idempotency key. Rendering twice in the same tick would prove nothing —
    // `new Date()` is identical then too — so move the clock between renders.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T07:00:00.000Z'));
      const first = render();
      vi.setSystemTime(new Date('2026-08-25T19:30:00.000Z'));
      const second = render();

      expect(second).toEqual(first);
      // And the only timestamp in the body is the one we were handed.
      expect(second.body.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)).toEqual([LAST_READ.toISOString()]);
    } finally {
      vi.useRealTimers();
    }
  });
});
