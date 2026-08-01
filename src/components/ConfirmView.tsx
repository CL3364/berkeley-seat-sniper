/**
 * ConfirmView — FR-9, AC-1, AC-10.
 *
 * Landing for `${APP_BASE_URL}/?confirm=<token>` (the link in a confirmation
 * email). Confirmation is an EXPLICIT POST behind a user gesture so a mail
 * scanner that prefetches the link cannot auto-confirm — we render an idle view
 * with a "Confirm my email" button and only call the confirm endpoint when the
 * user clicks it.
 *
 * On success (including the idempotent already-confirmed 200) it transitions to
 * the manage view for the SAME token (spec §4: one token type). Token errors:
 *  - token_invalid (401, expired/invalid) → friendly error + resend pointer.
 *  - not_found (404)                       → friendly "no longer exists" error.
 *
 * Accessibility: semantic heading, a real <button> for the gesture, status and
 * errors announced via role="status"/role="alert".
 */

import React, { useState } from 'react';
import { confirmSubscription, ApiClientError } from '../client/api';
import { ResendLinkForm } from './ResendLinkForm';

type ConfirmState =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'error'; code: string; message: string };

interface ConfirmViewProps {
  token: string;
  /** Called after a successful confirm to switch the app to the manage view. */
  onConfirmed: (token: string) => void;
}

export function ConfirmView({ token, onConfirmed }: ConfirmViewProps): React.ReactElement {
  const [state, setState] = useState<ConfirmState>({ status: 'idle' });

  async function handleConfirm(): Promise<void> {
    setState({ status: 'confirming' });
    try {
      await confirmSubscription(token);
      // 200 (incl. idempotent already-confirmed) → straight to manage.
      onConfirmed(token);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setState({ status: 'error', code: err.error.code, message: err.error.message });
      } else {
        setState({
          status: 'error',
          code: 'internal_error',
          message: 'could not confirm your email',
        });
      }
    }
  }

  if (state.status === 'error') {
    const isToken = state.code === 'token_invalid';
    const isNotFound = state.code === 'not_found';
    return (
      <section aria-labelledby="confirm-error-heading">
        <h2 id="confirm-error-heading">Unable to confirm</h2>
        <p role="alert">
          {isToken
            ? 'This confirmation link has expired or is invalid. Request a fresh link below and we will email it to you.'
            : isNotFound
              ? 'This subscription no longer exists. Subscribe again from the home page, or request a fresh link below.'
              : state.message}
        </p>
        <ResendLinkForm heading="Get a fresh link" headingId="confirm-error-resend-heading" />
        <p>
          <a href="/">Back to subscribe</a>
        </p>
      </section>
    );
  }

  const confirming = state.status === 'confirming';

  return (
    <section aria-labelledby="confirm-heading">
      <h2 id="confirm-heading">Confirm your email</h2>
      <p>
        You&apos;re one step away. Confirm control of this @berkeley.edu mailbox to start receiving
        alerts for the classes you asked to watch.
      </p>
      <p className="hint">
        Confirmation does not prove current enrollment or eligibility for a particular seat. Web
        push is an optional extra you can turn on afterward; email alerts stay on once you confirm.
      </p>
      <button
        type="button"
        onClick={() => void handleConfirm()}
        disabled={confirming}
        aria-busy={confirming}
      >
        {confirming ? 'Confirming…' : 'Confirm my email'}
      </button>
      {confirming && (
        <p role="status" aria-live="polite">
          Confirming your subscription…
        </p>
      )}
    </section>
  );
}
