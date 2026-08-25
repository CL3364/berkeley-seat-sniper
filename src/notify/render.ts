import { classPageUrl, type ClassKey } from '../shared/class-key';
import type { NotifyEvent } from '../shared/seat-state';

/**
 * Rendered email (subject + plain-text body). No HTML-injection risk: we never
 * interpolate raw fetched page content (constitution: treat fetched data as
 * untrusted). Values come from typed inputs (NotifyEvent / a token we minted),
 * never from an external string.
 *
 * Link rendering (spec §4 pinned formats): confirmation and manage-link bodies
 * render their absolute URL ON ITS OWN LINE so tests can extract it from the
 * noop outbox with a simple regex.
 */
export interface RenderedEmail {
  subject: string;
  body: string;
}

/**
 * Footer shared by every subscriber-facing email (manage link + service note).
 * The manage URL is rendered ON ITS OWN LINE so tests can extract it by regex.
 * When `manageUrl` is absent (no token supplied at fan-out), the footer omits
 * the link line but still carries the service note.
 */
function subscriberFooter(manageUrl?: string): string[] {
  return [
    '---',
    'You received this from Berkeley Seat Sniper because you confirmed an email',
    'subscription to watch one or more classes. To view or remove your watches,',
    'or to unsubscribe, open your manage page:',
    ...(manageUrl ? [manageUrl] : []),
    '',
    'This is an automated notify-only service. It does not enroll you, and it',
    'never asks for your CalNet login or password.',
  ];
}

/**
 * Render a subscriber seat-open / waitlist Alert (outbox kind `'alert'`).
 *
 * Includes the reserved-seat caveat (ADR 0006 accepted mitigation / audit M7):
 * v1 cannot tell a General Seat from a Reserved Seat, so an open seat may not be
 * enrollable by everyone — say so honestly.
 *
 * @param event     the typed opening to alert on.
 * @param manageUrl the subscriber's manage link (`${APP_BASE_URL}/?token=...`),
 *                  rendered in the footer so alert mail also carries the real
 *                  double-opt-in manage/unsubscribe path (fixes audit N11 — no
 *                  more reference to a non-existent "confirmation email" link).
 *                  Optional: omitted when no manage token is supplied at
 *                  fan-out (the alert still delivers, sans footer link).
 */
export function renderSeatOpenEmail(event: NotifyEvent, manageUrl?: string): RenderedEmail {
  const { classKey, openSeats, reason, openReserved } = event;

  // FR-27. The page publishes how many open seats are reserved for a Reservation
  // Group, so say it instead of hedging. A live page on 2026-08-21 showed 41 open
  // seats of which 41 were reserved — "Open seats: 41" alone would send a student
  // to a page where nothing is takeable. `null`/absent means the page published no
  // reserved line, which is NOT "none reserved", so we keep the generic caveat.
  // Only the COUNT crosses this boundary; the group name is untrusted third-party
  // text and is never rendered into an email.
  const reservedLines =
    openReserved === 0
      ? // OBSERVED zero. The page said so, so there is nothing to warn about and
        // nothing to hedge — every open seat is generally available. Emitting the
        // "we don't know" caveat here would understate what we actually learned.
        []
      : openReserved === null || openReserved === undefined
        ? [
            'Note: some seats are reserved for specific student groups (a major, a class',
            'standing, first-years, transfers, and so on) and may not be enrollable for',
            'everyone, even when they show as open. This page did not say how many are',
            'reserved, so confirm your eligibility on the page above.',
          ]
        : openSeats > 0 && openReserved >= openSeats
          ? [
              `Heads up: ALL ${openSeats} of those seats are RESERVED for a specific student`,
              'group (a major, a class standing, enrollment permission, and so on). If you are',
              'not in that group you will not be able to take them. Check the page above before',
              'rearranging your schedule.',
            ]
          : [
              `Heads up: ${openReserved} of those ${openSeats} seats are RESERVED for a specific`,
              'student group, so only the remainder are generally available. Confirm your',
              'eligibility on the page above.',
            ];

  const reasonLabel = reason === 'seats-open' ? 'open seats' : 'waitlist movement';
  const subject = `Seat alert: ${classKey} has ${reasonLabel}`;

  const body = [
    `Good news — ${classKey} now shows availability.`,
    '',
    reason === 'seats-open'
      ? `Open seats: ${openSeats}`
      : `Waitlist movement detected (open seats: ${openSeats})`,
    '',
    'Check the class page now:',
    classPageUrl(classKey),
    '',
    ...reservedLines,
    '',
    ...subscriberFooter(manageUrl),
  ].join('\n');

  return { subject, body };
}

/**
 * Render the CONFIRMATION email (outbox kind `'confirmation'`). Carries the
 * confirm link `${APP_BASE_URL}/?confirm=<token>` on its own line. Sent on
 * subscribe and on resend-while-Pending. Double opt-in: only after the
 * subscriber follows this link and confirms do they become eligible for Alerts.
 *
 * @param confirmUrl absolute confirm link, already built (`?confirm=<token>`).
 */
export function renderConfirmationEmail(confirmUrl: string): RenderedEmail {
  const subject = 'Confirm your Berkeley Seat Sniper subscription';

  const body = [
    'Almost there — confirm to start watching.',
    '',
    'Someone (hopefully you) asked Berkeley Seat Sniper to alert this address when',
    'a watched class opens up. To start receiving alerts, confirm your subscription:',
    confirmUrl,
    '',
    'You will not receive any seat alerts until you confirm. If you did not request',
    'this, you can ignore this email and nothing further will be sent.',
    '',
    'This is an automated notify-only service. It does not enroll you, and it never',
    'asks for your CalNet login or password.',
  ].join('\n');

  return { subject, body };
}

