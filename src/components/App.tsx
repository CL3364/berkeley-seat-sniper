/**
 * App — top-level shell. Routes between three views by query parameter, with no
 * heavy router dependency (library governance: prefer boring + what is already in
 * package.json). The app has exactly three entry points, all under `/`:
 *
 *   ?confirm=<token>  → ConfirmView  (confirmation-email landing; FR-9)
 *   ?token=<token>    → ManageView   (manage/unsubscribe; FR-2)
 *   (neither)         → SubscribeView (FR-1)
 *
 * Emailed links land here per spec §4 (pinned formats). A successful confirm
 * pivots to the manage view for the SAME token (one token type, spec §4) and
 * rewrites the URL to `?token=<token>` so a refresh stays on manage.
 *
 * Accessibility: landmark regions, skip-link, visible focus managed globally
 * in app.css.
 */

import React, { useState } from 'react';
import { SubscribeView } from './SubscribeView';
import { ManageView } from './ManageView';
import { ConfirmView } from './ConfirmView';

type Route =
  | { kind: 'subscribe' }
  | { kind: 'manage'; token: string }
  | { kind: 'confirm'; token: string };

/** Derive the initial route from the current URL query string. */
function routeFromSearch(): Route {
  const params = new URLSearchParams(window.location.search);
  const confirm = params.get('confirm');
  if (confirm && confirm.length > 0) return { kind: 'confirm', token: confirm };
  const token = params.get('token');
  if (token && token.length > 0) return { kind: 'manage', token };
  return { kind: 'subscribe' };
}

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(routeFromSearch);

  // After a successful confirm, switch to manage for the same token and rewrite
  // the URL (?confirm=…→?token=…) so a refresh lands on manage, not re-confirm.
  function handleConfirmed(token: string): void {
    const url = `${window.location.pathname}?token=${encodeURIComponent(token)}`;
    window.history.replaceState(null, '', url);
    setRoute({ kind: 'manage', token });
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <header>
        <h1>
          <a href="/" aria-label="Berkeley Seat Sniper — home">
            Berkeley Seat Sniper
          </a>
        </h1>
        <p>Get notified after Berkeley&apos;s public class page shows an opening.</p>
      </header>
      <main id="main-content">
        {route.kind === 'confirm' ? (
          <ConfirmView token={route.token} onConfirmed={handleConfirmed} />
        ) : route.kind === 'manage' ? (
          <ManageView token={route.token} />
        ) : (
          <SubscribeView />
        )}
      </main>
      <footer>
        <p>
          Notify-only — we never store your login or enroll on your behalf. Availability comes from
          public class pages and may reflect Berkeley&apos;s cache. See{' '}
          <a href="https://classes.berkeley.edu" rel="noopener noreferrer" target="_blank">
            Berkeley Classes
          </a>{' '}
          for enrollment.
        </p>
      </footer>
    </>
  );
}
