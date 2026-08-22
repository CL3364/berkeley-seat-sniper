import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeDeadLetterIncident,
  alertDeliveries,
  cancelClaimedMailJob,
  claimMailBatch,
  claimMailJobs,
  classState,
  commitOpeningAndEnqueueMail,
  completeMailJob,
  confirmSubscriber,
  deadLetterMailJob,
  deadLetterIncidents,
  deferMailJob,
  enqueueSubscriberMail,
  getClassState,
  getSubscriberByEmail,
  isSuppressed,
  mailOutbox,
  makeRepo,
  makeTestDb,
  retireWatchesForClass,
  resolveDeadLetterIncident,
  subscribers,
  suppressEmail,
  suppressions,
  sweepRetention,
  upsertClassState,
  watches,
  type Db,
  type MailDispatchJob,
} from '../../src/db';
import { createMailDispatcher, createNoopTransport } from '../../src/notify';
import type {
  MailDispatchResult,
  ProviderOutcome,
  Transport,
  TransportMessage,
} from '../../src/notify/types';
import type { ClassKey } from '../../src/shared/class-key';

const TOKEN_SECRET = 'outbox-v04-test-token-secret-at-least-32-characters';
const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const CK_OTHER = '2026-fall-compsci-61a-001-lec-001' as ClassKey;
const CK_ORPHAN = '2026-spring-math-110-001-lec-001' as ClassKey;
const EMPTY_DASHBOARD_STATE = {
  displayName: null,
  lastEnrolled: null,
  lastCapacity: null,
  lastWaitlisted: null,
  lastWaitlistMax: null,
  lastOpenReserved: null,
} as const;

beforeEach(() => {
  process.env.TOKEN_SECRET = TOKEN_SECRET;
  delete process.env.NOOP_OUTBOX_FILE;
});

async function seedPending(
  db: Db,
  email = 'outbox-pending@berkeley.edu',
  classKey = CK,
): Promise<string> {
  return (await makeRepo(db).createSubscriber(email, [classKey])).id;
}

async function seedConfirmed(
  db: Db,
  email = 'outbox-confirmed@berkeley.edu',
  classKey = CK,
): Promise<string> {
  const id = await seedPending(db, email, classKey);
  expect(await confirmSubscriber(db, id)).toBe('confirmed');
  return id;
}

async function markAllCurrentMailSent(db: Db): Promise<void> {
  for (;;) {
    const jobs = await claimMailJobs(db);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      expect(
        await completeMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          providerAcceptedAt: new Date(),
        }),
      ).toBe(true);
    }
  }
}

async function enqueueOpening(
  db: Db,
  input: { openedAt?: Date; openSeats?: number } = {},
): Promise<void> {
  await upsertClassState(db, {
    classKey: CK,
    lastStatus: 'closed',
    lastOpenSeats: 0,
    lastWaitlistOpen: false,
    ...EMPTY_DASHBOARD_STATE,
    sourceFreshUntil: new Date(Date.now() + 120_000),
  });
  const baseline = await getClassState(db, CK);
  expect(baseline).toBeDefined();
  const openedAt = input.openedAt ?? new Date();
  const result = await commitOpeningAndEnqueueMail(db, {
    classKey: CK,
    previousStateVersion: baseline!.stateVersion,
    openedAt: openedAt.toISOString(),
    reason: 'seats-open',
    openSeats: input.openSeats ?? 1,
    nextState: {
      lastStatus: 'open',
      lastOpenSeats: input.openSeats ?? 1,
      lastWaitlistOpen: false,
      ...EMPTY_DASHBOARD_STATE,
      sourceFreshUntil: new Date(Date.now() + 120_000),
    },
  });
  expect(result.transitioned).toBe(true);
}

function resultFor(
  jobs: readonly MailDispatchJob[],
  results: readonly { jobId: string; result: MailDispatchResult }[],
  email: string,
): { job: MailDispatchJob; result: MailDispatchResult } {
  const job = jobs.find((candidate) => candidate.email === email);
  if (!job) throw new Error(`missing claimed test job for ${email}`);
  const result = results.find((candidate) => candidate.jobId === job.id)?.result;
  if (!result) throw new Error(`missing dispatcher result for ${job.id}`);
  return { job, result };
}

