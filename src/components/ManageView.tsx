/**
 * ManageView — FR-2, FR-9, FR-15, AC-1, AC-7, AC-16.
 *
 * Keyed by the `?token=` query param. Loads the subscription, shows Pending vs
 * Confirmed state, lists current watches, lets the user add/remove watches,
 * enable/disable per-browser push, and unsubscribe entirely.
 *
 * States: loading, error (token invalid / not found / network), empty (no
 * watches), and the populated list with add/remove/push/unsubscribe controls.
 * When the subscriber is Pending (`confirmed: false`) a banner prompts them to
 * confirm — with a resend form — and push is gated off until they do.
 *
 * Accessibility: WCAG 2.1 AA. Every action has a visible label, keyboard
 * operability, and focus management after destructive actions.
 *
 * Validation visibility rule: add-watch field errors only show after the field
 * has been touched (blurred) or a submit attempt has occurred.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  getSubscription,
  addWatch,
  removeWatch,
  unsubscribe,
  ApiClientError,
  describeRetryAfter,
} from '../client/api';
import type { GetSubscriptionResponse, WatchFreshness } from '../shared/api';
import { MAX_WATCHES_PER_SUBSCRIBER } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { classPageUrl, normalizeClassKey } from '../shared/class-key';
import { PushToggle } from './PushToggle';
import { ResendLinkForm } from './ResendLinkForm';

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

function formatCheckedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'an unknown time';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

/** Em dash for an observation we do not have yet (FR-25: never render a guess as a number). */
const UNKNOWN = '—';

/**
 * Render "3 of 350" for a count out of a total, or a dash when either side is
 * unknown. Deliberately refuses to render a bare numerator: "3" with no
 * denominator reads as a quantity when it is really a fraction, and a student
 * deciding what to drop needs the ratio.
 */
function formatOutOf(count: number | null, total: number | null): string {
  if (count === null || total === null) return UNKNOWN;
  return `${count} of ${total}`;
}

/**
 * How many of the open seats are RESERVED for a Reservation Group (FR-27).
 *
 * A live page on 2026-08-21 reported 41 open seats of which 41 were reserved for
 * "Students with Enrollment Permission" — enrollable by nobody else. Showing a bare
 * "41 of 520" there is technically true and practically a lie: a student reads it as
 * 41 seats they could take.
 *
 * `null` means the page published no reserved line, which is NOT a claim that none
 * are reserved — so we say nothing rather than "0 reserved".
 */
function describeReserved(freshness: WatchFreshness | undefined): string | null {
  if (!freshness) return null;
  const { openSeats, openReserved } = freshness;
  if (openReserved === null || openReserved <= 0) return null;
  if (openSeats !== null && openReserved >= openSeats) return 'all reserved';
  return `${openReserved} reserved`;
}

/**
 * Open waitlist SLOTS, which is `waitlistMax - waitlisted`.
 *
 * `waitlisted` is how many students are already QUEUED, not how many places are
 * free — rendering it directly would report a full waitlist (100 of 100) as
 * wide open. Clamped at zero because an over-full waitlist is a real observed
 * state on Berkeley's pages and a negative count is meaningless to a student.
 *
 * `waitlistOpen` GATES the result. The rule is an IMPLICATION, not a
 * biconditional — a rendered positive count implies `waitlistOpen === true`, but
 * `true` does NOT imply we can render a number:
 *
 *  - false  -> 0, whatever the arithmetic says. This is the field the ALERTING
 *              path derives from (`src/scraper/parse.ts`), so if the box claimed
 *              open spots while it is false, a student would read availability
 *              and then never receive the waitlist alert that number implies.
 *              Understating costs them one refresh; overstating costs trust.
 *  - null   -> dash. We do not know whether the waitlist is moving, so we cannot
 *              honestly show a count even when the arithmetic would produce one.
 *              Reachable for rows migrated before the observation columns existed.
 *  - true   -> use the counts, and dash if either is null. We gate on it but
 *              never fabricate from it: a count is a measurement, and inventing
 *              "at least 1" would put a number on the page that nothing observed.
 *
 * The values are stored as INDEPENDENT columns on `class_state` — `waitlistOpen`
 * NOT NULL, the counts nullable — so divergent snapshots are reachable even
 * though one parse pass cannot emit one. Trusting the arithmetic alone is what
 * makes that divergence user-visible.
 */
