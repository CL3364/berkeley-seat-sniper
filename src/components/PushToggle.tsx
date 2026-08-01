/**
 * PushToggle — FR-15, AC-16, D10. Per-browser web-push opt-in, shown ONLY in the
 * manage view and ONLY to a Confirmed subscriber.
 *
 * Push is ADDITIVE: the copy never suggests it replaces email. Email remains the
 * identity + baseline channel; this just adds browser notifications on this device.
 *
 * Behavior:
 *  - Feature-detect on mount (no serviceWorker/PushManager/Notification → render
 *    nothing). Also probes whether the server has VAPID configured; if not, the
 *    toggle is disabled with a "not configured" note.
 *  - Enable: request permission, register the SW, subscribe, POST endpoint+keys.
 *    A 409 (subscriber still Pending) surfaces the confirm-first hint.
 *  - Disable: pushManager.unsubscribe + DELETE the registration.
 *
 * All Service Worker / Push API plumbing lives in src/client/push.ts; this is the
 * accessible UI layer over it.
 */

import React, { useEffect, useState } from 'react';
import {
  disableBrowserPush,
  enableBrowserPush,
  isPushSupported,
  probePushAvailability,
} from '../client/push';

interface PushToggleProps {
  token: string;
  /** True once the subscriber is Confirmed; push is offered only then. */
  confirmed: boolean;
}

type Phase = 'probing' | 'ready' | 'working';

export function PushToggle({ token, confirmed }: PushToggleProps): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>('probing');
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Probe support + server configuration + current subscription state on mount.
  useEffect(() => {
    let cancelled = false;
    if (!isPushSupported()) {
      setPhase('ready');
      return;
    }
    probePushAvailability()
      .then((avail) => {
        if (cancelled) return;
        setConfigured(avail.configured);
        setEnabled(avail.enabled);
        setPhase('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setConfigured(false);
        setPhase('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Hidden entirely when the browser lacks the push stack (feature-detect).
  if (!isPushSupported()) return null;

  async function handleEnable(): Promise<void> {
    setError(undefined);
    setMessage(undefined);
    setPhase('working');
    const result = await enableBrowserPush(token);
    if (result.ok) {
      setEnabled(true);
      setMessage(
        'Push alerts are on for this browser. You will still get every alert by email too.',
      );
    } else {
      switch (result.reason) {
        case 'not-confirmed':
          setError('Confirm your email first, then enable push on this browser.');
          break;
        case 'permission-denied':
          setError(
            'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
          );
          break;
        case 'unsupported':
          setError('This browser does not support web push.');
          break;
        default:
          setError('Could not enable push on this browser. Please try again.');
      }
    }
    setPhase('ready');
  }

  async function handleDisable(): Promise<void> {
    setError(undefined);
    setMessage(undefined);
    setPhase('working');
    const ok = await disableBrowserPush(token);
    if (ok) {
      setEnabled(false);
      setMessage('Push alerts are off for this browser. You will still get alerts by email.');
    } else {
      setError('Could not turn off push on this browser. Please try again.');
    }
    setPhase('ready');
  }

  const probing = phase === 'probing';
  const working = phase === 'working';

  return (
    <section aria-labelledby="push-heading">
      <h3 id="push-heading">Browser push alerts</h3>
      <p>
        Optionally get a notification on this browser too, on top of email. Email alerts stay on
        either way — push is an extra, not a replacement.
      </p>

      {probing ? (
        <p aria-live="polite" aria-busy="true">
          Checking push availability…
        </p>
      ) : !confirmed ? (
        <p role="note">Confirm your email first to enable push alerts.</p>
      ) : !configured ? (
        <p role="note">Browser push isn&apos;t configured for this site yet.</p>
      ) : enabled ? (
        <button
          type="button"
          onClick={() => void handleDisable()}
          disabled={working}
          aria-busy={working}
        >
          {working ? 'Working…' : 'Turn off push on this browser'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleEnable()}
          disabled={working}
          aria-busy={working}
        >
          {working ? 'Working…' : 'Enable push on this browser'}
        </button>
      )}

      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  );
}