describe('AC-20 transactional durable enqueue', () => {
  it('commits Pending, Watches, and one opaque confirmation job together', async () => {
    const db = await makeTestDb();
    const email = 'transactional-create@berkeley.edu';
    const id = await seedPending(db, email);

    expect(await db.select().from(subscribers)).toHaveLength(1);
    expect(await db.select().from(watches)).toHaveLength(1);
    const [job] = await db.select().from(mailOutbox);
    expect(job).toMatchObject({
      kind: 'confirmation',
      subscriberId: id,
      classKey: null,
      status: 'queued',
      attempts: 0,
      payload: {},
    });
    expect(JSON.stringify(job)).not.toContain(email);
    expect(JSON.stringify(job)).not.toContain('token');
  });

  it('rolls the subscriber and watches back when confirmation enqueue fails', async () => {
    const db = await makeTestDb();
    await db.execute(
      sql.raw(`
      create function fail_test_confirmation_enqueue() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'confirmation' then
          raise exception 'forced confirmation enqueue failure';
        end if;
        return new;
      end
      $$
    `),
    );
    await db.execute(
      sql.raw(`
      create trigger fail_test_confirmation_enqueue_trigger
      before insert on mail_outbox
      for each row execute function fail_test_confirmation_enqueue()
    `),
    );

    await expect(seedPending(db, 'transaction-rollback@berkeley.edu')).rejects.toThrow();
    expect(await getSubscriberByEmail(db, 'transaction-rollback@berkeley.edu')).toBeUndefined();
    expect(await db.select().from(subscribers)).toHaveLength(0);
    expect(await db.select().from(watches)).toHaveLength(0);
    expect(await db.select().from(mailOutbox)).toHaveLength(0);
  });

  it('rolls the class-state transition back when Alert fan-out enqueue fails', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db, 'opening-rollback@berkeley.edu');
    await markAllCurrentMailSent(db);
    await upsertClassState(db, {
      classKey: CK,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      ...EMPTY_DASHBOARD_STATE,
    });
    const baseline = await getClassState(db, CK);
    await db.execute(
      sql.raw(`
      create function fail_test_alert_enqueue() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'alert' then
          raise exception 'forced alert enqueue failure';
        end if;
        return new;
      end
      $$
    `),
    );
    await db.execute(
      sql.raw(`
      create trigger fail_test_alert_enqueue_trigger
      before insert on mail_outbox
      for each row execute function fail_test_alert_enqueue()
    `),
    );

    await expect(
      commitOpeningAndEnqueueMail(db, {
        classKey: CK,
        previousStateVersion: baseline!.stateVersion,
        openedAt: new Date().toISOString(),
        reason: 'seats-open',
        openSeats: 2,
        nextState: {
          lastStatus: 'open',
          lastOpenSeats: 2,
          lastWaitlistOpen: false,
          ...EMPTY_DASHBOARD_STATE,
        },
      }),
    ).rejects.toThrow();

    expect(await getClassState(db, CK)).toMatchObject({
      lastStatus: 'closed',
      lastOpenSeats: 0,
      stateVersion: baseline!.stateVersion,
    });
    expect((await db.select().from(mailOutbox)).filter((job) => job.kind === 'alert')).toHaveLength(
      0,
    );
  });

  it('uses one resend statement for Pending, Confirmed, unknown, and suppressed addresses', async () => {
    const db = await makeTestDb();
    const repo = makeRepo(db);
    const pendingId = await seedPending(db, 'resend-pending@berkeley.edu');
    const confirmedId = await seedConfirmed(db, 'resend-confirmed@berkeley.edu', CK_OTHER);
    const suppressedId = await seedPending(db, 'resend-suppressed@berkeley.edu', CK_ORPHAN);
    await suppressEmail(db, 'resend-suppressed@berkeley.edu', 'complaint');
    const jobsBeforeResend = await db.select().from(mailOutbox);
    const execute = vi.spyOn(db, 'execute');

    async function expectSingleRoundTrip(email: string, enqueued: boolean): Promise<void> {
      execute.mockClear();
      expect(await repo.enqueueResendMailByEmail(email)).toEqual({ enqueued });
      expect(execute).toHaveBeenCalledOnce();
    }

    await expectSingleRoundTrip('resend-pending@berkeley.edu', true);
    await expectSingleRoundTrip('resend-confirmed@berkeley.edu', true);
    await expectSingleRoundTrip('resend-unknown@berkeley.edu', false);
    await expectSingleRoundTrip('resend-suppressed@berkeley.edu', false);
    execute.mockRestore();

    const jobs = await db.select().from(mailOutbox);
    expect(jobs).toHaveLength(jobsBeforeResend.length + 2);
    expect(
      jobs.filter((job) => job.subscriberId === pendingId && job.kind === 'confirmation'),
    ).toHaveLength(2);
    expect(
      jobs.filter((job) => job.subscriberId === confirmedId && job.kind === 'manage-link'),
    ).toHaveLength(1);
    expect(jobs.filter((job) => job.subscriberId === suppressedId)).toHaveLength(1);
  });
});

