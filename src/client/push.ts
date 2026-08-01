/**
 * Web-push browser plumbing (FR-15, AC-16, D10). Keeps all Service Worker /
 * Push API interaction out of the React view so the component just calls
 * intent-named async helpers.
 *
 * Push is ADDITIVE and ALERTS-ONLY by contract: this module registers a service
 * worker (`/sw.js`) that renders ONLY PushAlertPayload notifications, subscribes
 * the browser with the server's VAPID public key, and reports the resulting
 * endpoint + keys to the API. It never handles tokens or links — those live in
 * email only.
 */

import { enablePush, disablePush, getVapidPublicKey } from './api';
import type { EnablePushRequest } from '../shared/api';

/** Path to the service worker served from `public/` (Vite copies it verbatim). */
const SERVICE_WORKER_URL = '/sw.js';

/**
 * Feature-detect support for the whole push stack. The toggle is hidden entirely
 * when any piece is missing (no `serviceWorker`, no `PushManager`, no
 * `Notification`) — e.g. Safari without push, or a non-secure context.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Convert a base64url VAPID public key into the raw bytes `pushManager.subscribe`
 * wants. Returns an `ArrayBuffer` (an unambiguous `BufferSource` for the
 * `applicationServerKey` option across DOM lib versions).
 */
function urlBase64ToBytes(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) {
    view[i] = rawData.charCodeAt(i);
  }
  return buffer;
}

/**
 * Register (or reuse) the alerts service worker and return its registration.
 * Idempotent — the browser dedupes registrations by script URL.
 */
async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { type: 'classic' });
}

/**
 * Shape a browser `PushSubscription` into the contract's EnablePushRequest. The
 * subscription's `toJSON()` yields exactly `{ endpoint, keys: { p256dh, auth } }`
 * (plus an ignored `expirationTime`); we validate the keys are present.
 */
function toEnablePushRequest(sub: PushSubscription): EnablePushRequest | null {
  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Result of probing what push can do right now, before showing the toggle. */
export interface PushAvailability {
  /** Browser supports the push stack. */
  supported: boolean;
  /** Server has VAPID configured (public key present). */
  configured: boolean;
  /** This browser already has an active push subscription for this app. */
  enabled: boolean;
}

/**
 * Probe push availability for the manage view: feature support, whether the
 * server is configured (VAPID key non-null), and whether this browser is already
 * subscribed. Never throws — returns a safe "off" state on any failure so the UI
 * can render rather than crash.
 */
export async function probePushAvailability(): Promise<PushAvailability> {
  if (!isPushSupported()) {
    return { supported: false, configured: false, enabled: false };
  }

  let configured = false;
  try {
    const { publicKey } = await getVapidPublicKey();
    configured = publicKey !== null;
  } catch {
    // Treat a failed key fetch as "not configured" — the toggle disables.
    configured = false;
  }

  let enabled = false;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    if (registration) {
      const existing = await registration.pushManager.getSubscription();
      enabled = existing !== null;
    }
  } catch {
    enabled = false;
  }

  return { supported: true, configured, enabled };
}

/** Discriminated outcome for an enable attempt, so the view can message precisely. */
export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'permission-denied' | 'not-confirmed' | 'unsupported' | 'error' };

/**
 * Enable push on THIS browser: request notification permission, register the
 * service worker, subscribe with the server VAPID key, and POST the endpoint +
 * keys to the API (token-scoped). Returns a typed outcome:
 *  - `not-confirmed` maps the API's 409 (subscriber still Pending — confirm first).
 *  - `permission-denied` when the user blocks notifications.
 */
export async function enableBrowserPush(token: string): Promise<EnableResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  // Fetch the server VAPID key; absent ⇒ push is not configured.
  let applicationServerKey: ArrayBuffer;
  try {
    const { publicKey } = await getVapidPublicKey();
    if (publicKey === null) return { ok: false, reason: 'error' };
    applicationServerKey = urlBase64ToBytes(publicKey);
  } catch {
    return { ok: false, reason: 'error' };
  }

  // Explicit user-visible permission gate (required for userVisibleOnly push).
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

  let request: EnablePushRequest | null;
  try {
    const registration = await registerServiceWorker();
    await navigator.serviceWorker.ready;
    // Reuse an existing subscription if present; otherwise create one.
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      }));
    request = toEnablePushRequest(subscription);
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (request === null) return { ok: false, reason: 'error' };

  try {
    await enablePush(token, request);
    return { ok: true };
  } catch (err) {
    // Map the contract's 409 (Pending subscriber) to a precise hint.
    if (
      typeof err === 'object' &&
      err !== null &&
      'error' in err &&
      typeof (err as { error: { code?: string } }).error?.code === 'string' &&
      (err as { error: { code: string } }).error.code === 'conflict'
    ) {
      return { ok: false, reason: 'not-confirmed' };
    }
    return { ok: false, reason: 'error' };
  }
}

/**
 * Disable push on THIS browser: unsubscribe from the push manager and DELETE the
 * registration server-side (idempotent). Best-effort — both legs run even if one
 * fails, so the UI can always return to the "off" state. Returns true when the
 * server delete succeeded (the source of truth the toggle reflects).
 */
export async function disableBrowserPush(token: string): Promise<boolean> {
  if (!isPushSupported()) return true;

  let endpoint: string | null = null;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    if (registration) {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        endpoint = subscription.endpoint;
        await subscription.unsubscribe();
      }
    }
  } catch {
    // Ignore — still attempt the server-side delete if we have an endpoint.
  }

  if (endpoint === null) return true; // nothing registered server-side to remove
  try {
    await disablePush(token, endpoint);
    return true;
  } catch {
    return false;
  }
}
