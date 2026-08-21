import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeDeadLetterIncident,
  claimMailJobs,
  confirmSubscriber,
  deadLetterIncidents,
  deadLetterMailJob,
  enqueueOperatorMail,
  getMailOutboxHealth,
  getSubscriberByEmail,
  mailOutbox,
  makeRepo,
  makeTestDb,
  parserHealth,
  resolveDeadLetterIncident,
  subscribers,
  type Db,
} from '../../src/db';
import { createMailDispatcher, type MailDispatcher, type ProviderOutcome } from '../../src/notify';
import type { AvailabilitySource, SourceCacheMetadata } from '../../src/scraper';
import { readWorkerReadiness } from '../../src/server/worker-readiness';
import type { ClassKey } from '../../src/shared/class-key';
import type { ParseResult } from '../../src/shared/seat-state';
import { createWorkerHeartbeat } from '../../src/worker/poller';
import {
  SourceScheduleState,
  createMaintenanceState,
  createWorkerRepo,
  readV04WorkerConfig,
  runOutboxDispatchCycle,
  runSourcePollCycle,
  type V04Logger,
  type V04WorkerConfig,
} from '../../src/worker/public';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const SOURCE_TIMES = [
  '2026-07-24T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z',
  '2026-08-24T00:00:00.000Z',
  '2026-08-25T00:00:00.000Z',
  '2026-08-26T00:00:00.000Z',
] as const;

let originalKillSwitch: string | undefined;
let originalNoopOutboxFile: string | undefined;
let originalHeartbeatFile: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  originalNoopOutboxFile = process.env.NOOP_OUTBOX_FILE;
  originalHeartbeatFile = process.env.WORKER_HEARTBEAT_FILE;
  process.env.KILL_SWITCH = '0';
  delete process.env.NOOP_OUTBOX_FILE;
  delete process.env.WORKER_HEARTBEAT_FILE;
});

