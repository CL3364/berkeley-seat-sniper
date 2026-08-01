/**
 * SubscribeView — FR-1, AC-1, AC-2.
 *
 * Collects an email + a list of class identifiers (URLs or codes). Each class
 * identifier is validated inline with normalizeClassKey before any request is
 * sent — an invalid identifier shows an inline error and blocks submission.
 *
 * Double opt-in (FR-9 / D3): the 202 response carries NO token — it is just an
 * acknowledgement. On success the view tells the user to check their inbox to
 * confirm; the confirm link arrives only by email. There is no deep-link into
 * the manage view from here.
 *
 * Accessibility: WCAG 2.1 AA. All inputs have associated <label>s. Errors are
 * linked to their field via aria-describedby. Status messages use role="status"
 * (polite) or role="alert" (assertive) as appropriate.
 *
 * Validation visibility rule: errors are only shown after a field has been
 * touched (blurred) or a submit attempt has occurred — never on first paint.
 */

import React, { useState } from 'react';
import { normalizeClassKey } from '../shared/class-key';
import { SubscriberEmailSchema, MAX_WATCHES_PER_SUBSCRIBER } from '../shared/api';
import { createSubscription, ApiClientError, describeRetryAfter } from '../client/api';
import { ResendLinkForm } from './ResendLinkForm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClassEntry {
  id: number;
  value: string;
  /** undefined = valid; string = error message */
  error: string | undefined;
  /** true once the field has been blurred at least once */
  touched: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 0;
function newEntry(value = ''): ClassEntry {
  return { id: _nextId++, value, error: undefined, touched: false };
}

function validateEmail(email: string): string | undefined {
  const result = SubscriberEmailSchema.safeParse(email);
  if (!result.success) {
    return result.error.issues[0]?.message ?? 'enter a valid email address';
  }
  return undefined;
}

