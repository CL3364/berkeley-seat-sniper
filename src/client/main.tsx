/**
 * Entry point — mounts the React 18 app onto #root (index.html).
 * Imports the global stylesheet before mounting so styles are present
 * on first paint.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from '../components/App';
import { capturePilotInviteFromUrl } from './pilot-invite';

// Privacy boundary: remove a pilot bearer from the visible URL/history and put
// it in tab-scoped storage before React renders or any application request runs.
capturePilotInviteFromUrl();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('no #root element found in index.html — cannot mount React');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