function openWaitlistSlots(freshness: WatchFreshness): number | null {
  const { waitlisted, waitlistMax, waitlistOpen } = freshness;
  if (waitlistOpen === false) return 0;
  if (waitlistOpen === null) return null;
  if (waitlisted === null || waitlistMax === null) return null;
  return Math.max(0, waitlistMax - waitlisted);
}

/**
 * One class the student is watching, as a clickable box (FR-25).
 *
 * Shows the class name, its enrollment code, open seats out of total, open
 * waitlist slots out of total, how fresh the observation is, and a Remove
 * control. The whole box links to the official Berkeley page, whose URL is
 * DERIVED from the classKey — never stored, never taken from the scraped page.
 *
 * Every observation is nullable: a watch added moments ago has no `class_state`
 * row yet and legitimately shows dashes everywhere. That is a normal new watch,
 * not an error, and must never look like a failure.
 */
function WatchCard({
  classKey,
  freshness,
  onRemove,
  removing,
  disabled,
}: {
  classKey: ClassKey;
  freshness: WatchFreshness | undefined;
  onRemove: () => void;
  removing: boolean;
  disabled: boolean;
}): React.ReactElement {
  const seats = freshness ? formatOutOf(freshness.openSeats, freshness.capacity) : UNKNOWN;
  const reserved = describeReserved(freshness);
  const waitlist = freshness
    ? formatOutOf(openWaitlistSlots(freshness), freshness.waitlistMax)
    : UNKNOWN;
  const heading = freshness?.displayName ?? classKey;

  return (
    <li className="watch-card">
      <div className="watch-card__head">
        <h4 className="watch-card__title">{heading}</h4>
        {/*
         * Only show the code separately when we have a real display name.
         * Without one the title already IS the class key, and rendering it twice
         * is visual noise that also makes the box ambiguous to a screen reader.
         */}
        {freshness?.displayName == null ? null : (
          <code className="watch-card__code">{classKey}</code>
        )}
      </div>

      <dl className="watch-card__stats">
        <div className="watch-card__stat">
          <dt>Open seats</dt>
          <dd>
            {seats}
            {reserved !== null && <span className="watch-card__caveat"> ({reserved})</span>}
          </dd>
        </div>
        <div className="watch-card__stat">
          <dt>Open waitlist spots</dt>
          <dd>{waitlist}</dd>
        </div>
      </dl>

      <FreshnessStatus freshness={freshness} />

      <div className="watch-card__actions">
        <a
          href={classPageUrl(classKey)}
          rel="noopener noreferrer"
          target="_blank"
          // The visible text is the same for every card, so the accessible name
          // must name the class or a screen-reader user hears "official page"
          // four times with no way to tell them apart.
          aria-label={`Open the official Berkeley page for ${heading} in a new tab`}
        >
          Official page
        </a>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing || disabled}
          aria-busy={removing}
          aria-label={`Remove watch for ${heading}`}
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </li>
  );
}