afterEach(() => {
  restoreEnv('KILL_SWITCH', originalKillSwitch);
  restoreEnv('NOOP_OUTBOX_FILE', originalNoopOutboxFile);
  restoreEnv('WORKER_HEARTBEAT_FILE', originalHeartbeatFile);
  vi.restoreAllMocks();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function logger(): V04Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function workerConfig(overrides: Partial<V04WorkerConfig> = {}): V04WorkerConfig {
  return {
    ...readV04WorkerConfig({}),
    pollJitterMs: 0,
    sourceRequestsPerSecond: 1,
    ...overrides,
  };
}

function cacheAt(checkedAt: string): SourceCacheMetadata {
  return {
    checkedAt,
    cacheControl: 'max-age=0',
    ageSeconds: 0,
    maxAgeSeconds: 0,
    freshForSeconds: 0,
    freshUntil: checkedAt,
    etag: '"saved-fixture"',
    lastModified: null,
  };
}

function sourceReturning(
  checkedAt: string,
  resultFor: (classKey: ClassKey) => ParseResult,
): AvailabilitySource & {
  beginCycle: ReturnType<typeof vi.fn>;
  endCycle: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn<AvailabilitySource['fetch']>>;
} {
  const beginCycle = vi.fn();
  const endCycle = vi.fn();
  const fetch = vi.fn<AvailabilitySource['fetch']>(async (classKey, request) => {
    const runWithPermit = request?.runWithOriginPermit;
    if (!runWithPermit) throw new Error('source cycle omitted the physical-request permit');
    const started = await runWithPermit(
      { kind: 'class', signal: new AbortController().signal },
      () => ({
        started: Promise.resolve({
          kind: 'result' as const,
          result: resultFor(classKey),
          cache: cacheAt(checkedAt),
        }),
      }),
    );
    return started.started;
  });
  return { beginCycle, endCycle, fetch };
}

function unusedMailDispatcher(): MailDispatcher {
  return {
    async dispatch() {
      throw new Error('source-only cycle reached mail dispatch');
    },
    async dispatchBatch() {
      throw new Error('source-only cycle reached mail dispatch');
    },
    outbox: [],
  };
}

async function runReinstantiatedSourceCycle(
  db: Db,
  checkedAt: string,
  resultFor: (classKey: ClassKey) => ParseResult,
  log = logger(),
) {
  const source = sourceReturning(checkedAt, resultFor);
  const summary = await runSourcePollCycle({
    repo: createWorkerRepo(db),
    source,
    mailDispatcher: unusedMailDispatcher(),
    schedule: new SourceScheduleState(),
    maintenance: createMaintenanceState(),
    config: workerConfig(),
    logger: log,
    nowMs: () => Date.parse(checkedAt),
    random: () => 0,
    sleep: async () => undefined,
  });
  expect(source.beginCycle).toHaveBeenCalledOnce();
  expect(source.endCycle).toHaveBeenCalledOnce();
  expect(source.fetch).toHaveBeenCalledOnce();
  return summary;
}

describe('v0.4.2 durable parser-broke episodes (AC-15)', () => {
  it('enqueues once across cycles and worker re-instantiation, then rearms only after recovery', async () => {
    const db = await makeTestDb();
    const created = await makeRepo(db).createSubscriber('parser-episode@berkeley.edu', [CLASS_KEY]);
    expect(await confirmSubscriber(db, created.id)).toBe('confirmed');

    const broken = (classKey: ClassKey): ParseResult => ({
      kind: 'parser-broke',
      classKey,
      detail: 'saved fixture no longer has exactly one Total Open Seats field',
    });
    const first = await runReinstantiatedSourceCycle(db, SOURCE_TIMES[0], broken);
    const second = await runReinstantiatedSourceCycle(db, SOURCE_TIMES[1], broken);
    const beyondFormerCooldown = await runReinstantiatedSourceCycle(db, SOURCE_TIMES[2], broken);

    expect(first.operatorAlerted).toEqual([CLASS_KEY]);
    expect(second.operatorAlerted).toEqual([]);
    expect(beyondFormerCooldown.operatorAlerted).toEqual([]);
    expect(
      (await db.select().from(mailOutbox)).filter((job) => job.kind === 'operator'),
    ).toHaveLength(1);
    expect(await db.select().from(parserHealth)).toEqual([
      expect.objectContaining({
        classKey: CLASS_KEY,
        status: 'broken',
        recoveredAt: null,
      }),
    ]);

    const recoveryLog = logger();
    const recovery = await runReinstantiatedSourceCycle(
      db,
      SOURCE_TIMES[3],
      (classKey) => ({
        classKey,
        status: 'closed',
        openSeats: 0,
        waitlistOpen: false,
        fetchedAt: SOURCE_TIMES[3],
      }),
      recoveryLog,
    );
    expect(recovery.operatorAlerted).toEqual([]);
    expect(recoveryLog.info).toHaveBeenCalledWith({
      event: 'operator_episode_recovered',
      classKey: CLASS_KEY,
      classification: 'parser_recovered',
    });
    expect(await db.select().from(parserHealth)).toEqual([
      expect.objectContaining({
        classKey: CLASS_KEY,
        status: 'healthy',
        recoveredAt: expect.any(Date),
      }),
    ]);

    const nextEpisode = await runReinstantiatedSourceCycle(db, SOURCE_TIMES[4], broken);
    expect(nextEpisode.operatorAlerted).toEqual([CLASS_KEY]);
    expect(
      (await db.select().from(mailOutbox)).filter((job) => job.kind === 'operator'),
    ).toHaveLength(2);
    expect(await db.select().from(parserHealth)).toEqual([
      expect.objectContaining({
        classKey: CLASS_KEY,
        status: 'broken',
        recoveredAt: null,
      }),
    ]);
  });
});

describe('v0.4.2 dead-letter incident publication (AC-27)', () => {
  it('retries one stable key, surfaces once, stays unresolved, and never recurses through mail', async () => {
    const db = await makeTestDb();
    await makeRepo(db).createSubscriber('dead-letter@berkeley.edu', [CLASS_KEY]);
    const operatorJobId = await enqueueOperatorMail(db, {
      classKey: CLASS_KEY,
      detail: 'original operator delivery failed',
    });

    const claimed = await claimMailJobs(db, { limit: 10 });
    expect(claimed).toHaveLength(2);
    for (const job of claimed) {
      const input = {
        id: job.id,
        claimToken: job.claimToken,
        errorCode: 'simulated_permanent_failure',
      };
      expect(await deadLetterMailJob(db, input)).toBe(true);
      expect(await deadLetterMailJob(db, input)).toBe(false);
    }

    const opened = await db.select().from(deadLetterIncidents);
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map((incident) => incident.mailJobId))).toEqual(
      new Set(claimed.map((job) => job.id)),
    );
    expect(opened.some((incident) => incident.mailJobId === operatorJobId)).toBe(true);
    expect(await db.select().from(mailOutbox)).toHaveLength(2);

    const attempts = new Map<string, number>();
    const attemptedKeys: string[] = [];
    const transport = {
      kind: 'noop' as const,
      async send(message: { idempotencyKey?: string }): Promise<ProviderOutcome> {
        const key = message.idempotencyKey;
        if (!key) throw new Error('incident publication omitted its idempotency key');
        attemptedKeys.push(key);
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return attempt === 1
          ? { status: 'retryable', errorCode: 'incident_sink_unavailable' }
          : { status: 'success', acceptedAt: new Date() };
      },
    };
    const dispatcher = createMailDispatcher({
      transport,
      operatorEmail: 'operator@berkeley.edu',
      from: 'alerts@berkeley.edu',
      appBaseUrl: 'http://localhost:5173',
      isSuppressed: async () => false,
      mintToken: async () => 'unused-incident-token',
      push: null,
    });
    const repo = createWorkerRepo(db);
    const maintenance = createMaintenanceState();
    const config = workerConfig({ outboxBatchSize: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cycle = () =>
      runOutboxDispatchCycle({
        repo,
        mailDispatcher: dispatcher,
        maintenance,
        config,
        logger: logger(),
      });

    const firstPublish = await cycle();
    expect(firstPublish).toMatchObject({
      incidentsClaimed: 2,
      incidentsPublished: 0,
      incidentPublishDeferred: 2,
    });
    expect(dispatcher.outbox).toHaveLength(0);

    const acceptedPublish = await cycle();
    expect(acceptedPublish).toMatchObject({
      incidentsClaimed: 2,
      incidentsPublished: 2,
      incidentPublishDeferred: 0,
    });
    expect(dispatcher.outbox).toHaveLength(2);

    const afterAcceptance = await cycle();
    expect(afterAcceptance.incidentsClaimed).toBe(0);
    expect(attemptedKeys).toHaveLength(4);
    for (const incident of opened) {
      const stableKey = `dead-letter/${incident.id}`;
      expect(attemptedKeys.filter((key) => key === stableKey)).toHaveLength(2);
    }

    const surfaced = await db.select().from(deadLetterIncidents);
    expect(surfaced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'unresolved', surfacedAt: expect.any(Date) }),
        expect.objectContaining({ state: 'unresolved', surfacedAt: expect.any(Date) }),
      ]),
    );
    expect(await getMailOutboxHealth(db)).toMatchObject({ deadLetter: 2 });

    const firstIncident = surfaced[0];
    const secondIncident = surfaced[1];
    if (!firstIncident || !secondIncident) throw new Error('expected two durable incidents');
    expect(await acknowledgeDeadLetterIncident(db, firstIncident.id)).toBe(true);
    expect(await acknowledgeDeadLetterIncident(db, firstIncident.id)).toBe(false);
    expect(await getMailOutboxHealth(db)).toMatchObject({ deadLetter: 1 });
    expect(await resolveDeadLetterIncident(db, secondIncident.id)).toBe(true);
    expect(await getMailOutboxHealth(db)).toMatchObject({ deadLetter: 0 });

    // External publication is intentionally out-of-band. Even the incident for
    // a failed Operator job creates no recursive durable Operator mail.
    expect(await db.select().from(mailOutbox)).toHaveLength(2);
    expect(
      (await db.select().from(mailOutbox)).filter((job) => job.kind === 'operator'),
    ).toHaveLength(1);
  });
});

