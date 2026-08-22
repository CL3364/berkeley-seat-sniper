/**
 * Unit tests — Notifier v0.3 behaviors (FR-12, FR-14, FR-15, §6, AC-13, AC-15b, AC-16).
 *
 * All against an injected noop / recording transport + injected isSuppressed +
 * an injected fake push transport, so no real mail, no real push, no db. Covers:
 *   - suppression at dispatch: a suppressed address → no email, no push, nothing
 *     in the outbox, DispatchResult.suppressed === true (AC-13 end-to-end seam).
 *   - confirmation / manage-link bodies carry their pinned link on its own line
 *     and the List-Unsubscribe(-Post) headers are set on subscriber-facing mail.
 *   - push delivery via the fake transport (AC-16a): exactly one alerts-only
 *     payload per endpoint, with NO token / confirm / manage URL anywhere.
 *   - push failure isolation (AC-16b): a throwing push transport never blocks the
 *     email — the alert outbox entry is still present and dispatch resolves.
 *   - 410 "gone" cleanup: a gone endpoint triggers deletePushSubscription.
 *   - fail-loud env (AC-15b): a non-noop transport without OPERATOR_EMAIL /
 *     APP_BASE_URL throws at construction (no real send).
 *   - reserved-seat caveat copy (ADR 0006 mitigation) in the seat-open email.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotifier, createNoopTransport, createFakePushTransport } from '../../src/notify';
import type {
  DispatchResult,
  Transport,
  TransportMessage,
  PushDeps,
  PushTarget,
} from '../../src/notify/types';
import { createRealTransport, createResendTransport } from '../../src/notify/transports/smtp';
import { isPublicNetworkAddress, readVapidConfig } from '../../src/notify/transports/push';
import type { NotifyEvent } from '../../src/shared/seat-state';
import type { ClassKey } from '../../src/shared/class-key';

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const EMAIL = 'student@berkeley.edu';
const TOKEN = 'signed.manage.token-abc';
const REAL_TRANSPORT_TOKEN_SECRET = 'notifier-v03-token-secret-at-least-32-characters';

function makeEvent(overrides?: Partial<NotifyEvent>): NotifyEvent {
  return {
    subscriberId: 'sub-1',
    email: EMAIL,
    classKey: CK,
    reason: 'seats-open',
    openSeats: 3,
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A transport that records every message it is asked to send (incl. headers). */
function recordingTransport(): Transport & { sent: TransportMessage[] } {
  const sent: TransportMessage[] = [];
  return {
    sent,
    async send(message: TransportMessage): Promise<void> {
      sent.push(message);
    },
  };
}

function createNotifierWithInjectedRealTransport(
  options: Parameters<typeof createNotifier>[0],
): ReturnType<typeof createNotifier> {
  const previous = process.env.TOKEN_SECRET;
  process.env.TOKEN_SECRET = REAL_TRANSPORT_TOKEN_SECRET;
  try {
    return createNotifier(options);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_SECRET;
    else process.env.TOKEN_SECRET = previous;
  }
}

/** A PushDeps backed by a fake transport + an in-memory target list + delete spy. */
function fakePushDeps(targets: PushTarget[], opts: { enabled?: boolean } = {}) {
  const transport = createFakePushTransport({ enabled: opts.enabled ?? true });
  const deleted: string[] = [];
  const deps: PushDeps = {
    transport,
    async listPushSubscriptions(): Promise<PushTarget[]> {
      return targets;
    },
    async deletePushSubscriptionIfMatches(
      _subscriberId: string,
      target: PushTarget,
    ): Promise<void> {
      deleted.push(target.endpoint);
    },
  };
  return { deps, transport, deleted };
}

async function eventualPushed(result: DispatchResult): Promise<number> {
  return result.pushCompletion ? result.pushCompletion : result.pushed;
}

afterEach(() => vi.restoreAllMocks());

