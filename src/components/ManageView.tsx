/**
 * ManageView — FR-2, AC-1, AC-7.
 *
 * Keyed by the `?token=` query param. Loads the subscription, lists current
 * watches, lets the user add/remove watches, and unsubscribe entirely.
 *
 * States: loading, error (token invalid / not found / network), empty (no
 * watches), and the populated list with add/remove/unsubscribe controls.
 *
 * Accessibility: WCAG 2.1 AA. Every action has a visible label, keyboard
 * operability, and focus management after destructive actions.
 *
 * Validation visibility rule: add-watch field errors only show after the field
 * has been touched (blurred) or a submit attempt has occurred.
 */

import React, { useState, useEffect, useRef } from 'react';
import { getSubscription, addWatch, removeWatch, unsubscribe, ApiClientError } from '../client/api';
import type { GetSubscriptionResponse } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { normalizeClassKey } from '../shared/class-key';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code: string }
  | { status: 'ready'; data: GetSubscriptionResponse };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ManageViewProps {
  token: string;
}

export function ManageView({ token }: ManageViewProps): React.ReactElement {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [newClass, setNewClass] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [addFieldTouched, setAddFieldTouched] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [removeBusy, setRemoveBusy] = useState<ClassKey | null>(null);
  const [unsubBusy, setUnsubBusy] = useState(false);
  const [unsubConfirm, setUnsubConfirm] = useState(false);
  const [unsubDone, setUnsubDone] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  // Focus management: after removing a watch, return focus to the heading
  const headingRef = useRef<HTMLHeadingElement>(null);

  // -- Load subscription --

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });

    getSubscription(token)
      .then((data) => {
        if (!cancelled) setLoad({ status: 'ready', data });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiClientError) {
          setLoad({ status: 'error', message: err.error.message, code: err.error.code });
        } else {
          setLoad({
            status: 'error',
            message: 'could not load your subscription',
            code: 'internal_error',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // -- Add watch --

  function validateNewClass(value: string): string | undefined {
    if (value.trim() === '') return 'class identifier is required';
    const result = normalizeClassKey(value.trim());
    if (!result.ok) {
      return 'could not recognize this as a Berkeley class URL or code — use e.g. 2026-fall-compsci-189-001-lec-001';
    }
    return undefined;
  }

  async function handleAddWatch(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setActionError(undefined);
    // Mark touched so the error message becomes visible if validation fails
    setAddFieldTouched(true);
    const err = validateNewClass(newClass);
    setAddError(err);
    if (err) return;

    setAddBusy(true);
    try {
      const updated = await addWatch(token, newClass.trim());
      setLoad((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', data: { ...prev.data, watches: updated.watches } }
          : prev,
      );
      setNewClass('');
      setAddError(undefined);
      setAddFieldTouched(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.error.code === 'conflict') {
          setAddError('already watching this class');
        } else if (err.error.code === 'validation_error') {
          setAddError(err.error.fields?.['classKey'] ?? err.error.message);
        } else {
          setActionError(err.error.message);
        }
      } else {
        setActionError('failed to add watch — please try again');
      }
    } finally {
      setAddBusy(false);
    }
  }

  // -- Remove watch --

  async function handleRemoveWatch(classKey: ClassKey): Promise<void> {
    setActionError(undefined);
    setRemoveBusy(classKey);
    try {
      await removeWatch(token, classKey);
      setLoad((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          status: 'ready',
          data: { ...prev.data, watches: prev.data.watches.filter((k) => k !== classKey) },
        };
      });
      // Return focus to heading after the list shrinks
      headingRef.current?.focus();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setActionError(err.error.message);
      } else {
        setActionError('failed to remove watch — please try again');
      }
    } finally {
      setRemoveBusy(null);
    }
  }

  // -- Unsubscribe --

  async function handleUnsubscribe(): Promise<void> {
    setActionError(undefined);
    setUnsubBusy(true);
    try {
      await unsubscribe(token);
      setUnsubDone(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setActionError(err.error.message);
      } else {
        setActionError('failed to unsubscribe — please try again');
      }
    } finally {
      setUnsubBusy(false);
      setUnsubConfirm(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (unsubDone) {
    return (
      <section aria-labelledby="unsub-done-heading">
        <h2 id="unsub-done-heading">Unsubscribed</h2>
        <p role="status" aria-live="polite">
          You have been unsubscribed. You will no longer receive seat alerts.
        </p>
      </section>
    );
  }

  if (load.status === 'loading') {
    return (
      <section aria-labelledby="manage-heading">
        <h2 id="manage-heading">Manage your subscription</h2>
        <p aria-live="polite" aria-busy="true">
          Loading your subscription…
        </p>
      </section>
    );
  }

  if (load.status === 'error') {
    const isToken = load.code === 'token_invalid';
    const isNotFound = load.code === 'not_found';
    return (
      <section aria-labelledby="manage-error-heading">
        <h2 id="manage-error-heading">Unable to load subscription</h2>
        <p role="alert">
          {isToken
            ? 'Your manage link has expired or is invalid. Check your email for the original link.'
            : isNotFound
              ? 'This subscription no longer exists.'
              : load.message}
        </p>
      </section>
    );
  }

  // load.status === 'ready'
  const { data } = load;

  return (
    <section aria-labelledby="manage-heading">
      <h2 id="manage-heading" ref={headingRef} tabIndex={-1}>
        Manage your subscription
      </h2>
      <p>
        Subscribed as <strong>{data.email}</strong>.
      </p>

      {actionError && (
        <p role="alert" className="error-banner">
          {actionError}
        </p>
      )}

      {/* Watch list */}
      <section aria-labelledby="watches-heading">
        <h3 id="watches-heading">Current watches</h3>
        {data.watches.length === 0 ? (
          <p>You are not watching any classes. Add one below.</p>
        ) : (
          <ul aria-label="watched classes">
            {data.watches.map((classKey) => (
              <li key={classKey} className="watch-item">
                <code>{classKey}</code>
                <button
                  type="button"
                  onClick={() => {
                    void handleRemoveWatch(classKey as ClassKey);
                  }}
                  disabled={removeBusy === classKey || unsubBusy}
                  aria-busy={removeBusy === classKey}
                  aria-label={`Remove watch for ${classKey}`}
                >
                  {removeBusy === classKey ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add watch */}
      <section aria-labelledby="add-watch-heading">
        <h3 id="add-watch-heading">Add a class to watch</h3>
        <form
          onSubmit={(e) => {
            void handleAddWatch(e);
          }}
          noValidate
          aria-describedby={addFieldTouched && addError ? 'add-class-error' : undefined}
        >
          <div className="field">
            <label htmlFor="add-class">Class URL or code</label>
            <input
              id="add-class"
              type="text"
              value={newClass}
              onChange={(e) => {
                setNewClass(e.target.value);
                // Re-validate on change only after the field has been touched
                if (addFieldTouched) setAddError(validateNewClass(e.target.value));
              }}
              onBlur={() => {
                setAddFieldTouched(true);
                setAddError(validateNewClass(newClass));
              }}
              aria-required="true"
              aria-invalid={addFieldTouched && addError !== undefined}
              aria-describedby={addFieldTouched && addError ? 'add-class-error' : undefined}
              placeholder="e.g. 2026-fall-compsci-189-001-lec-001"
              disabled={addBusy || unsubBusy}
            />
            {addFieldTouched && addError && (
              <span id="add-class-error" role="alert" className="field-error">
                {addError}
              </span>
            )}
          </div>
          <button type="submit" disabled={addBusy || unsubBusy} aria-busy={addBusy}>
            {addBusy ? 'Adding…' : 'Add watch'}
          </button>
        </form>
      </section>

      {/* Unsubscribe */}
      <section aria-labelledby="unsub-heading">
        <h3 id="unsub-heading">Unsubscribe</h3>
        <p>Remove all watches and stop receiving alerts.</p>
        {unsubConfirm ? (
          <div role="group" aria-labelledby="unsub-confirm-label">
            <p id="unsub-confirm-label">Are you sure? This cannot be undone.</p>
            <button
              type="button"
              onClick={() => {
                void handleUnsubscribe();
              }}
              disabled={unsubBusy}
              aria-busy={unsubBusy}
            >
              {unsubBusy ? 'Unsubscribing…' : 'Yes, unsubscribe'}
            </button>
            <button type="button" onClick={() => setUnsubConfirm(false)} disabled={unsubBusy}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setUnsubConfirm(true)} disabled={unsubBusy}>
            Unsubscribe
          </button>
        )}
      </section>
    </section>
  );
}
