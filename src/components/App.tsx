/**
 * App — top-level shell. Routes between SubscribeView and ManageView based on
 * the presence of a `?token=` query parameter. No heavy router dependency —
 * the app has exactly two views and query-param routing is sufficient (library
 * governance: prefer boring + what is already in package.json).
 *
 * Accessibility: landmark regions, skip-link, visible focus managed globally
 * in app.css.
 */

import React from 'react';
import { SubscribeView } from './SubscribeView';
import { ManageView } from './ManageView';

function getTokenFromSearch(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

export function App(): React.ReactElement {
  const token = getTokenFromSearch();

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
        <p>Get alerted the moment a seat opens in a full Berkeley class.</p>
      </header>
      <main id="main-content">
        {token !== null ? <ManageView token={token} /> : <SubscribeView />}
      </main>
      <footer>
        <p>
          Notify-only — we never store your login or enroll on your behalf. See{' '}
          <a href="https://classes.berkeley.edu" rel="noopener noreferrer" target="_blank">
            Berkeley Classes
          </a>{' '}
          for enrollment.
        </p>
      </footer>
    </>
  );
}