describe('push egress address guard', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public DNS answer %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public DNS answer %s',
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Suppression at dispatch (FR-12 / AC-13 seam)
// ---------------------------------------------------------------------------

describe('suppression: a suppressed address receives nothing on dispatch (FR-12)', () => {
  it('AC-13: dispatch to a suppressed address sends no email and records nothing in the outbox', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => true, // address is suppressed
    });
    const result = await notifier.dispatch(makeEvent());

    expect(result.sent).toBe(false);
    expect(result.suppressed).toBe(true);
    expect(result.pushed).toBe(0);
    expect(notifier.outbox).toHaveLength(0);
  });

  it('AC-13: a non-suppressed address dispatches normally (guard against false-suppress)', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
    });
    const result = await notifier.dispatch(makeEvent());
    expect(result.sent).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(notifier.outbox.filter((e) => e.kind === 'alert')).toHaveLength(1);
  });

  it('AC-13: sendConfirmation to a suppressed address returns { sent:false, suppressed:true } and writes no outbox entry', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => true,
      appBaseUrl: 'https://app.example.com',
    });
    const res = await notifier.sendConfirmation({
      subscriberId: 'sub-1',
      email: EMAIL,
      token: TOKEN,
    });
    expect(res).toEqual({ sent: false, suppressed: true });
    expect(notifier.outbox).toHaveLength(0);
  });

  it('AC-13: sendManageLink to a suppressed address is withheld', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => true,
      appBaseUrl: 'https://app.example.com',
    });
    const res = await notifier.sendManageLink({
      subscriberId: 'sub-1',
      email: EMAIL,
      token: TOKEN,
    });
    expect(res.sent).toBe(false);
    expect(res.suppressed).toBe(true);
    expect(notifier.outbox).toHaveLength(0);
  });

  it('AC-13: when one address is suppressed, another still gets its alert', async () => {
    const suppressed = 'suppressed@berkeley.edu';
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async (email) => email === suppressed,
    });
    const r1 = await notifier.dispatch(makeEvent({ subscriberId: 's1', email: suppressed }));
    const r2 = await notifier.dispatch(makeEvent({ subscriberId: 's2', email: 'ok@berkeley.edu' }));
    expect(r1.suppressed).toBe(true);
    expect(r2.sent).toBe(true);
    const alerts = notifier.outbox.filter((e) => e.kind === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].to).toBe('ok@berkeley.edu');
  });
});

// ---------------------------------------------------------------------------
// Pinned links + List-Unsubscribe headers (§4 / §6)
// ---------------------------------------------------------------------------

