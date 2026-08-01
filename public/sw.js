/* global self */
/*
 * Berkeley Seat Sniper — alerts service worker (FR-15, AC-16, D10).
 *
 * Web push is ADDITIVE and ALERTS-ONLY by contract. This worker handles exactly
 * two events:
 *   - 'push'              render a notification from a PushAlertPayload JSON
 *                         (kind:'alert', classKey, reason, openSeats, openedAt).
 *   - 'notificationclick' open the public Berkeley class page derived from the
 *                         payload's classKey alone.
 *
 * It NEVER receives or stores a token, an email, or a confirm/manage link — the
 * push payload carries none of those (the notifier validates that server-side,
 * and we defensively ignore any unexpected fields here). The click-through URL
 * is derived from the classKey, never taken from the payload.
 *
 * Served verbatim from /public by Vite — this file is intentionally plain JS so
 * the browser registers it as a classic worker without a build step.
 */

const CLASS_PAGE_BASE = 'https://classes.berkeley.edu/content/';

// Canonical ClassKey shape (mirrors src/shared/class-key.ts CLASS_KEY_PATTERN).
// We re-validate on receipt so a malformed/forged payload never builds a URL or
// shows a misleading notification.
const CLASS_KEY_PATTERN =
  /^\d{4}-(?:fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-(?:\d{3,8}|(?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+)-[a-z]{2,8}-(?:\d{3,8}|(?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+)$/;

const VALID_REASONS = ['seats-open', 'waitlist-open'];

/** Parse + validate the push payload into the alerts-only shape, or null. */
function parseAlertPayload(event) {
  if (!event.data) return null;
  let data;
  try {
    data = event.data.json();
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.kind !== 'alert') return null;
  if (typeof data.classKey !== 'string' || !CLASS_KEY_PATTERN.test(data.classKey)) return null;
  if (VALID_REASONS.indexOf(data.reason) === -1) return null;
  const openSeats =
    typeof data.openSeats === 'number' && Number.isFinite(data.openSeats) ? data.openSeats : 0;
  return { classKey: data.classKey, reason: data.reason, openSeats };
}

/** Build the human-facing title + body. Never includes a token, email, or link. */
function renderNotification(payload) {
  if (payload.reason === 'seats-open') {
    const seatWord = payload.openSeats === 1 ? 'seat' : 'seats';
    return {
      title: 'A seat opened',
      body:
        `${payload.classKey} now shows ${payload.openSeats} open ${seatWord}. ` +
        'Seats are first-come, first-served — enroll fast. ' +
        'Note: some open seats are reserved for specific groups and may not be enrollable by everyone.',
    };
  }
  // waitlist-open
  return {
    title: 'A waitlist spot opened',
    body:
      `${payload.classKey} now has room on its waitlist. ` +
      'This is a spot in line, not a seat — get on the list fast.',
  };
}

self.addEventListener('install', () => {
  // Activate immediately so a freshly registered worker can receive pushes.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = parseAlertPayload(event);
  if (payload === null) {
    // Unrecognized/forged payload — do not show a misleading notification.
    return;
  }
  const { title, body } = renderNotification(payload);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: payload.classKey, // collapse repeat alerts for the same class
      data: { classKey: payload.classKey },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const classKey =
    event.notification.data && typeof event.notification.data.classKey === 'string'
      ? event.notification.data.classKey
      : null;
  const target = classKey && CLASS_KEY_PATTERN.test(classKey) ? CLASS_PAGE_BASE + classKey : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) {
            try {
              client.navigate(target);
            } catch {
              // Cross-origin navigate may be blocked; opening a new window below.
            }
          }
          return undefined;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
      return undefined;
    }),
  );
});
