/**
 * Browser-only pilot invite handling (FR-19 / AC-25).
 *
 * The invite is shared bearer access. Keep its lifetime and surface deliberately
 * narrow: strip it from the URL before React renders, retain it only in this
 * tab's sessionStorage, and expose it only as the create-subscription header.
 * Nothing in this module logs, renders, or persists the bearer elsewhere.
 */

import { PILOT_INVITE_CODE_HEADER, PilotInviteCodeSchema } from '../shared/api';

const PILOT_INVITE_SESSION_KEY = 'seat-sniper:pilot-invite-code';

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type LocationLike = Pick<Location, 'href'>;
type HistoryLike = Pick<History, 'state' | 'replaceState'>;

function browserSessionStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage may be unavailable under restrictive browser privacy settings.
    return null;
  }
}

function decodeQueryComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Remove every query item whose decoded name is exactly `invite`, preserving
 * all other raw query segments and their order/encoding.
 */
function stripInviteQuery(search: string): {
  nextSearch: string;
  inviteValues: Array<string | null>;
} {
  if (search === '' || search === '?') return { nextSearch: '', inviteValues: [] };

  const keptSegments: string[] = [];
  const inviteValues: Array<string | null> = [];
  const segments = search.startsWith('?') ? search.slice(1).split('&') : search.split('&');

  for (const segment of segments) {
    const equalsAt = segment.indexOf('=');
    const rawName = equalsAt === -1 ? segment : segment.slice(0, equalsAt);
    const decodedName = decodeQueryComponent(rawName);

    if (decodedName !== 'invite') {
      keptSegments.push(segment);
      continue;
    }

    const rawValue = equalsAt === -1 ? '' : segment.slice(equalsAt + 1);
    inviteValues.push(decodeQueryComponent(rawValue));
  }

  const hasMeaningfulRemainder = keptSegments.some((segment) => segment.length > 0);
  return {
    nextSearch: hasMeaningfulRemainder ? `?${keptSegments.join('&')}` : '',
    inviteValues,
  };
}

function removeStoredPilotInvite(storage: SessionStorageLike | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(PILOT_INVITE_SESSION_KEY);
  } catch {
    // A failed cleanup must not expose the bearer or break an existing flow.
  }
}

/**
 * Capture a pilot invite on initial page load.
 *
 * URL removal happens before validation or storage, so even malformed and
 * duplicate invite parameters disappear before the application renders. An
 * explicit invalid/ambiguous invite clears any older tab-scoped bearer rather
 * than accidentally submitting a different code.
 */
export function capturePilotInviteFromUrl(
  location: LocationLike = window.location,
  history: HistoryLike = window.history,
  storage: SessionStorageLike | null = browserSessionStorage(),
): void {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return;
  }

  const { nextSearch, inviteValues } = stripInviteQuery(url.search);
  if (inviteValues.length === 0) return;

  history.replaceState(history.state, '', `${url.pathname}${nextSearch}${url.hash}`);

  if (inviteValues.length !== 1) {
    removeStoredPilotInvite(storage);
    return;
  }

  const parsed = PilotInviteCodeSchema.safeParse(inviteValues[0]);
  if (!parsed.success || storage === null) {
    removeStoredPilotInvite(storage);
    return;
  }

  try {
    storage.setItem(PILOT_INVITE_SESSION_KEY, parsed.data);
  } catch {
    // The URL is already clean. Fail closed if tab-scoped storage is unavailable.
    removeStoredPilotInvite(storage);
  }
}

/**
 * Read and revalidate the session bearer immediately before a create request.
 * This also rejects values altered through browser developer tools.
 */
export function readStoredPilotInvite(
  storage: SessionStorageLike | null = browserSessionStorage(),
): string | null {
  if (storage === null) return null;

  let value: string | null;
  try {
    value = storage.getItem(PILOT_INVITE_SESSION_KEY);
  } catch {
    return null;
  }
  if (value === null) return null;

  const parsed = PilotInviteCodeSchema.safeParse(value);
  if (!parsed.success) {
    removeStoredPilotInvite(storage);
    return null;
  }
  return parsed.data;
}

/** Build the sole request-header surface allowed for the session bearer. */
export function pilotInviteCreateHeaders(
  storage: SessionStorageLike | null = browserSessionStorage(),
): Record<string, string> {
  const invite = readStoredPilotInvite(storage);
  return invite === null ? {} : { [PILOT_INVITE_CODE_HEADER]: invite };
}

/** Clear the bearer only after a valid 202 create acknowledgement. */
export function clearStoredPilotInvite(
  storage: SessionStorageLike | null = browserSessionStorage(),
): void {
  removeStoredPilotInvite(storage);
}