describe('confirmation / manage-link bodies + List-Unsubscribe headers (§4/§6)', () => {
  const BASE = 'https://app.example.com';

  it('confirmation body carries the ?confirm=<token> link on its own line', async () => {
    const t = recordingTransport();
    const notifier = createNotifierWithInjectedRealTransport({
      transport: t,
      isSuppressed: async () => false,
      appBaseUrl: BASE,
    });
    await notifier.sendConfirmation({ subscriberId: 'sub-1', email: EMAIL, token: TOKEN });

    const message = t.sent.find((entry) => entry.subject.toLowerCase().includes('confirm'));
    expect(message).toBeDefined();
    expect(message!.body).toContain(`${BASE}/?confirm=${TOKEN}`);
    // Extractable by a simple line-anchored regex (the e2e/test contract).
    expect(message!.body).toMatch(/^https:\/\/app\.example\.com\/\?confirm=.+$/m);
    // An unbranded transport models a real provider: no PII/token snapshot is
    // retained in the noop-only test outbox.
    expect(notifier.outbox).toHaveLength(0);
  });

  it('manage-link body carries the ?token=<token> link on its own line', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      appBaseUrl: BASE,
    });
    await notifier.sendManageLink({ subscriberId: 'sub-1', email: EMAIL, token: TOKEN });

    const entry = notifier.outbox.find((e) => e.kind === 'manage-link');
    expect(entry).toBeDefined();
    expect(entry!.body).toContain(`${BASE}/?token=${TOKEN}`);
    expect(entry!.body).toMatch(/^https:\/\/app\.example\.com\/\?token=.+$/m);
  });

  it('§6: confirmation mail carries List-Unsubscribe + List-Unsubscribe-Post headers', async () => {
    const t = recordingTransport();
    const notifier = createNotifierWithInjectedRealTransport({
      transport: t,
      isSuppressed: async () => false,
      appBaseUrl: BASE,
    });
    await notifier.sendConfirmation({ subscriberId: 'sub-1', email: EMAIL, token: TOKEN });

    const msg = t.sent.find((m) => m.subject.toLowerCase().includes('confirm'));
    expect(msg).toBeDefined();
    expect(msg!.headers?.['List-Unsubscribe']).toMatch(
      /^<https:\/\/app\.example\.com\/api\/subscriptions\/.+\/unsubscribe>$/,
    );
    expect(msg!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('§6: manage-link mail carries the List-Unsubscribe headers', async () => {
    const t = recordingTransport();
    const notifier = createNotifierWithInjectedRealTransport({
      transport: t,
      isSuppressed: async () => false,
      appBaseUrl: BASE,
    });
    await notifier.sendManageLink({ subscriberId: 'sub-1', email: EMAIL, token: TOKEN });

    const msg = t.sent.at(-1)!;
    expect(msg.headers?.['List-Unsubscribe']).toContain('/unsubscribe>');
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('§6: an alert email carries List-Unsubscribe headers when a manage token is supplied', async () => {
    const t = recordingTransport();
    const notifier = createNotifierWithInjectedRealTransport({
      transport: t,
      isSuppressed: async () => false,
      appBaseUrl: BASE,
    });
    await notifier.dispatch(makeEvent(), TOKEN);

    const msg = t.sent.at(-1)!;
    expect(msg.headers?.['List-Unsubscribe']).toContain('/unsubscribe>');
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});

// ---------------------------------------------------------------------------
// Reserved-seat caveat copy (ADR 0006 mitigation / M7)
// ---------------------------------------------------------------------------

describe('alert copy: reserved-seat caveat (ADR 0006)', () => {
  it('the seat-open alert body warns that some seats are reserved and may not be enrollable', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
    });
    await notifier.dispatch(makeEvent());
    const entry = notifier.outbox.find((e) => e.kind === 'alert');
    expect(entry).toBeDefined();
    expect(entry!.body.toLowerCase()).toContain('reserved');
    expect(entry!.body.toLowerCase()).toMatch(/enrollable|eligibility/);
  });

  it('the alert body does NOT contain the subscriber email (AC-8: outbox subject/body are PII-free)', async () => {
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
    });
    await notifier.dispatch(makeEvent({ email: EMAIL }));
    const entry = notifier.outbox.find((e) => e.kind === 'alert')!;
    expect(entry.subject).not.toContain(EMAIL);
    expect(entry.body).not.toContain(EMAIL);
  });
});

// ---------------------------------------------------------------------------
// Push delivery via the fake transport (FR-15 / AC-16)
// ---------------------------------------------------------------------------