function validateClassEntry(value: string): string | undefined {
  if (value.trim() === '') return 'class identifier is required';
  const result = normalizeClassKey(value.trim());
  if (!result.ok) {
    return 'could not recognize this as a Berkeley class URL or code — use e.g. 2026-fall-compsci-189-001-lec-001';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SubscribeView(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [emailTouched, setEmailTouched] = useState(false);
  const [classEntries, setClassEntries] = useState<ClassEntry[]>([newEntry()]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  // -- Email handlers --

  function handleEmailChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setEmail(e.target.value);
    // Clear error while typing; re-validate on blur
    if (emailError) setEmailError(undefined);
  }

  function handleEmailBlur(): void {
    setEmailTouched(true);
    setEmailError(validateEmail(email));
  }

  // -- Class entry handlers --

  function handleClassChange(id: number, value: string): void {
    setClassEntries((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? { ...entry, value, error: entry.touched ? validateClassEntry(value) : entry.error }
          : entry,
      ),
    );
  }

  function handleClassBlur(id: number): void {
    setClassEntries((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? { ...entry, touched: true, error: validateClassEntry(entry.value) }
          : entry,
      ),
    );
  }

  function handleAddClass(): void {
    setClassEntries((prev) => [...prev, newEntry()]);
  }

  function handleRemoveClass(id: number): void {
    setClassEntries((prev) => {
      if (prev.length === 1) return prev; // always keep one row
      return prev.filter((entry) => entry.id !== id);
    });
  }

  // -- Submission --

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(undefined);

    // Validate all fields eagerly before sending anything (AC-2).
    // Mark every field touched so errors surface regardless of prior interaction.
    const emailErr = validateEmail(email);
    setEmailTouched(true);
    setEmailError(emailErr);

    const validatedEntries = classEntries.map((entry) => ({
      ...entry,
      touched: true,
      error: validateClassEntry(entry.value),
    }));
    setClassEntries(validatedEntries);

    const hasClassErrors = validatedEntries.some((e) => e.error !== undefined);
    if (emailErr || hasClassErrors) {
      // Block — do not send a request (AC-2)
      return;
    }

    // Collect canonical class keys — normalizeClassKey is safe/total
    const classKeys = validatedEntries.map((entry) => {
      const result = normalizeClassKey(entry.value.trim());
      // validateClassEntry guarantees ok === true here
      return result.ok ? result.key : entry.value;
    });

    const normalizedEmail = email.trim().toLowerCase();
    setSubmitting(true);
    try {
      await createSubscription({ email: normalizedEmail, classKeys });
      setSubmittedEmail(normalizedEmail);
    } catch (err) {
      if (err instanceof ApiClientError) {
        const apiErr = err.error;
        // Map field errors back to the form if present
        if (apiErr.code === 'validation_error' && apiErr.fields) {
          if (apiErr.fields['email']) setEmailError(apiErr.fields['email']);
          // class-level field errors: server may return 'classKeys.0', etc.
          const updatedEntries = classEntries.map((entry, idx) => {
            const fieldKey = `classKeys.${idx}`;
            const fieldErr = apiErr.fields?.[fieldKey];
            return fieldErr ? { ...entry, error: fieldErr } : entry;
          });
          setClassEntries(updatedEntries);
        } else if (apiErr.code === 'conflict') {
          setEmailError(
            'this email is already subscribed — use the form below to email yourself a fresh link',
          );
        } else if (apiErr.code === 'rate_limited') {
          setFormError('too many requests — please wait a moment and try again');
        } else if (apiErr.code === 'payload_too_large') {
          setFormError('this request is too large — shorten the class list and try again');
        } else if (apiErr.code === 'capacity_exceeded') {
          setFormError(
            `Seat Sniper has reached its current public-page monitoring capacity. Try again ${describeRetryAfter(err.retryAfterSeconds)}; existing watches remain active.`,
          );
        } else if (apiErr.code === 'admission_unavailable') {
          setFormError(
            `New subscriptions are not currently available. Try again ${describeRetryAfter(err.retryAfterSeconds)}.`,
          );
        } else {
          setFormError(apiErr.message);
        }
      } else {
        setFormError('an unexpected error occurred — please try again');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // -- Success state (double opt-in — no token in the response, FR-9) --

  if (submittedEmail !== null) {
    return (
      <section aria-labelledby="success-heading">
        <h2 id="success-heading">Check your inbox to confirm</h2>
        <p role="status" aria-live="polite">
          We&apos;ve emailed a confirmation link to <strong>{submittedEmail}</strong>. Click it to
          verify control of that Berkeley mailbox and start watching — alerts only go out to
          confirmed subscribers.
        </p>
        <p className="hint">
          Mailbox confirmation does not verify current enrollment or eligibility for a seat. The
          link can take a minute to arrive; check your spam folder if you don&apos;t see it.
        </p>
        <ResendLinkForm heading="Didn't get the email?" headingId="success-resend-heading" />
      </section>
    );
  }

  // -- Form --

  return (
    <section aria-labelledby="subscribe-heading">
      <h2 id="subscribe-heading">Watch a class</h2>
      <p>
        Enter your Berkeley email and one or more class URLs or codes. We will email you after
        Berkeley&apos;s public class page shows a seat or waitlist opening.
      </p>
      <p className="hint">
        Public class pages can be delayed by Berkeley&apos;s cache. We aim to notify you within two
        minutes after a changed page becomes visible to Seat Sniper.
      </p>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        noValidate
        aria-describedby={formError ? 'form-error' : undefined}
      >
        {formError && (
          <p id="form-error" role="alert" className="error-banner">
            {formError}
          </p>
        )}

        {/* Email */}
        <div className="field">
          <label htmlFor="email">Berkeley email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={handleEmailChange}
            onBlur={handleEmailBlur}
            aria-required="true"
            aria-invalid={emailTouched && emailError !== undefined}
            aria-describedby={emailTouched && emailError ? 'email-help email-error' : 'email-help'}
            disabled={submitting}
          />
          <span id="email-help" className="hint">
            Use an exact @berkeley.edu address. Confirmation proves mailbox ownership, not current
            student status.
          </span>
          {emailTouched && emailError && (
            <span id="email-error" role="alert" className="field-error">
              {emailError}
            </span>
          )}
        </div>

        {/* Class entries */}
        <fieldset>
          <legend>Classes to watch</legend>
          <p className="hint">
            Use a full Berkeley class URL or a code like{' '}
            <code>2026-fall-compsci-189-001-lec-001</code>.
          </p>
          {classEntries.map((entry, idx) => {
            const inputId = `class-${entry.id}`;
            const errorId = `class-error-${entry.id}`;
            return (
              <div key={entry.id} className="class-entry">
                <label htmlFor={inputId}>Class {idx + 1}</label>
                <div className="class-entry-row">
                  <input
                    id={inputId}
                    type="text"
                    value={entry.value}
                    onChange={(e) => handleClassChange(entry.id, e.target.value)}
                    onBlur={() => handleClassBlur(entry.id)}
                    aria-required="true"
                    aria-invalid={entry.touched && entry.error !== undefined}
                    aria-describedby={entry.touched && entry.error ? errorId : undefined}
                    placeholder="e.g. 2026-fall-compsci-189-001-lec-001"
                    disabled={submitting}
                  />
                  {classEntries.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveClass(entry.id)}
                      aria-label={`Remove class ${idx + 1}`}
                      disabled={submitting}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {entry.touched && entry.error !== undefined && (
                  <span id={errorId} role="alert" className="field-error">
                    {entry.error}
                  </span>
                )}
              </div>
            );
          })}
          {/*
           * Cap the form at the same number the contract enforces. Letting the
           * student type a fifth class and only failing at the server turns a
           * known rule into a rejected submission after they have done the work.
           */}
          <button
            type="button"
            onClick={handleAddClass}
            disabled={submitting || classEntries.length >= MAX_WATCHES_PER_SUBSCRIBER}
          >
            Add another class
          </button>
          {classEntries.length >= MAX_WATCHES_PER_SUBSCRIBER && (
            <p className="hint">
              You can watch up to {MAX_WATCHES_PER_SUBSCRIBER} classes at a time. Once you are
              subscribed you can remove one and add a different class.
            </p>
          )}
        </fieldset>

        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>

      <hr />

      <ResendLinkForm
        heading="Already subscribed? Lost your link?"
        headingId="subscribe-resend-heading"
      />
    </section>
  );
}