describe('v0.4.2 source and dispatcher isolation (AC-28)', () => {
  it('keeps an eligible source cycle moving while a multi-batch provider backlog is blocked', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const backlogSize = 22;
    for (let index = 0; index < backlogSize; index += 1) {
      const created = await api.createSubscriber(`isolation-${index}@berkeley.edu`, [CLASS_KEY]);
      if (index === 0) expect(await confirmSubscriber(db, created.id)).toBe('confirmed');
    }
    expect(await db.select().from(mailOutbox)).toHaveLength(backlogSize);

    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let firstProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      firstProviderStarted = resolve;
    });
    let activeProviderRequests = 0;
    let maximumProviderRequests = 0;
    let providerRequestCount = 0;
    const transport = {
      kind: 'noop' as const,
      async send(): Promise<ProviderOutcome> {
        activeProviderRequests += 1;
        providerRequestCount += 1;
        maximumProviderRequests = Math.max(maximumProviderRequests, activeProviderRequests);
        if (providerRequestCount === 1) firstProviderStarted();
        await providerGate;
        activeProviderRequests -= 1;
        return { status: 'success', acceptedAt: new Date() };
      },
    };
    const dispatcher = createMailDispatcher({
      transport,
      from: 'alerts@berkeley.edu',
      operatorEmail: 'operator@berkeley.edu',
      appBaseUrl: 'http://localhost:5173',
      isSuppressed: async () => false,
      mintToken: async () => 'stable-test-token',
      push: null,
    });
    const repo = createWorkerRepo(db);
    const config = workerConfig({ outboxBatchSize: 21 });
    let dispatcherSettled = false;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dispatchCycle = runOutboxDispatchCycle({
      repo,
      mailDispatcher: dispatcher,
      maintenance: createMaintenanceState(),
      config,
      logger: logger(),
    }).finally(() => {
      dispatcherSettled = true;
    });

    await providerStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const activeWhileBlocked = activeProviderRequests;
    const dispatcherWasBlocked = !dispatcherSettled;

    const source = sourceReturning(new Date().toISOString(), (classKey) => ({
      classKey,
      status: 'closed',
      openSeats: 0,
      waitlistOpen: false,
      fetchedAt: new Date().toISOString(),
    }));
    const sourceProgress = vi.fn();
    let sourceSummary;
    try {
      sourceSummary = await runSourcePollCycle({
        repo,
        source,
        mailDispatcher: dispatcher,
        schedule: new SourceScheduleState(),
        maintenance: createMaintenanceState(),
        config,
        logger: logger(),
        random: () => 0,
        sleep: async () => undefined,
        onProgress: sourceProgress,
      });
    } finally {
      releaseProvider();
    }
    const dispatchSummary = await dispatchCycle;

    expect(dispatcherWasBlocked).toBe(true);
    expect(activeWhileBlocked).toBeGreaterThan(0);
    expect(activeWhileBlocked).toBeLessThanOrEqual(20);
    expect(activeWhileBlocked).toBeLessThan(backlogSize);
    expect(sourceSummary).toMatchObject({
      fetched: 1,
      sourceRequests: 1,
      sourceFailures: 0,
      sourceDisabled: false,
    });
    expect(source.fetch).toHaveBeenCalledOnce();
    expect(sourceProgress).toHaveBeenCalled();
    expect(dispatchSummary).toMatchObject({
      claimed: backlogSize,
      sent: backlogSize,
      deferred: 0,
    });
    expect(providerRequestCount).toBe(backlogSize);
    expect(maximumProviderRequests).toBeLessThanOrEqual(20);
    expect(dispatcher.outbox).toHaveLength(backlogSize);
  });
});