function FreshnessStatus({
  freshness,
}: {
  freshness: WatchFreshness | undefined;
}): React.ReactElement {
  if (freshness === undefined) {
    return (
      <p className="watch-freshness watch-freshness--stale">
        Source freshness is unavailable — treat this watch as stale and try reloading.
      </p>
    );
  }

  if (freshness.lastCheckedAt === null) {
    return (
      <p className="watch-freshness watch-freshness--stale">
        Source status is stale — waiting for the first successful check of Berkeley&apos;s public
        page.
      </p>
    );
  }

  return (
    <p className={`watch-freshness${freshness.sourceStale ? ' watch-freshness--stale' : ''}`}>
      {freshness.sourceStale ? 'Source status is stale.' : 'Source recently checked.'}{' '}
      Berkeley&apos;s public page was last checked{' '}
      <time dateTime={freshness.lastCheckedAt}>{formatCheckedAt(freshness.lastCheckedAt)}</time>.
    </p>
  );
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
          ? {
              status: 'ready',
              data: {
                ...prev.data,
                watches: updated.watches,
                watchFreshness: updated.watchFreshness,
              },
            }
          : prev,
      );
      setNewClass('');
      setAddError(undefined);
      setAddFieldTouched(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.error.code === 'conflict') {
          setAddError('already watching this class');
        } else if (err.error.code === 'watch_limit_reached') {
          // Distinct from `conflict` on purpose: the student is NOT already
          // watching this class, and distinct from `capacity_exceeded`, which
          // tells them to wait. Waiting never clears this — only they can.
          setAddError(
            `you are watching the maximum of ${MAX_WATCHES_PER_SUBSCRIBER} classes — remove one above to free a slot`,
          );
        } else if (err.error.code === 'validation_error') {
          setAddError(err.error.fields?.['classKey'] ?? err.error.message);
        } else if (err.error.code === 'payload_too_large') {
          setActionError('this request is too large — shorten the class identifier and try again');
        } else if (err.error.code === 'capacity_exceeded') {
          setActionError(
            `Seat Sniper has reached its current public-page monitoring capacity. Try again ${describeRetryAfter(err.retryAfterSeconds)}; your existing watches remain active.`,
          );
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
          data: {
            ...prev.data,
            watches: prev.data.watches.filter((k) => k !== classKey),
            watchFreshness: prev.data.watchFreshness.filter(
              (freshness) => freshness.classKey !== classKey,
            ),
          },
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
      <p className="hint">
        A confirmed Berkeley address proves control of that mailbox; it does not verify current
        enrollment or eligibility for a particular seat.
      </p>

      {!data.confirmed && (
        <div className="pending-banner" role="status" aria-live="polite">
          <p>
            <strong>Confirm your email to start receiving alerts.</strong> Your subscription is
            pending — we won&apos;t send any alerts until you confirm. Check your inbox for the
            confirmation link, or request a fresh one below.
          </p>
          <ResendLinkForm
            heading="Resend my confirmation link"
            headingId="pending-resend-heading"
          />
        </div>
      )}

      {actionError && (
        <p role="alert" className="error-banner">
          {actionError}
        </p>
      )}

      {/* Watch dashboard (FR-25) */}
      <section aria-labelledby="watches-heading">
        <h3 id="watches-heading">Classes you are watching</h3>
        <p className="hint">
          Availability comes from Berkeley&apos;s public class pages, not SIS. Their cache can delay
          changes; we aim to notify within two minutes after a change becomes visible to this
          service. A dash means we have not read that number yet.
        </p>
        <p className="watch-slots" role="status">
          {/* The cap is only actionable if the student can see where they stand. */}
          Using {data.watches.length} of {MAX_WATCHES_PER_SUBSCRIBER} slots.{' '}
          {data.watches.length >= MAX_WATCHES_PER_SUBSCRIBER
            ? 'Remove one below to free a slot for a different class.'
            : `You can add ${MAX_WATCHES_PER_SUBSCRIBER - data.watches.length} more.`}
        </p>
        {data.watches.length === 0 ? (
          <p>You are not watching any classes. Add one below.</p>
        ) : (
          <ul className="watch-grid" aria-label="watched classes">
            {data.watches.map((classKey, index) => {
              const freshness = data.watchFreshness[index];
              // The contract guarantees same-order entries and the client
              // validates that on arrival, but re-check per row: mislabeling one
              // class with another's seat counts would send a student to drop the
              // wrong class.
              const matchingFreshness = freshness?.classKey === classKey ? freshness : undefined;
              return (
                <WatchCard
                  key={classKey}
                  classKey={classKey as ClassKey}
                  freshness={matchingFreshness}
                  onRemove={() => {
                    void handleRemoveWatch(classKey as ClassKey);
                  }}
                  removing={removeBusy === classKey}
                  disabled={unsubBusy}
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* Add watch */}
      <section aria-labelledby="add-watch-heading">
        <h3 id="add-watch-heading">Add a class to watch</h3>
        {/*
         * At the cap, gate the form rather than let the student type a class and
         * discover the rule from a server error. The `watch_limit_reached`
         * branch in handleAddWatch stays as the backstop: this view can be stale
         * (another tab, or a revived watch), so the server remains authoritative.
         */}
        {data.watches.length >= MAX_WATCHES_PER_SUBSCRIBER && (
          <p className="field-error" role="status">
            You are watching the maximum of {MAX_WATCHES_PER_SUBSCRIBER} classes. Remove one above
            to free a slot.
          </p>
        )}
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
              disabled={addBusy || unsubBusy || data.watches.length >= MAX_WATCHES_PER_SUBSCRIBER}
            />
            {addFieldTouched && addError && (
              <span id="add-class-error" role="alert" className="field-error">
                {addError}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={addBusy || unsubBusy || data.watches.length >= MAX_WATCHES_PER_SUBSCRIBER}
            aria-busy={addBusy}
          >
            {addBusy ? 'Adding…' : 'Add watch'}
          </button>
        </form>
      </section>

      {/* Web push opt-in (per-browser, additive — FR-15) */}
      <PushToggle token={token} confirmed={data.confirmed} />

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