describe('AC-19 claim fencing, crash windows, and typed outcomes', () => {
  it('pre-claim dead-letters queued and reclaimable processing jobs at the 23-hour horizon', async () => {
    const db = await makeTestDb();
    await seedPending(db, 'horizon-queued@berkeley.edu', CK);
    await seedPending(db, 'horizon-processing@berkeley.edu', CK_OTHER);
    const [processing] = await claimMailJobs(db, { limit: 1, leaseSeconds: 60 });
    if (!processing) throw new Error('expected one processing mail job');
    const rows = await db.select().from(mailOutbox);
    const queued = rows.find((job) => job.id !== processing.id);
    if (!queued) throw new Error('expected one queued mail job');
    const oldCreatedAt = new Date(Date.now() - 24 * 60 * 60_000);
    const staleClaimedAt = new Date(Date.now() - 2 * 60_000);

    await db
      .update(mailOutbox)
      .set({ createdAt: oldCreatedAt, updatedAt: new Date() })
      .where(eq(mailOutbox.id, queued.id));
    await db
      .update(mailOutbox)
      .set({
        createdAt: oldCreatedAt,
        claimedAt: staleClaimedAt,
        updatedAt: new Date(),
      })
      .where(eq(mailOutbox.id, processing.id));

    const claimed = await claimMailBatch(db, { leaseSeconds: 60 });
    expect(claimed).toEqual({ jobs: [], deadLetteredRetryHorizon: 2 });
    expect(await db.select().from(mailOutbox)).toEqual([
      expect.objectContaining({
        status: 'dead_letter',
        terminalReason: 'retry-horizon',
      }),
      expect.objectContaining({
        status: 'dead_letter',
        terminalReason: 'retry-horizon',
      }),
    ]);
  });

  it('reclaims an expired lease with the same idempotency key and fences the stale claimant', async () => {
    const db = await makeTestDb();
    await seedPending(db, 'claim-fence@berkeley.edu');
    const [first] = await claimMailJobs(db, { leaseSeconds: 1 });
    expect(first).toBeDefined();

    await db
      .update(mailOutbox)
      .set({ claimedAt: new Date(Date.now() - 2_000), updatedAt: new Date() })
      .where(eq(mailOutbox.id, first!.id));
    const [reclaimed] = await claimMailJobs(db, { leaseSeconds: 1 });
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.id).toBe(first!.id);
    expect(reclaimed!.claimToken).not.toBe(first!.claimToken);
    expect(reclaimed!.providerIdempotencyKey).toBe(first!.providerIdempotencyKey);
    expect(reclaimed!.attempts).toBe(2);

    expect(
      await completeMailJob(db, {
        id: first!.id,
        claimToken: first!.claimToken,
        providerAcceptedAt: new Date(),
      }),
    ).toBe(false);
    expect(
      await completeMailJob(db, {
        id: reclaimed!.id,
        claimToken: reclaimed!.claimToken,
        providerAcceptedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('documents the accept-before-mark crash window while reusing one provider key', async () => {
    const db = await makeTestDb();
    await seedPending(db, 'accept-mark-crash@berkeley.edu');
    const dispatcher = createMailDispatcher({
      transport: createNoopTransport(),
      isSuppressed: async () => false,
      push: null,
    });
    const [first] = await claimMailJobs(db, { leaseSeconds: 1 });
    const accepted = await dispatcher.dispatch(first!);
    expect(accepted.status).toBe('success');
    expect(dispatcher.outbox).toHaveLength(1);

    // Simulate process death after provider acceptance but before the durable
    // success mark. A later worker reclaims the lease and retries the same key.
    await db
      .update(mailOutbox)
      .set({ claimedAt: new Date(Date.now() - 2_000), updatedAt: new Date() })
      .where(eq(mailOutbox.id, first!.id));
    const [reclaimed] = await claimMailJobs(db, { leaseSeconds: 1 });
    const retried = await dispatcher.dispatch(reclaimed!);
    expect(retried.status).toBe('success');
    expect(dispatcher.outbox).toHaveLength(2);
    expect(dispatcher.outbox[0].idempotencyKey).toBe(dispatcher.outbox[1].idempotencyKey);
    expect(dispatcher.outbox[0].idempotencyKey).toBe(first!.providerIdempotencyKey);
    expect(
      await completeMailJob(db, {
        id: reclaimed!.id,
        claimToken: reclaimed!.claimToken,
        providerAcceptedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('maps typed dispatcher outcomes to sent, queued, rate-deferred, and dead-letter states', async () => {
    const db = await makeTestDb();
    const addresses = {
      success: 'typed-success@berkeley.edu',
      retryable: 'typed-retry@berkeley.edu',
      rateLimited: 'typed-rate@berkeley.edu',
      permanent: 'typed-permanent@berkeley.edu',
    };
    for (const [index, email] of Object.values(addresses).entries()) {
      await seedPending(
        db,
        email,
        `2026-fall-compsci-${String(100 + index)}-001-lec-001` as ClassKey,
      );
    }

    const seen = new Map<string, string | undefined>();
    const outcomes = new Map<string, ProviderOutcome>([
      [
        addresses.success,
        { status: 'success', providerMessageId: 'provider-ok', acceptedAt: new Date() },
      ],
      [addresses.retryable, { status: 'retryable', errorCode: 'provider_unavailable' }],
      [
        addresses.rateLimited,
        {
          status: 'rate-limited',
          errorCode: 'provider_rate_limited',
          retryAfterMs: 2_500,
        },
      ],
      [addresses.permanent, { status: 'permanent', errorCode: 'provider_http_422' }],
    ]);
    const transport: Transport = {
      async send(message: TransportMessage) {
        seen.set(message.to, message.idempotencyKey);
        return outcomes.get(message.to);
      },
    };
    const dispatcher = createMailDispatcher({
      transport,
      isSuppressed: async () => false,
      push: null,
    });
    const jobs = await claimMailJobs(db);
    const results = await dispatcher.dispatchBatch(jobs);

    const success = resultFor(jobs, results, addresses.success);
    expect(success.result.status).toBe('success');
    expect(
      await completeMailJob(db, {
        id: success.job.id,
        claimToken: success.job.claimToken,
        providerMessageId:
          success.result.status === 'success' ? success.result.providerMessageId : undefined,
        providerAcceptedAt:
          success.result.status === 'success' ? success.result.acceptedAt : undefined,
      }),
    ).toBe(true);

    const retryable = resultFor(jobs, results, addresses.retryable);
    expect(retryable.result).toEqual({
      status: 'retryable',
      errorCode: 'provider_unavailable',
    });
    expect(
      await deferMailJob(db, {
        id: retryable.job.id,
        claimToken: retryable.job.claimToken,
        availableAt: new Date(Date.now() + 1_000),
        errorCode: 'provider_unavailable',
      }),
    ).toBe('deferred');

    const rateLimited = resultFor(jobs, results, addresses.rateLimited);
    expect(rateLimited.result).toMatchObject({
      status: 'rate-limited',
      retryAfterMs: 2_500,
    });
    expect(
      await deferMailJob(db, {
        id: rateLimited.job.id,
        claimToken: rateLimited.job.claimToken,
        availableAt: new Date(Date.now() + 2_500),
        errorCode: 'provider_rate_limited',
      }),
    ).toBe('deferred');

    const permanent = resultFor(jobs, results, addresses.permanent);
    expect(permanent.result).toEqual({
      status: 'permanent',
      errorCode: 'provider_http_422',
    });
    expect(
      await deadLetterMailJob(db, {
        id: permanent.job.id,
        claimToken: permanent.job.claimToken,
        errorCode: 'provider_http_422',
      }),
    ).toBe(true);

    const rows = new Map((await db.select().from(mailOutbox)).map((row) => [row.id, row]));
    expect(rows.get(success.job.id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(rows.get(retryable.job.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'provider_unavailable',
    });
    expect(rows.get(rateLimited.job.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'provider_rate_limited',
    });
    expect(rows.get(permanent.job.id)).toMatchObject({
      status: 'dead_letter',
      terminalReason: 'permanent-failure',
    });
    for (const job of jobs) {
      expect(seen.get(job.email!)).toBe(job.providerIdempotencyKey);
    }
  });
});

describe('dispatch-time suppression and opening cancellation', () => {
  it('fails closed when suppression status is unavailable and leaves the job retryable', async () => {
    const db = await makeTestDb();
    await seedPending(db, 'suppression-unknown@berkeley.edu');
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(),
      }),
    );
    const dispatcher = createMailDispatcher({
      transport: { send },
      isSuppressed: async () => {
        throw new Error('suppression store unavailable');
      },
      push: null,
    });
    const [job] = await claimMailJobs(db);
    const result = await dispatcher.dispatch(job!);

    expect(result).toEqual({
      status: 'retryable',
      errorCode: 'suppression_check_failed',
    });
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.outbox).toHaveLength(0);
    expect(
      await deferMailJob(db, {
        id: job!.id,
        claimToken: job!.claimToken,
        availableAt: new Date(Date.now() + 1_000),
        errorCode: 'suppression_check_failed',
      }),
    ).toBe('deferred');
    expect((await db.select().from(mailOutbox))[0]).toMatchObject({
      status: 'queued',
      lastErrorCode: 'suppression_check_failed',
    });
  });

  it('claim-fence-cancels a suppressed job without provider egress', async () => {
    const db = await makeTestDb();
    const email = 'suppression-cancel@berkeley.edu';
    await seedPending(db, email);
    await suppressEmail(db, email, 'bounce');
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(),
      }),
    );
    const dispatcher = createMailDispatcher({
      transport: { send },
      isSuppressed: (candidate) => isSuppressed(db, candidate),
      push: null,
    });
    const [job] = await claimMailJobs(db);
    const result = await dispatcher.dispatch(job!);
    expect(result.status).toBe('suppressed');
    expect(send).not.toHaveBeenCalled();
    expect(
      await cancelClaimedMailJob(db, {
        id: job!.id,
        claimToken: job!.claimToken,
        reason: 'suppressed',
      }),
    ).toBe(true);
    expect((await db.select().from(mailOutbox))[0]).toMatchObject({
      status: 'cancelled',
      terminalReason: 'suppressed',
    });
  });

  it('cancels a queued opening when a later successful observation proves it closed', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db, 'opening-closes@berkeley.edu');
    await markAllCurrentMailSent(db);
    await enqueueOpening(db);
    expect((await db.select().from(mailOutbox)).filter((job) => job.kind === 'alert')).toHaveLength(
      1,
    );

    await upsertClassState(db, {
      classKey: CK,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      ...EMPTY_DASHBOARD_STATE,
    });

    const alert = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(alert).toMatchObject({
      status: 'cancelled',
      terminalReason: 'opening-closed',
    });
  });

  it('expires an unsent Alert older than one hour before it can be claimed', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db, 'opening-expired@berkeley.edu');
    await markAllCurrentMailSent(db);
    await enqueueOpening(db, { openedAt: new Date(Date.now() - 61 * 60_000) });

    expect(await claimMailJobs(db)).toHaveLength(0);
    const alert = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(alert).toMatchObject({
      status: 'cancelled',
      terminalReason: 'expired',
    });
  });

  it('dead-letters non-Alert mail before crossing the provider idempotency horizon', async () => {
    const db = await makeTestDb();
    await seedPending(db, 'retry-horizon@berkeley.edu');
    const [job] = await claimMailJobs(db);

    expect(
      await deferMailJob(db, {
        id: job!.id,
        claimToken: job!.claimToken,
        availableAt: new Date(job!.createdAt.getTime() + 24 * 60 * 60_000),
        errorCode: 'provider_unavailable',
      }),
    ).toBe('dead-lettered-retry-horizon');
    expect((await db.select().from(mailOutbox))[0]).toMatchObject({
      status: 'dead_letter',
      terminalReason: 'retry-horizon',
      lastErrorCode: 'provider_unavailable',
    });
  });
});