/**
 * Render the MANAGE-LINK email (outbox kind `'manage-link'`). Carries the manage
 * link `${APP_BASE_URL}/?token=<token>` on its own line. Sent on
 * resend-while-Confirmed (the non-enumerating "email me my manage link" flow).
 *
 * @param manageUrl absolute manage link (`?token=<token>`).
 */
export function renderManageLinkEmail(manageUrl: string): RenderedEmail {
  const subject = 'Your Berkeley Seat Sniper manage link';

  const body = [
    'Here is your manage link.',
    '',
    'Use the link below to view, add, or remove the classes you are watching, to',
    'turn browser push on or off, or to unsubscribe. It is the only way in — there',
    'is no password and no account.',
    manageUrl,
    '',
    'If you did not request this link, you can ignore this email; it grants access',
    'only to the inbox it was sent to.',
    '',
    'This is an automated notify-only service. It does not enroll you, and it never',
    'asks for your CalNet login or password.',
  ].join('\n');

  return { subject, body };
}

/**
 * Render the BLIND-WINDOW disclosure (outbox kind `'blind-window'`, FR-28).
 *
 * The one email a Subscriber receives in the ABSENCE of an Opening. ADR 0010
 * accepts that a single best-effort Operator guarantees windows where nothing is
 * watched; this is the honesty rule that keeps such a window from reading as
 * "no Opening happened." It is also the ONLY signal a Subscriber will get for
 * that gap: after an hour unread, the recovering parse re-baselines instead of
 * firing a transition, so an Opening that came and went inside the window is
 * never alerted retroactively.
 *
 * Written to stay TRUE if it is delivered late. It names the last successful
 * read instead of a duration, so a reader can judge the gap themselves, and it
 * never claims the window is still open beyond the present tense the send
 * justified. Nothing here depends on the current time, so a retry renders a
 * byte-identical body.
 *
 * BOUNDARY: only the class key and a timestamp we generated cross into this
 * body. No seat counts (we have none — that is the point), no reservation-group
 * name, no scraper `detail`, no third-party page text, and no reason for the
 * failure: those originate on a page we do not control and are Operator-facing.
 *
 * @param input.classKey   the Section that cannot be read.
 * @param input.lastReadAt when that Section was last successfully read — the
 *                         moment the Blind window opened.
 * @param manageUrl        the Subscriber's manage link for the footer, minted by
 *                         the dispatcher at send time. Optional, exactly as for
 *                         an Alert.
 */
export function renderBlindWindowEmail(
  input: { classKey: ClassKey; lastReadAt: Date },
  manageUrl?: string,
): RenderedEmail {
  const { classKey, lastReadAt } = input;

  const subject = `Seat Sniper is not watching ${classKey} right now`;

  const body = [
    `Berkeley Seat Sniper has not been able to read ${classKey} since the time`,
    'below, so it is not watching that class at the moment.',
    '',
    `Last successful read: ${lastReadAt.toISOString()} (UTC)`,
    '',
    'If a seat opened after that, we did not see it and you did not hear from us.',
    'Silence about this class is not currently evidence that nothing happened.',
    'Your other watched classes are unaffected unless we email you about them.',
    '',
    'If you are counting on this class, check the page yourself:',
    classPageUrl(classKey),
    '',
    'We keep retrying. Watching resumes on its own as soon as the page can be',
    'read again, and you will get no further email about this particular gap,',
    'however long it lasts.',
    '',
    'One thing worth saying plainly: this service is run by one person on a',
    'best-effort basis. Nobody is woken up for a problem like this, so one that',
    'starts overnight may not be looked at until the morning. Please keep your',
    'own backup plan for a class you actually need.',
    '',
    ...subscriberFooter(manageUrl),
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

/**
 * Render a generic durable Operator job. Parser incidents retain the established
 * class-specific template; queue/provider incidents without a class use a
 * neutral service-alert template.
 */
export function renderOperatorEmail(classKey: string | null, detail: string): RenderedEmail {
  if (classKey) return renderOperatorAlert(classKey, detail);
  return {
    subject: '[OPERATOR] Berkeley Seat Sniper service alert',
    body: [
      'Berkeley Seat Sniper requires operator attention.',
      '',
      `Detail: ${detail}`,
      '',
      'Review worker health, the durable mail outbox, and provider status.',
    ].join('\n'),
  };
}

/** Render the out-of-band, recursion-safe dead-letter incident notification. */
export function renderDeadLetterIncident(input: {
  incidentId: string;
  mailJobId: string;
  mailKind: string;
  terminalReason: string;
  lastErrorCode: string;
  openedAt: Date;
}): RenderedEmail {
  return {
    subject: `[OPERATOR] dead-letter incident ${input.incidentId}`,
    body: [
      'Berkeley Seat Sniper has an unresolved dead-letter incident.',
      '',
      `Incident id: ${input.incidentId}`,
      `Mail job id: ${input.mailJobId}`,
      `Mail kind: ${input.mailKind}`,
      `Terminal reason: ${input.terminalReason}`,
      `Last error code: ${input.lastErrorCode}`,
      `Opened at: ${input.openedAt.toISOString()}`,
      '',
      'Acknowledge or resolve the incident with the authenticated operator tooling.',
    ].join('\n'),
  };
}
