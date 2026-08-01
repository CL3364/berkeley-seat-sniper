/**
 * ResendLinkForm — FR-10, AC-11.
 *
 * "Lost your link? / Didn't get the email?" An email input that POSTs to
 * /api/subscriptions/resend. The endpoint is NON-ENUMERATING: it always returns
 * the same constant-shaped 202 whether or not the address is subscribed, so this
 * form ALWAYS shows the identical reassurance copy on success — it never reveals
 * whether an address exists. Only a malformed-email validation_error (or a rate
 * limit / network failure) shows a different message.
 *
 * Reachable from the subscribe page and the confirm-error state.
 *
 * Accessibility: labelled input, inline validation, status announced politely.
 */

import React, { useState } from 'react';
import { SubscriberEmailSchema } from '../shared/api';
import { resendManageLink, ApiClientError } from '../client/api';

/** The single non-enumerating reassurance shown on every successful submit. */
const REASSURANCE = "If that address is subscribed, we've emailed its link. Check your inbox.";

function validateEmail(email: string): string | undefined {
  const result = SubscriberEmailSchema.safeParse(email);
  if (!result.success) {
    return result.error.issues[0]?.message ?? 'enter a valid email address';
  }
  return undefined;
}

interface ResendLinkFormProps {
  /** Heading shown above the form; lets callers tune the prompt to context. */
  heading?: string;
  /** Optional id so a parent can label/region this section distinctly. */
  headingId?: string;
}

export function ResendLinkForm({
  heading = 'Lost your link?',
  headingId = 'resend-heading',
}: ResendLinkFormProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const inputId = `${headingId}-email`;
  const helpId = `${headingId}-email-help`;
  const errorId = `${headingId}-email-error`;
  const formErrorId = `${headingId}-form-error`;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(undefined);
    setTouched(true);
    const err = validateEmail(email);
    setEmailError(err);
    if (err) return;

    setBusy(true);
    try {
      await resendManageLink(email.trim().toLowerCase());
      // Always the same reassurance — non-enumerating (AC-11).
      setSent(true);
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        if (caught.error.code === 'validation_error') {
          setEmailError(caught.error.fields?.['email'] ?? 'enter a valid email address');
        } else if (caught.error.code === 'rate_limited') {
          setFormError('too many requests — please wait a moment and try again');
        } else if (caught.error.code === 'payload_too_large') {
          setFormError('this request is too large — check the email address and try again');
        } else {
          setFormError(caught.error.message);
        }
      } else {
        setFormError('an unexpected error occurred — please try again');
      }
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section aria-labelledby={headingId} className="resend-form">
        <h3 id={headingId}>{heading}</h3>
        <p role="status" aria-live="polite">
          {REASSURANCE}
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSent(false);
            setEmail('');
            setTouched(false);
            setEmailError(undefined);
          }}
        >
          Send to a different address
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="resend-form">
      <h3 id={headingId}>{heading}</h3>
      <p className="hint">
        Enter the @berkeley.edu address you subscribed with and we&apos;ll re-send your link. Your
        link is the only way back to your watches.
      </p>
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        noValidate
        aria-describedby={formError ? formErrorId : undefined}
      >
        {formError && (
          <p id={formErrorId} role="alert" className="error-banner">
            {formError}
          </p>
        )}
        <div className="field">
          <label htmlFor={inputId}>Berkeley email address</label>
          <input
            id={inputId}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(undefined);
            }}
            onBlur={() => {
              setTouched(true);
              setEmailError(validateEmail(email));
            }}
            aria-required="true"
            aria-invalid={touched && emailError !== undefined}
            aria-describedby={touched && emailError ? `${helpId} ${errorId}` : helpId}
            disabled={busy}
          />
          <span id={helpId} className="hint">
            Use the exact @berkeley.edu mailbox connected to your watches.
          </span>
          {touched && emailError && (
            <span id={errorId} role="alert" className="field-error">
              {emailError}
            </span>
          )}
        </div>
        <button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Sending…' : 'Email me my link'}
        </button>
      </form>
    </section>
  );
}