describe('v0.4.2 kill-switch operation (AC-29)', () => {
  it('disables only source egress while dispatch, retention, and a live-but-not-ready marker continue', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const confirmed = await api.createSubscriber('kill-switch-confirmed@berkeley.edu', [CLASS_KEY]);
    expect(await confirmSubscriber(db, confirmed.id)).toBe('confirmed');
    const expiredPending = await api.createSubscriber('kill-switch-expired@berkeley.edu', [
      CLASS_KEY,
    ]);
    await db
      .update(subscribers)
      .set({ createdAt: new Date(Date.now() - 73 * 60 * 60_000) })
      .where(eq(subscribers.id, expiredPending.id));

    process.env.KILL_SWITCH = '1';
    const source = sourceReturning(new Date().toISOString(), (classKey) => ({
      classKey,
      status: 'closed',
      openSeats: 0,
      waitlistOpen: false,
      fetchedAt: new Date().toISOString(),
    }));
    const repo = createWorkerRepo(db);
    const config = workerConfig({ outboxBatchSize: 10 });
    const sourceSummary = await runSourcePollCycle({
      repo,
      source,
      mailDispatcher: unusedMailDispatcher(),
      schedule: new SourceScheduleState(),
      maintenance: createMaintenanceState(),
      config,
      logger: logger(),
    });

    expect(sourceSummary).toMatchObject({
      fetched: 0,
      sourceRequests: 0,
      sourceDeferred: 1,
      sourceDisabled: true,
      healthy: false,
    });
    expect(source.fetch).not.toHaveBeenCalled();
    expect(source.beginCycle).not.toHaveBeenCalled();
    expect(source.endCycle).not.toHaveBeenCalled();

    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(),
      }),
    );
    const dispatcher = createMailDispatcher({
      transport: { kind: 'noop', send },
      from: 'alerts@berkeley.edu',
      operatorEmail: 'operator@berkeley.edu',
      appBaseUrl: 'http://localhost:5173',
      isSuppressed: async () => false,
      mintToken: async () => 'kill-switch-test-token',
      push: null,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dispatchSummary = await runOutboxDispatchCycle({
      repo,
      mailDispatcher: dispatcher,
      maintenance: createMaintenanceState(),
      config,
      logger: logger(),
    });

    expect(dispatchSummary).toMatchObject({
      claimed: 2,
      sent: 2,
      retentionPurged: 1,
      outboxQueued: 0,
      outboxDeadLetter: 0,
      healthy: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await getSubscriberByEmail(db, 'kill-switch-expired@berkeley.edu')).toBeUndefined();
    expect(await getSubscriberByEmail(db, 'kill-switch-confirmed@berkeley.edu')).toBeDefined();

    const directory = mkdtempSync(join(tmpdir(), 'seat-sniper-v042-disabled-'));
    const heartbeatPath = join(directory, 'heartbeat');
    process.env.WORKER_HEARTBEAT_FILE = heartbeatPath;
    let heartbeatNow = Date.now();
    const heartbeat = createWorkerHeartbeat(() => heartbeatNow);
    const healthySnapshot = {
      sourceStaleCount: 0,
      outboxQueued: 0,
      outboxProcessing: 0,
      outboxDeadLetter: 0,
      outboxOldestQueuedAgeMs: null,
    };
    try {
      heartbeat.recordStatus(healthySnapshot, {
        healthy: false,
        disabled: true,
        sourceSucceeded: false,
      });
      await expect(
        readWorkerReadiness({
          path: heartbeatPath,
          nowMs: heartbeatNow,
          maxStaleSeconds: 90,
          maxOutboxAgeSeconds: 120,
        }),
      ).resolves.toMatchObject({
        ready: false,
        snapshot: {
          heartbeatAgeSeconds: 0,
          lastSuccessfulCycleAgeSeconds: null,
          disabled: true,
          healthy: false,
          sourceStaleCount: 0,
          outboxDeadLetter: 0,
        },
      });

      heartbeat.recordSuccess(healthySnapshot);
      heartbeatNow += 1_000;
      heartbeat.recordStatus(healthySnapshot, {
        healthy: false,
        disabled: true,
        sourceSucceeded: false,
      });

      await expect(
        readWorkerReadiness({
          path: heartbeatPath,
          nowMs: heartbeatNow,
          maxStaleSeconds: 90,
          maxOutboxAgeSeconds: 120,
        }),
      ).resolves.toMatchObject({
        ready: false,
        snapshot: {
          heartbeatAgeSeconds: 0,
          lastSuccessfulCycleAgeSeconds: 1,
          disabled: true,
          healthy: false,
          sourceStaleCount: 0,
          outboxDeadLetter: 0,
        },
      });
    } finally {
      heartbeat.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
