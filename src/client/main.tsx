/**
 * Entry point — mounts the React 18 app onto #root (index.html).
 * Imports the global stylesheet before mounting so styles are present
 * on first paint.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from '../components/App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('no #root element found in index.html — cannot mount React');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