describe('FR-18 bounded retention', () => {
  it('retains unresolved/acknowledged incident jobs and purges only resolved old dead letters', async () => {
    const db = await makeTestDb();
    await Promise.all([
      seedPending(db, 'retention-unresolved@berkeley.edu'),
      seedPending(db, 'retention-acknowledged@berkeley.edu', CK_OTHER),
      seedPending(db, 'retention-resolved@berkeley.edu', CK_ORPHAN),
    ]);
    const claimed = await claimMailJobs(db, { limit: 10 });
    expect(claimed).toHaveLength(3);
    for (const job of claimed) {
      expect(
        await deadLetterMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          errorCode: 'retention_test_failure',
        }),
      ).toBe(true);
    }

    const incidents = await db.select().from(deadLetterIncidents);
    expect(incidents).toHaveLength(3);
    const acknowledged = incidents[1];
    const resolved = incidents[2];
    if (!acknowledged || !resolved) throw new Error('expected three incidents');
    expect(await acknowledgeDeadLetterIncident(db, acknowledged.id)).toBe(true);
    expect(await resolveDeadLetterIncident(db, resolved.id)).toBe(true);

    await db.execute(sql`
      update ${mailOutbox}
      set created_at = clock_timestamp() - interval '100 days',
          updated_at = clock_timestamp() - interval '91 days',
          terminal_at = clock_timestamp() - interval '91 days'
      where status = 'dead_letter'
    `);
    const swept = await sweepRetention(db, new Date());
    expect(swept.terminalMailJobs).toBe(1);

    const retainedJobs = await db.select().from(mailOutbox);
    expect(new Set(retainedJobs.map((job) => job.id))).toEqual(
      new Set(
        incidents
          .filter((incident) => incident.id !== resolved.id)
          .map((incident) => incident.mailJobId),
      ),
    );
    const retainedIncidents = await db.select().from(deadLetterIncidents);
    expect(retainedIncidents.map((incident) => incident.state).sort()).toEqual([
      'acknowledged',
      'unresolved',
    ]);
  });

  it('purges 72-hour Pending and 90-day terminal/retired/orphaned data but preserves Confirmed and suppression', async () => {
    const db = await makeTestDb();
    const pendingId = await seedPending(db, 'retention-pending@berkeley.edu', CK_ORPHAN);
    const confirmedId = await seedConfirmed(db, 'retention-confirmed@berkeley.edu', CK_OTHER);
    const retiredOwnerId = await seedConfirmed(db, 'retention-retired@berkeley.edu', CK);
    await suppressEmail(db, 'retained-suppression@berkeley.edu', 'complaint');

    await db
      .update(subscribers)
      .set({ createdAt: new Date(Date.now() - 73 * 60 * 60_000) })
      .where(eq(subscribers.id, pendingId));

    const claimed = await claimMailJobs(db);
    const terminalJob = claimed.find((job) => job.subscriberId === confirmedId);
    expect(terminalJob).toBeDefined();
    await completeMailJob(db, {
      id: terminalJob!.id,
      claimToken: terminalJob!.claimToken,
      providerAcceptedAt: new Date(Date.now() - 91 * 24 * 60 * 60_000),
    });
    await db.execute(sql`
      update ${mailOutbox}
      set created_at = clock_timestamp() - interval '100 days',
          updated_at = clock_timestamp() - interval '91 days',
          sent_at = clock_timestamp() - interval '91 days',
          provider_accepted_at = clock_timestamp() - interval '91 days',
          terminal_at = clock_timestamp() - interval '91 days'
      where id = ${terminalJob!.id}
    `);
    await enqueueSubscriberMail(db, confirmedId, 'manage-link');

    const legacyWatch = (await db.select().from(watches)).find(
      (watch) => watch.subscriberId === confirmedId && watch.classKey === CK_OTHER,
    );
    if (!legacyWatch) throw new Error('expected retained subscriber watch');
    if (legacyWatch.activationOrder === null) {
      throw new Error('expected confirmed watch activation order');
    }
    const legacyOpenedAt = new Date(Date.now() - 100 * 24 * 60 * 60_000);
    const legacyTerminalAt = new Date(Date.now() - 91 * 24 * 60 * 60_000);
    await db.insert(alertDeliveries).values({
      subscriberId: confirmedId,
      classKey: CK_OTHER,
      openedAt: legacyOpenedAt,
      reason: 'seats-open',
      openSeats: 1,
      watchActivationOrder: legacyWatch.activationOrder,
      sentAt: legacyTerminalAt,
      terminalAt: legacyTerminalAt,
      expiresAt: new Date(legacyOpenedAt.getTime() + 60 * 60_000),
      providerIdempotencyKey: 'test/legacy-retention',
      providerAcceptedAt: legacyTerminalAt,
      attemptCount: 1,
      nextAttemptAt: legacyTerminalAt,
      createdAt: legacyOpenedAt,
    });

    await upsertClassState(db, {
      classKey: CK,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      ...EMPTY_DASHBOARD_STATE,
      sourceFreshUntil: new Date(Date.now() - 91 * 24 * 60 * 60_000),
    });
    expect(await retireWatchesForClass(db, CK)).toBe(1);
    await db.execute(sql`
      update ${watches}
      set created_at = clock_timestamp() - interval '100 days',
          retired_at = clock_timestamp() - interval '91 days'
      where subscriber_id = ${retiredOwnerId}
        and class_key = ${CK}
    `);
    await db.execute(sql`
      update ${classState}
      set updated_at = clock_timestamp() - interval '91 days',
          source_fresh_until = clock_timestamp() - interval '91 days'
      where class_key = ${CK}
    `);

    await upsertClassState(db, {
      classKey: CK_ORPHAN,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      ...EMPTY_DASHBOARD_STATE,
      sourceFreshUntil: new Date(Date.now() - 91 * 24 * 60 * 60_000),
    });
    await db.execute(sql`
      update ${classState}
      set updated_at = clock_timestamp() - interval '91 days',
          source_fresh_until = clock_timestamp() - interval '91 days'
      where class_key = ${CK_ORPHAN}
    `);

    const result = await sweepRetention(db, new Date());
    expect(result).toMatchObject({
      pendingSubscribers: 1,
      terminalMailJobs: 1,
      legacyAlertDeliveries: 1,
      retiredWatches: 1,
      orphanedClassStates: 2,
      expiredMailJobs: 0,
    });
    expect(await getSubscriberByEmail(db, 'retention-pending@berkeley.edu')).toBeUndefined();
    expect(await getSubscriberByEmail(db, 'retention-confirmed@berkeley.edu')).toBeDefined();
    expect(await getSubscriberByEmail(db, 'retention-retired@berkeley.edu')).toBeDefined();
    expect(await db.select().from(suppressions)).toHaveLength(1);
    expect(await db.select().from(alertDeliveries)).toHaveLength(0);
    expect(await isSuppressed(db, 'retained-suppression@berkeley.edu')).toBe(true);
    expect(
      (await db.select().from(mailOutbox)).some(
        (job) => job.subscriberId === confirmedId && job.kind === 'manage-link',
      ),
    ).toBe(true);
  });
});
