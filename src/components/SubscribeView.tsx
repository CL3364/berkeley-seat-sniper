/**
 * SubscribeView — FR-1, AC-2, AC-1.
 *
 * Collects an email + a list of class identifiers (URLs or codes). Each class
 * identifier is validated inline with normalizeClassKey before any request is
 * sent — an invalid identifier shows an inline error and blocks submission.
 *
 * On 201 the view shows the manage deep-link (containing the returned token)
 * so the user can return to their manage view later.
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
import { EmailSchema } from '../shared/api';
import { createSubscription, ApiClientError } from '../client/api';
import type { CreateSubscriptionResponse } from '../shared/api';

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
  const result = EmailSchema.safeParse(email);
  if (!result.success) {
    return result.error.errors[0]?.message ?? 'enter a valid email address';
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
  const [success, setSuccess] = useState<CreateSubscriptionResponse | null>(null);

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

    setSubmitting(true);
    try {
      const response = await createSubscription({ email: email.trim().toLowerCase(), classKeys });
      setSuccess(response);
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
            'this email is already subscribed — use your manage link to update your watches',
          );
        } else if (apiErr.code === 'rate_limited') {
          setFormError('too many requests — please wait a moment and try again');
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

  // -- Success state --

  if (success !== null) {
    const manageUrl = `${window.location.pathname}?token=${encodeURIComponent(success.token)}`;
    return (
      <section aria-labelledby="success-heading">
        <h2 id="success-heading">You are subscribed</h2>
        <p>
          Watching {success.watches.length} class{success.watches.length !== 1 ? 'es' : ''}:
        </p>
        <ul>
          {success.watches.map((key) => (
            <li key={key}>
              <code>{key}</code>
            </li>
          ))}
        </ul>
        <p>Save your manage link — it is the only way back to your watches:</p>
        <p>
          <a href={manageUrl} aria-label="your manage link">
            {window.location.origin}
            {manageUrl}
          </a>
        </p>
      </section>
    );
  }

  // -- Form --

  return (
    <section aria-labelledby="subscribe-heading">
      <h2 id="subscribe-heading">Watch a class</h2>
      <p>
        Enter your email and one or more Berkeley class URLs or codes. We will email you the moment
        a seat or waitlist spot opens.
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
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={handleEmailChange}
            onBlur={handleEmailBlur}
            aria-required="true"
            aria-invalid={emailTouched && emailError !== undefined}
            aria-describedby={emailTouched && emailError ? 'email-error' : undefined}
            disabled={submitting}
          />
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
          <button
            type="button"
            onClick={handleAddClass}
            disabled={submitting || classEntries.length >= 50}
          >
            Add another class
          </button>
        </fieldset>

        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>
    </section>
  );
}
