import { readFile } from 'node:fs/promises';

const DEFAULT_HEARTBEAT_PATH = '/tmp/seat-sniper-worker-heartbeat';
const DEFAULT_MAX_STALE_SECONDS = 900;
const FUTURE_CLOCK_SKEW_MS = 5_000;

interface WorkerHealthMarker {
  sourceStaleCount: unknown;
  outboxQueued: unknown;
  outboxProcessing: unknown;
  outboxDeadLetter: unknown;
  outboxOldestQueuedAgeMs: unknown;
}

interface WorkerReadinessMarker {
  version: unknown;
  vapidPublicKey: unknown;
  disabled?: unknown;
  heartbeatAtMs?: unknown;
  lastSuccessfulCycleAtMs: unknown;
  healthy?: unknown;
  health?: unknown;
}

export interface WorkerReadinessSnapshot {
  heartbeatAgeSeconds: number;
  lastSuccessfulCycleAgeSeconds: number | null;
  disabled: boolean;
  healthy: boolean;
  sourceStaleCount: number;
  outboxQueued: number;
  outboxProcessing: number;
  outboxDeadLetter: number;
  outboxOldestQueuedAgeSeconds: number | null;
}

export interface WorkerReadinessResult {
  ready: boolean;
  snapshot: WorkerReadinessSnapshot | null;
}

export interface WorkerReadinessOptions {
  path?: string;
  nowMs?: number;
  maxStaleSeconds?: number;
  maxOutboxAgeSeconds?: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestampIsFresh(timestamp: number, nowMs: number, maxStaleMs: number): boolean {
  return nowMs - timestamp <= maxStaleMs && timestamp - nowMs <= FUTURE_CLOCK_SKEW_MS;
}

function markerPath(): string {
  return process.env.WORKER_HEARTBEAT_FILE?.trim() || DEFAULT_HEARTBEAT_PATH;
}

async function readMarker(path: string): Promise<WorkerReadinessMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as WorkerReadinessMarker) : null;
  } catch {
    return null;
  }
}

function evaluateWorkerMarker(
  marker: WorkerReadinessMarker | null,
  nowMs: number,
  maxStaleMs: number,
  maxOutboxAgeMs: number,
): WorkerReadinessResult {
  if (
    !marker ||
    marker.version !== 2 ||
    !nonnegativeSafeInteger(marker.heartbeatAtMs) ||
    typeof marker.disabled !== 'boolean' ||
    typeof marker.healthy !== 'boolean' ||
    typeof marker.health !== 'object' ||
    marker.health === null
  ) {
    return { ready: false, snapshot: null };
  }

  const lastSuccessfulCycleAtMs = marker.lastSuccessfulCycleAtMs;
  const hasSuccessfulCycle = nonnegativeSafeInteger(lastSuccessfulCycleAtMs);
  if (!hasSuccessfulCycle && !(lastSuccessfulCycleAtMs === null && marker.disabled)) {
    return { ready: false, snapshot: null };
  }

  const health = marker.health as WorkerHealthMarker;
  if (
    !nonnegativeSafeInteger(health.sourceStaleCount) ||
    !nonnegativeSafeInteger(health.outboxQueued) ||
    !nonnegativeSafeInteger(health.outboxProcessing) ||
    !nonnegativeSafeInteger(health.outboxDeadLetter) ||
    !(
      health.outboxOldestQueuedAgeMs === null ||
      nonnegativeSafeInteger(health.outboxOldestQueuedAgeMs)
    )
  ) {
    return { ready: false, snapshot: null };
  }

  const snapshot: WorkerReadinessSnapshot = {
    heartbeatAgeSeconds: Math.max(0, Math.floor((nowMs - marker.heartbeatAtMs) / 1_000)),
    lastSuccessfulCycleAgeSeconds: hasSuccessfulCycle
      ? Math.max(0, Math.floor((nowMs - lastSuccessfulCycleAtMs) / 1_000))
      : null,
    disabled: marker.disabled,
    healthy: marker.healthy,
    sourceStaleCount: health.sourceStaleCount,
    outboxQueued: health.outboxQueued,
    outboxProcessing: health.outboxProcessing,
    outboxDeadLetter: health.outboxDeadLetter,
    outboxOldestQueuedAgeSeconds:
      health.outboxOldestQueuedAgeMs === null
        ? null
        : Math.floor(health.outboxOldestQueuedAgeMs / 1_000),
  };
  const ready =
    timestampIsFresh(marker.heartbeatAtMs, nowMs, maxStaleMs) &&
    hasSuccessfulCycle &&
    timestampIsFresh(lastSuccessfulCycleAtMs, nowMs, maxStaleMs) &&
    !marker.disabled &&
    marker.healthy &&
    health.sourceStaleCount === 0 &&
    health.outboxDeadLetter === 0 &&
    (health.outboxOldestQueuedAgeMs === null || health.outboxOldestQueuedAgeMs <= maxOutboxAgeMs);

  return { ready, snapshot };
}

/**
 * Read the worker's version-2 liveness/readiness handoff.
 *
 * Readiness requires both a fresh embedded heartbeat and a fresh successful
 * cycle, an enabled source, the worker's current healthy verdict, no stale
 * source, no dead letter, and no over-age queued mail. Filesystem mtime is
 * intentionally ignored.
 */
export async function readWorkerReadiness(
  options: WorkerReadinessOptions = {},
): Promise<WorkerReadinessResult> {
  const path = options.path ?? markerPath();
  const nowMs = options.nowMs ?? Date.now();
  const maxStaleSeconds =
    options.maxStaleSeconds ??
    positiveInt(process.env.WORKER_HEALTH_MAX_STALE_SECONDS, DEFAULT_MAX_STALE_SECONDS);
  const maxOutboxAgeSeconds = options.maxOutboxAgeSeconds ?? 300;
  const maxStaleMs = maxStaleSeconds * 1_000;
  const maxOutboxAgeMs = maxOutboxAgeSeconds * 1_000;
  const marker = await readMarker(path);
  return evaluateWorkerMarker(marker, nowMs, maxStaleMs, maxOutboxAgeMs);
}

/**
 * Deployment-level push readiness. The app owns only the public VAPID key; the
 * worker validates the matching private key and publishes this non-secret
 * marker. Push is advertised only when the same complete current v2 verdict
 * used by `/api/ready` is healthy.
 */
export async function workerPushIsOperational(
  publicKey: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const marker = await readMarker(markerPath());
  const maxStaleMs =
    positiveInt(process.env.WORKER_HEALTH_MAX_STALE_SECONDS, DEFAULT_MAX_STALE_SECONDS) * 1_000;
  const maxOutboxAgeMs = positiveInt(process.env.HEALTH_OUTBOX_MAX_AGE_SECONDS, 300) * 1_000;
  return (
    marker?.vapidPublicKey === publicKey &&
    evaluateWorkerMarker(marker, nowMs, maxStaleMs, maxOutboxAgeMs).ready
  );
}
