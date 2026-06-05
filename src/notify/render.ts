import type { NotifyEvent } from '../shared/seat-state';

/**
 * Rendered email for a seat-open event. Subject and plain-text body only — no
 * HTML injection risk since we never interpolate raw page content (constitution:
 * treat fetched data as untrusted). Values come from the typed NotifyEvent, not
 * from any external string.
 */
export interface RenderedEmail {
  subject: string;
  body: string;
}

/** Render the subject and body for a subscriber seat-open notification. */
export function renderSeatOpenEmail(event: NotifyEvent): RenderedEmail {
  const { classKey, openSeats, reason } = event;

  const reasonLabel = reason === 'seats-open' ? 'open seats' : 'waitlist movement';

  const subject = `Seat alert: ${classKey} has ${reasonLabel}`;

  const body = [
    `Good news — ${classKey} now shows availability.`,
    '',
    reason === 'seats-open'
      ? `Open seats: ${openSeats}`
      : `Waitlist movement detected (open seats: ${openSeats})`,
    '',
    `Check the class page now:`,
    `https://classes.berkeley.edu/content/${classKey}`,
    '',
    '---',
    'You received this alert from Berkeley Seat Sniper because you are watching',
    `the class above. To manage your watches or unsubscribe, use the link that`,
    'was included in your original subscription confirmation email.',
    '',
    'This is an automated notify-only service. It does not enroll you.',
  ].join('\n');

  return { subject, body };
}

/** Render a short operator-facing alert body for a parser-broke incident. */
export function renderOperatorAlert(classKey: string, detail: string): RenderedEmail {
  return {
    subject: `[OPERATOR] parser-broke: ${classKey}`,
    body: [
      `The parser for ${classKey} could no longer read the class page.`,
      '',
      `Detail: ${detail}`,
      '',
      'No subscriber notifications were sent for this cycle.',
      'Investigate and update the scraper if the upstream HTML changed.',
    ].join('\n'),
  };
}