describe('AC-16: web push via the fake transport', () => {
  const target: PushTarget = {
    endpoint: 'https://push.example.com/endpoint/abc',
    keys: { p256dh: 'p256dh-material', auth: 'auth-material' },
  };

  it('AC-16a: a confirmed subscriber with one endpoint gets exactly one alerts-only payload pushed', async () => {
    const { deps, transport } = fakePushDeps([target]);
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: deps,
    });
    const result = await notifier.dispatch(makeEvent());

    expect(result.sent).toBe(true);
    expect(await eventualPushed(result)).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].endpoint).toBe(target.endpoint);
  });

  it('AC-16a: the pushed payload carries classKey + reason and NO token / confirm / manage URL / email', async () => {
    const { deps, transport } = fakePushDeps([target]);
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: deps,
    });
    const result = await notifier.dispatch(makeEvent({ openReserved: 3 }), TOKEN); // even WITH a manage token
    await eventualPushed(result);

    const payload = transport.sent[0].payload;
    expect(payload.kind).toBe('alert');
    expect(payload.classKey).toBe(CK);
    expect(payload.reason).toBe('seats-open');
    expect(payload.openReserved).toBe(3);
    // No secret/PII ever leaves in a push.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain('confirm=');
    expect(serialized).not.toContain('token=');
  });

  it('AC-16b: when the push transport THROWS, the email alert is still delivered and the cycle completes', async () => {
    const { deps, transport } = fakePushDeps([target]);
    transport.throwOn(target.endpoint); // next send throws
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: deps,
    });

    // dispatch resolves (does not reject) and the alert email outbox entry exists.
    const result = await notifier.dispatch(makeEvent());
    expect(result.sent).toBe(true);
    expect(await eventualPushed(result)).toBe(0); // the push failed but was isolated
    expect(notifier.outbox.filter((e) => e.kind === 'alert')).toHaveLength(1);
  });

  it('AC-16b: a push 410 "gone" triggers endpoint cleanup via deletePushSubscription', async () => {
    const { deps, transport, deleted } = fakePushDeps([target]);
    transport.markGone(target.endpoint); // service reports the subscription gone
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: deps,
    });
    const result = await notifier.dispatch(makeEvent());
    await eventualPushed(result);

    expect(deleted).toContain(target.endpoint);
  });

  it('a disabled (VAPID-unconfigured) push transport pushes nothing but still delivers the email', async () => {
    const { deps, transport } = fakePushDeps([target], { enabled: false });
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: deps,
    });
    const result = await notifier.dispatch(makeEvent());
    expect(await eventualPushed(result)).toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect(notifier.outbox.filter((e) => e.kind === 'alert')).toHaveLength(1);
  });

  it('a suppressed email address still receives alerts-only push', async () => {
    const { deps, transport } = fakePushDeps([target]);
    const notifier = createNotifier({
      transport: createNoopTransport(),
      isSuppressed: async () => true,
      push: deps,
    });
    const result = await notifier.dispatch(makeEvent());
    expect(result.suppressed).toBe(true);
    expect(await eventualPushed(result)).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// v0.3.3 delivery robustness
// ---------------------------------------------------------------------------

describe('v0.3.3: delivery robustness and production retention', () => {
  it('claims an idempotency key before an awaited suppression check', async () => {
    let releaseSuppression!: (suppressed: boolean) => void;
    const suppression = new Promise<boolean>((resolve) => {
      releaseSuppression = resolve;
    });
    const mail = recordingTransport();
    const notifier = createNotifierWithInjectedRealTransport({
      transport: mail,
      isSuppressed: async () => suppression,
    });
    const event = makeEvent({ openedAt: '2026-07-21T00:00:00.000Z' });

    const first = notifier.dispatch(event);
    const duplicate = notifier.dispatch(event);
    releaseSuppression(false);
    const results = await Promise.all([first, duplicate]);

    expect(results.map((result) => result.sent)).toEqual([true, true]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].idempotencyKey).toBe(results[0].idempotencyKey);
  });

  it('shares an in-flight transport failure with every duplicate caller', async () => {
    let releaseSuppression!: () => void;
    const suppressionGate = new Promise<void>((resolve) => {
      releaseSuppression = resolve;
    });
    let sends = 0;
    const notifier = createNotifierWithInjectedRealTransport({
      transport: {
        async send() {
          sends += 1;
          throw new Error('provider unavailable');
        },
      },
      isSuppressed: async () => {
        await suppressionGate;
        return false;
      },
    });
    const event = makeEvent({ openedAt: '2026-07-21T00:00:01.000Z' });

    const first = notifier.dispatch(event);
    const duplicate = notifier.dispatch(event);
    releaseSuppression();
    const outcomes = await Promise.allSettled([first, duplicate]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(sends).toBe(1);
  });

  it('bounds push fan-out concurrency at five targets', async () => {
    const targets = Array.from({ length: 12 }, (_, index) => ({
      endpoint: `https://push.example.com/endpoint/${index}`,
      keys: { p256dh: `p-${index}`, auth: `a-${index}` },
    }));
    let active = 0;
    let peak = 0;
    const push: PushDeps = {
      transport: {
        enabled: true,
        async send() {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 3));
          active -= 1;
          return { ok: true, gone: false };
        },
      },
      async listPushSubscriptions() {
        return targets;
      },
      async deletePushSubscriptionIfMatches() {},
    };
    const notifier = createNotifierWithInjectedRealTransport({
      transport: recordingTransport(),
      isSuppressed: async () => false,
      push,
    });

    const result = await notifier.dispatch(makeEvent());
    expect(await eventualPushed(result)).toBe(12);
    expect(peak).toBe(5);
  });

  it('does not let hanging pushes delay later subscriber emails and caps them globally', async () => {
    let releasePush!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    let activePush = 0;
    let peakPush = 0;
    const mail = recordingTransport();
    const push: PushDeps = {
      transport: {
        enabled: true,
        async send() {
          activePush += 1;
          peakPush = Math.max(peakPush, activePush);
          await blocked;
          activePush -= 1;
          return { ok: true, gone: false };
        },
      },
      async listPushSubscriptions(subscriberId) {
        return [
          {
            endpoint: `https://push.example.com/${subscriberId}`,
            keys: { p256dh: 'p256dh', auth: 'auth' },
          },
        ];
      },
      async deletePushSubscriptionIfMatches() {},
    };
    const notifier = createNotifierWithInjectedRealTransport({
      transport: mail,
      isSuppressed: async () => false,
      push,
    });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        notifier.dispatch(
          makeEvent({
            subscriberId: `sub-${index}`,
            email: `student-${index}@berkeley.edu`,
          }),
        ),
      ),
    );

    // Every email resolves while all push sends are still blocked.
    expect(mail.sent).toHaveLength(30);
    expect(peakPush).toBe(20);

    releasePush();
    await Promise.all(results.map(eventualPushed));
  });

  it('rethrows operator transport failures and records no false success', async () => {
    const notifier = createNotifier({
      transport: {
        kind: 'noop',
        async send() {
          throw new Error('provider unavailable');
        },
      },
    });

    await expect(notifier.alertOperator(CK, 'parser failed')).rejects.toThrow(
      'provider unavailable',
    );
    expect(notifier.outbox).toHaveLength(0);
  });

  it('ignores NOOP_OUTBOX_FILE for an unbranded transport with one warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-sniper-outbox-gate-'));
    const outboxPath = join(dir, 'outbox.ndjson');
    process.env.NOOP_OUTBOX_FILE = outboxPath;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const notifier = createNotifierWithInjectedRealTransport({
        transport: recordingTransport(),
        isSuppressed: async () => false,
        appBaseUrl: 'https://app.example.com',
      });
      await notifier.sendConfirmation({ subscriberId: 'sub-1', email: EMAIL, token: TOKEN });

      expect(existsSync(outboxPath)).toBe(false);
      expect(notifier.outbox).toHaveLength(0);
      const warnings = logSpy.mock.calls.filter((call) =>
        JSON.stringify(call).includes('noop_outbox_file_ignored'),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      delete process.env.NOOP_OUTBOX_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives Resend an AbortSignal and provider idempotency header', async () => {
    process.env.SEND_TIMEOUT_MS = '25';
    let observedSignal: AbortSignal | undefined;
    let observedHeaders: Record<string, string> | undefined;
    try {
      const transport = createResendTransport(
        { provider: 'resend', apiKey: 're_test_only', from: 'alerts@example.com' },
        async (_url, init) => {
          observedSignal = init.signal;
          observedHeaders = init.headers;
          return { ok: true, status: 200 };
        },
      );
      await transport.send({
        to: EMAIL,
        from: 'alerts@example.com',
        subject: 'test',
        body: 'test',
        idempotencyKey: 'sub-1:class-key:opened-at',
      });

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedHeaders?.['Idempotency-Key']).toBe('sub-1:class-key:opened-at');
    } finally {
      delete process.env.SEND_TIMEOUT_MS;
    }
  });

  it('fails at construction when an unsupported provider is selected', () => {
    Object.assign(process.env, {
      MAIL_PROVIDER: 'smtp',
      MAIL_FROM: 'alerts@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'test-user',
      SMTP_PASS: 'test-pass',
    });
    try {
      expect(() => createRealTransport()).toThrow(/supports 'resend'/);
    } finally {
      for (const key of [
        'MAIL_PROVIDER',
        'MAIL_FROM',
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_USER',
        'SMTP_PASS',
      ]) {
        delete process.env[key];
      }
    }
  });

  it('rejects partial VAPID configuration instead of silently disabling push', () => {
    process.env.VAPID_PUBLIC_KEY = 'public-only';
    try {
      expect(() => readVapidConfig()).toThrow(/must be set together/);
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_SUBJECT;
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-loud env for a non-noop transport (FR-14 / §6 / AC-15b)
// ---------------------------------------------------------------------------

describe('AC-15b: fail-loud construction for a non-noop transport', () => {
  afterEach(() => {
    delete process.env.MAIL_TRANSPORT;
    delete process.env.OPERATOR_EMAIL;
    delete process.env.APP_BASE_URL;
    delete process.env.MAIL_FROM;
    delete process.env.MAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  // The real transport itself validates MAIL_FROM + RESEND_API_KEY first; we set
  // those (fake, never used — no real send because construction throws on the
  // notifier's OPERATOR_EMAIL/APP_BASE_URL gate) so the test reaches that gate.
  function withRealTransportEnv(): void {
    process.env.MAIL_TRANSPORT = 'real';
    process.env.MAIL_PROVIDER = 'resend';
    process.env.MAIL_FROM = 'alerts@example.com';
    process.env.RESEND_API_KEY = 're_test_fake_key_never_used';
  }

  it('AC-15b: a non-noop transport with OPERATOR_EMAIL unset throws at construction', () => {
    withRealTransportEnv();
    process.env.APP_BASE_URL = 'https://app.example.com';
    delete process.env.OPERATOR_EMAIL;
    expect(() => createNotifier()).toThrow(/OPERATOR_EMAIL/);
  });

  it('AC-15b: a non-noop transport with APP_BASE_URL unset throws at construction', () => {
    withRealTransportEnv();
    process.env.OPERATOR_EMAIL = 'ops@example.com';
    delete process.env.APP_BASE_URL;
    expect(() => createNotifier()).toThrow(/APP_BASE_URL/);
  });

  it('a Resend transport without RESEND_WEBHOOK_SECRET throws at construction', () => {
    withRealTransportEnv();
    process.env.OPERATOR_EMAIL = 'ops@example.com';
    process.env.APP_BASE_URL = 'https://app.example.com';
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect(() => createNotifier()).toThrow(/RESEND_WEBHOOK_SECRET/);
  });

  it('rejects a non-HTTPS or non-origin APP_BASE_URL before real mail can carry tokens', () => {
    withRealTransportEnv();
    process.env.OPERATOR_EMAIL = 'ops@example.com';
    process.env.APP_BASE_URL = 'http://public.example.com/app';
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_test_only';
    expect(() => createNotifier()).toThrow(/absolute HTTPS origin/);
  });

  it('an explicitly-injected transport skips the fail-loud env requirement (test path)', () => {
    delete process.env.OPERATOR_EMAIL;
    delete process.env.APP_BASE_URL;
    // Passing a transport means the caller owns transport selection — no throw.
    expect(() => createNotifier({ transport: createNoopTransport() })).not.toThrow();
  });

  it('the noop default requires no extra env (dev/test/CI)', () => {
    delete process.env.MAIL_TRANSPORT; // defaults to noop
    delete process.env.OPERATOR_EMAIL;
    delete process.env.APP_BASE_URL;
    expect(() => createNotifier()).not.toThrow();
  });
});
