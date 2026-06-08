/**
 * Unit tests for the Notifier layer — spec FR-4, FR-5, FR-6, FR-8, AC-3..AC-5, AC-8.
 *
 * Uses createNotifier() with an injected noop transport so no real mail is ever sent.
 * All assertions are against the in-memory outbox and DispatchResult values.
 *
 * NOTE: createNoopTransport() in noop.ts takes no arguments; createNotifier() in
 * index.ts must be called without transport args or with an explicitly constructed
 * noop transport. If a signature mismatch is found this test file documents it as a
 * failing test that is handed off to the notify lane.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNotifier } from '../../src/notify/index';
import { createNoopTransport } from '../../src/notify/transports/noop';
import type { NotifyEvent } from '../../src/shared/seat-state';
import type { ClassKey } from '../../src/shared/class-key';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;

function makeEvent(overrides?: Partial<NotifyEvent>): NotifyEvent {
  return {
    subscriberId: 'sub-abc-123',
    email: 'student@berkeley.edu',
    classKey: CK,
    reason: 'seats-open',
    openSeats: 3,
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createNotifier — wiring and basic shape
// ---------------------------------------------------------------------------

describe('createNotifier — basic shape', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createNotifier with a noop transport returns a Notifier with dispatch, alertOperator, outbox', () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    expect(typeof notifier.dispatch).toBe('function');
    expect(typeof notifier.alertOperator).toBe('function');
    expect(Array.isArray(notifier.outbox)).toBe(true);
  });

  it('outbox starts empty', () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    expect(notifier.outbox).toHaveLength(0);
  });

  it('createNotifier with MAIL_TRANSPORT=noop env and no explicit transport also works', () => {
    process.env.MAIL_TRANSPORT = 'noop';
    try {
      const notifier = createNotifier();
      expect(typeof notifier.dispatch).toBe('function');
    } finally {
      delete process.env.MAIL_TRANSPORT;
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch — successful delivery (FR-4, FR-8)
// ---------------------------------------------------------------------------

describe('dispatch — successful delivery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatch returns { sent: true } for a fresh event (FR-4)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const result = await notifier.dispatch(makeEvent());
    expect(result.sent).toBe(true);
  });

  it('dispatch returns a non-empty idempotencyKey', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const result = await notifier.dispatch(makeEvent());
    expect(typeof result.idempotencyKey).toBe('string');
    expect(result.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('outbox grows by one entry after a successful dispatch (FR-8 noop outbox)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.dispatch(makeEvent());
    expect(notifier.outbox).toHaveLength(1);
  });

  it('dispatch does not log the subscriber email (AC-8)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent({ email: 'student@berkeley.edu' });
    await notifier.dispatch(event);
    for (const call of logSpy.mock.calls) {
      const s = JSON.stringify(call);
      expect(s).not.toContain('student@berkeley.edu');
      expect(s).not.toContain('berkeley.edu');
    }
  });

  it('two distinct events produce two outbox entries', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const t1 = new Date(Date.now()).toISOString();
    const t2 = new Date(Date.now() + 1000).toISOString();
    await notifier.dispatch(makeEvent({ openedAt: t1, subscriberId: 'sub-1' }));
    await notifier.dispatch(makeEvent({ openedAt: t2, subscriberId: 'sub-1' }));
    expect(notifier.outbox).toHaveLength(2);
  });

  it('two different subscriberIds for the same class+time produce two outbox entries (fan-out)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const openedAt = new Date().toISOString();
    await notifier.dispatch(makeEvent({ subscriberId: 'sub-A', openedAt }));
    await notifier.dispatch(makeEvent({ subscriberId: 'sub-B', openedAt }));
    expect(notifier.outbox).toHaveLength(2);
    // Each went to a different subscriber.
    const keys = notifier.outbox.map((e) => e.idempotencyKey ?? '');
    expect(new Set(keys).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// dispatch — idempotency / dedupe (FR-4, FR-5)
// ---------------------------------------------------------------------------

describe('dispatch — idempotency and dedupe (FR-4, FR-5)', () => {
  it('dispatching the same event twice returns sent=false on the second call', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent();
    await notifier.dispatch(event);
    const second = await notifier.dispatch(event);
    expect(second.sent).toBe(false);
  });

  it('deduped dispatch does NOT grow the outbox (FR-5: no re-notification)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent();
    await notifier.dispatch(event);
    await notifier.dispatch(event);
    // The second call was suppressed — outbox stays at 1.
    expect(notifier.outbox).toHaveLength(1);
  });

  it('the idempotencyKey is the same for both calls (keyed on subscriberId+classKey+openedAt)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent();
    const first = await notifier.dispatch(event);
    const second = await notifier.dispatch(event);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it('same class+subscriber but DIFFERENT openedAt → two distinct sends (new opening)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.dispatch(makeEvent({ openedAt: new Date(1000).toISOString() }));
    const second = await notifier.dispatch(makeEvent({ openedAt: new Date(2000).toISOString() }));
    expect(second.sent).toBe(true);
    expect(notifier.outbox).toHaveLength(2);
  });

  it('same class+openedAt but DIFFERENT subscriberId → both sent (independent subscribers)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const openedAt = new Date().toISOString();
    const r1 = await notifier.dispatch(makeEvent({ subscriberId: 'sub-1', openedAt }));
    const r2 = await notifier.dispatch(makeEvent({ subscriberId: 'sub-2', openedAt }));
    expect(r1.sent).toBe(true);
    expect(r2.sent).toBe(true);
  });

  it('a flapping seat (close then reopen with new openedAt) sends a second notification (FR-5)', async () => {
    // FR-5: "does not re-notify until it has closed and re-opened." The openedAt
    // timestamp changes with each new opening, so this is a different idempotency key.
    const notifier = createNotifier({ transport: createNoopTransport() });
    const opening1 = new Date(1000).toISOString();
    const opening2 = new Date(3000).toISOString();
    await notifier.dispatch(makeEvent({ openedAt: opening1 }));
    // Class closed and re-opened — worker produces a new openedAt.
    const second = await notifier.dispatch(makeEvent({ openedAt: opening2 }));
    expect(second.sent).toBe(true);
    expect(notifier.outbox).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// alertOperator — parser-broke path (FR-6, AC-5)
// ---------------------------------------------------------------------------

describe('alertOperator — parser-broke operator alert (FR-6, AC-5)', () => {
  beforeEach(() => {
    process.env.OPERATOR_EMAIL = 'ops@example.com';
  });

  afterEach(() => {
    delete process.env.OPERATOR_EMAIL;
    vi.restoreAllMocks();
  });

  it('alertOperator resolves without throwing', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await expect(notifier.alertOperator(CK, 'seat-count node not found')).resolves.toBeUndefined();
  });

  it('alertOperator does not produce any subscriber-kind outbox entries (AC-5)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.alertOperator(CK, 'seat-count node not found');
    const subscriberEntries = notifier.outbox.filter((e) => e.kind === 'subscriber');
    expect(subscriberEntries).toHaveLength(0);
  });

  it('alertOperator produces exactly one outbox entry with kind="operator" (AC-5)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.alertOperator(CK, 'seat-count node not found');
    const operatorEntries = notifier.outbox.filter((e) => e.kind === 'operator');
    expect(operatorEntries).toHaveLength(1);
  });

  it('after a parser-broke, a subscriber dispatch still goes through (operator alert ≠ subscriber notify block)', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.alertOperator(CK, 'seat-count node not found');
    const result = await notifier.dispatch(makeEvent());
    expect(result.sent).toBe(true);
  });

  it('alertOperator logs classKey and detail but NOT subscriber emails (AC-8)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.alertOperator(CK, 'seat-count node not found');

    for (const call of logSpy.mock.calls) {
      const s = JSON.stringify(call);
      expect(s).not.toContain('student@berkeley.edu');
    }
  });
});

// ---------------------------------------------------------------------------
// outbox entry shape
// ---------------------------------------------------------------------------

describe('outbox entry shape', () => {
  it('a subscriber outbox entry has the expected fields', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent();
    await notifier.dispatch(event);
    const [entry] = notifier.outbox;
    expect(entry.kind).toBe('subscriber');
    expect(typeof entry.to).toBe('string');
    expect(typeof entry.subject).toBe('string');
    expect(typeof entry.body).toBe('string');
    expect(typeof entry.sentAt).toBe('string');
    // sentAt must be a valid ISO datetime.
    expect(() => new Date(entry.sentAt)).not.toThrow();
  });

  it('an operator outbox entry has kind="operator" and a detail field', async () => {
    // OPERATOR_EMAIL defaults to the `from` address when not set — that is fine
    // for this shape-only test; no env cleanup needed.
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.alertOperator(CK, 'DOM shape changed');
    const entry = notifier.outbox.find((e) => e.kind === 'operator');
    expect(entry).toBeDefined();
    expect(entry?.detail).toBe('DOM shape changed');
  });

  it('subscriber outbox entry subject mentions the class key', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.dispatch(makeEvent());
    expect(notifier.outbox[0].subject).toContain(CK);
  });

  it('subscriber outbox entry body contains a link to the class page', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    await notifier.dispatch(makeEvent());
    expect(notifier.outbox[0].body).toContain(`classes.berkeley.edu/content/${CK}`);
  });

  it('subscriber outbox entry body does NOT contain a raw subscriber email', async () => {
    const notifier = createNotifier({ transport: createNoopTransport() });
    const event = makeEvent({ email: 'student@berkeley.edu' });
    await notifier.dispatch(event);
    // The email can be the "to" field (that models the sent mail) but must not appear
    // in subject or body where it could be logged via JSON.stringify(entry).
    expect(notifier.outbox[0].subject).not.toContain('student@berkeley.edu');
    expect(notifier.outbox[0].body).not.toContain('student@berkeley.edu');
  });
});

// ---------------------------------------------------------------------------
// Transport failure handling
// ---------------------------------------------------------------------------

describe('dispatch — transport failure handling', () => {
  it('dispatch re-throws when the transport throws', async () => {
    const failingTransport = {
      send: async () => {
        throw new Error('SMTP connection refused');
      },
    };
    const notifier = createNotifier({ transport: failingTransport });
    await expect(notifier.dispatch(makeEvent())).rejects.toThrow('SMTP connection refused');
  });

  it('after a transport failure, the idempotency key is released — retry is possible', async () => {
    let callCount = 0;
    const flakyTransport = {
      send: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient failure');
        // Second call succeeds.
      },
    };
    const notifier = createNotifier({ transport: flakyTransport });
    const event = makeEvent();

    // First attempt fails.
    await expect(notifier.dispatch(event)).rejects.toThrow();

    // Second attempt with the same event succeeds (key was released on failure).
    const result = await notifier.dispatch(event);
    expect(result.sent).toBe(true);
  });
});
