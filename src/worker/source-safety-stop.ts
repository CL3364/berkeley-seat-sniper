/**
 * Durable source-safety stop for FR-7.
 *
 * The marker contains only a fixed reason and timestamp. It deliberately has
 * no ClassKey, URL, response detail, subscriber data, or other provider-
 * controlled value. A malformed or unreadable marker fails closed.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createFileSourceOriginControl, type SourceOriginControl } from './source-origin-control';

const LEGACY_SOURCE_SAFETY_STOP_MARKER_VERSION = 1;
const SOURCE_SAFETY_STOP_MARKER_VERSION = 2;
const SOURCE_SAFETY_STOP_MARKER_MAX_BYTES = 1_024;
const MAX_SOURCE_SAFETY_RESUME_DELAY_MS = 86_400_000;
const DEFAULT_WORKER_HEARTBEAT_FILE = '/tmp/seat-sniper-worker-heartbeat';

export const SOURCE_SAFETY_STOP_RESET_CONFIRMATION = 'RESET_SOURCE_SAFETY_STOP';

export type SourceSafetyStopCliResetRejection = 'confirmation_missing' | 'kill_switch_required';

export type SourceSafetyStopReason = 'robots_disallow' | 'source_forbidden' | 'source_rate_limited';

export class SourceSafetyStopResetDeferredError extends Error {
  constructor() {
    super('source safety-stop reset deferred');
    this.name = 'SourceSafetyStopResetDeferredError';
  }
}

export type SourceSafetyStopClassification =
  | SourceSafetyStopReason
  | 'marker_invalid'
  | 'marker_unreadable'
  | 'marker_persist_failed';

export type SourceSafetyStopState =
  | { stopped: false }
  | {
      stopped: true;
      classification: SourceSafetyStopClassification;
    };

export interface SourceSafetyStopStore {
  /**
   * Read current stop state. Every result other than a definitely absent
   * marker is fail-closed.
   */
  inspect(): Promise<SourceSafetyStopState>;

  /**
   * Persist the first safety trigger. Existing marker state is never replaced
   * automatically, including malformed/unreadable state.
   */
  engage(
    reason: SourceSafetyStopReason,
    options?: SourceSafetyStopEngageOptions,
  ): Promise<SourceSafetyStopState>;

  /**
   * Explicit Operator action. The exact confirmation string is required so a
   * generic cleanup call cannot silently resume source traffic.
   */
  reset(confirmation: string): Promise<void>;
}

export interface SourceSafetyStopEngageOptions {
  /** Bounded worker-computed recovery delay; persisted only for HTTP 429 stops. */
  resumeDelayMs?: number | null;
}

interface SourceSafetyStopMarker {
  version: typeof SOURCE_SAFETY_STOP_MARKER_VERSION;
  reason: SourceSafetyStopReason;
  stoppedAt: string;
  resumeNotBefore: string | null;
}

interface ParsedSourceSafetyStopMarker {
  reason: SourceSafetyStopReason;
  stoppedAt: string;
  resumeNotBefore: string | null;
}

export interface FileSourceSafetyStopStoreOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Deterministic only in tests; production uses a cryptographically random suffix. */
  temporarySuffix?: () => string;
  /** Shared production control so an Operator reset also clears its stale fence. */
  originControl?: Pick<SourceOriginControl, 'clearFence'>;
}

/** Process-local store for one-shot harnesses that explicitly do not persist. */
export function createMemorySourceSafetyStopStore(
  initial: SourceSafetyStopState = { stopped: false },
  now: () => Date = () => new Date(),
): SourceSafetyStopStore {
  let state = initial;
  let resumeNotBeforeMs: number | null = null;
  return {
    async inspect(): Promise<SourceSafetyStopState> {
      return state;
    },
    async engage(reason, options): Promise<SourceSafetyStopState> {
      if (!state.stopped) {
        state = { stopped: true, classification: reason };
        if (reason === 'source_rate_limited') {
          resumeNotBeforeMs =
            now().getTime() + boundedSourceResumeDelayMs(options?.resumeDelayMs ?? null);
        }
      }
      return state;
    },
    async reset(confirmation): Promise<void> {
      assertResetConfirmation(confirmation);
      if (resumeNotBeforeMs !== null && now().getTime() < resumeNotBeforeMs) {
        throw new SourceSafetyStopResetDeferredError();
      }
      state = { stopped: false };
      resumeNotBeforeMs = null;
    },
  };
}

/**
 * Resolve the marker beside the worker heartbeat by default. Production can
 * mount both into one shared worker-state volume; tests can inject a temp path.
 */
export function defaultSourceSafetyStopFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['SOURCE_SAFETY_STOP_FILE']?.trim();
  if (configured) return configured;
  const heartbeat = env['WORKER_HEARTBEAT_FILE']?.trim() || DEFAULT_WORKER_HEARTBEAT_FILE;
  return `${heartbeat}.source-safety-stop`;
}

export function createFileSourceSafetyStopStore(
  options: FileSourceSafetyStopStoreOptions = {},
): SourceSafetyStopStore {
  const path = options.path?.trim() || defaultSourceSafetyStopFile(options.env);
  const now = options.now ?? (() => new Date());
  const temporarySuffix = options.temporarySuffix ?? randomUUID;
  const env = options.env ?? process.env;
  const configuredOriginPath = env['SOURCE_ORIGIN_STATE_FILE']?.trim();
  const originControl =
    options.originControl ??
    createFileSourceOriginControl({
      env,
      path: configuredOriginPath || `${path}.origin-state`,
      nowMs: () => now().getTime(),
    });
  let volatileStop: SourceSafetyStopState | undefined;
  let volatileResumeNotBeforeMs: number | null = null;

  async function inspect(): Promise<SourceSafetyStopState> {
    const persisted = await readMarkerFile(path);
    if (persisted.kind === 'valid') {
      return { stopped: true, classification: persisted.marker.reason };
    }
    if (persisted.kind === 'invalid') {
      return { stopped: true, classification: 'marker_invalid' };
    }
    if (persisted.kind === 'unreadable') {
      return { stopped: true, classification: 'marker_unreadable' };
    }
    const missingState = await inspectMissingMarkerParent(path);
    if (missingState.stopped) return missingState;
    return volatileStop ?? missingState;
  }

  return {
    inspect,

    async engage(reason, engageOptions): Promise<SourceSafetyStopState> {
      const existing = await inspect();
      if (existing.stopped) return existing;

      const stoppedAt = now();
      const stoppedAtMs = stoppedAt.getTime();
      const resumeNotBefore =
        reason === 'source_rate_limited'
          ? new Date(
              stoppedAtMs + boundedSourceResumeDelayMs(engageOptions?.resumeDelayMs ?? null),
            ).toISOString()
          : null;
      const marker: SourceSafetyStopMarker = {
        version: SOURCE_SAFETY_STOP_MARKER_VERSION,
        reason,
        stoppedAt: stoppedAt.toISOString(),
        resumeNotBefore,
      };
      const active: SourceSafetyStopState = { stopped: true, classification: reason };
      // Set memory first so a failed disk operation cannot let this process
      // issue another source request on its next loop.
      volatileStop = active;
      volatileResumeNotBeforeMs = resumeNotBefore === null ? null : Date.parse(resumeNotBefore);

      if (!(await writeSafetyStopMarker(path, marker, temporarySuffix))) {
        volatileStop = { stopped: true, classification: 'marker_persist_failed' };
        return volatileStop;
      }
      // The file is now the durable authority. Dropping the provisional
      // memory state lets an explicit reset performed by the CLI become
      // visible to this already-running worker on its next cycle.
      volatileStop = undefined;
      volatileResumeNotBeforeMs = null;
      return active;
    },

    async reset(confirmation): Promise<void> {
      assertResetConfirmation(confirmation);
      const persisted = await readMarkerFile(path);
      const resumeNotBeforeMs =
        persisted.kind === 'valid' && persisted.marker.reason === 'source_rate_limited'
          ? timestampOrNull(persisted.marker.resumeNotBefore)
          : volatileResumeNotBeforeMs;
      const resetAtMs = now().getTime();
      if (!Number.isFinite(resetAtMs)) {
        throw new Error('source safety-stop reset failed');
      }
      if (resumeNotBeforeMs !== null && resetAtMs < resumeNotBeforeMs) {
        throw new SourceSafetyStopResetDeferredError();
      }
      try {
        // State validation/repair happens inside this call before the stale
        // owner fence is removed. A valid last-permit timestamp is preserved.
        await originControl.clearFence();
      } catch {
        throw new Error('source safety-stop reset failed');
      }
      try {
        await unlink(path);
      } catch (error) {
        if (!isNodeErrorCode(error, 'ENOENT')) {
          throw new Error('source safety-stop reset failed');
        }
      }
      try {
        await syncParentDirectory(path);
      } catch {
        throw new Error('source safety-stop reset failed');
      }
      const clearedState = await inspectMissingMarkerParent(path);
      if (clearedState.stopped) throw new Error('source safety-stop reset failed');
      volatileStop = undefined;
      volatileResumeNotBeforeMs = null;
    },
  };
}

/** Narrow public reset primitive for an Operator-reviewed recovery. */
export async function resetSourceSafetyStop(
  confirmation: string,
  store: SourceSafetyStopStore = createFileSourceSafetyStopStore(),
): Promise<void> {
  await store.reset(confirmation);
}

/**
 * Defense-in-depth for the Operator CLI. Resetting the durable latch is only
 * allowed while the independent live kill switch still prevents source egress.
 * The lower-level reset primitive remains injectable for deterministic tests.
 */
export function sourceSafetyStopCliResetRejection(
  confirmation: string,
  env: NodeJS.ProcessEnv = process.env,
): SourceSafetyStopCliResetRejection | null {
  if (confirmation !== SOURCE_SAFETY_STOP_RESET_CONFIRMATION) {
    return 'confirmation_missing';
  }
  return env['KILL_SWITCH'] === '1' ? null : 'kill_switch_required';
}

type ReadMarkerResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'unreadable' }
  | { kind: 'valid'; marker: ParsedSourceSafetyStopMarker };

async function readMarkerFile(path: string): Promise<ReadMarkerResult> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  } catch (error) {
    return isNodeErrorCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'unreadable' };
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > SOURCE_SAFETY_STOP_MARKER_MAX_BYTES) {
      return { kind: 'invalid' };
    }
    const buffer = Buffer.alloc(SOURCE_SAFETY_STOP_MARKER_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset <= 0 || offset > SOURCE_SAFETY_STOP_MARKER_MAX_BYTES) {
      return { kind: 'invalid' };
    }
    const marker = parseMarker(buffer.toString('utf8', 0, offset));
    return marker === null ? { kind: 'invalid' } : { kind: 'valid', marker };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeSafetyStopMarker(
  path: string,
  marker: SourceSafetyStopMarker,
  suffix: () => string,
): Promise<boolean> {
  const serialized = `${JSON.stringify(marker)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > SOURCE_SAFETY_STOP_MARKER_MAX_BYTES) {
    return false;
  }
  const random = suffix();
  const safeSuffix = /^[A-Za-z0-9-]{1,128}$/.test(random) ? random : randomUUID();
  const temporaryPath = `${path}.tmp-${process.pid}-${safeSuffix}`;
  let handle;
  let created = false;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    created = true;
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    renamed = true;
    await syncParentDirectory(path);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    if (created && !renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

function parseMarker(raw: string): ParsedSourceSafetyStopMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (!isSourceSafetyStopReason(value.reason)) return null;
  if (typeof value.stoppedAt !== 'string' || !isCanonicalIsoTimestamp(value.stoppedAt)) {
    return null;
  }

  if (
    value.version === LEGACY_SOURCE_SAFETY_STOP_MARKER_VERSION &&
    keys.join(',') === 'reason,stoppedAt,version'
  ) {
    return {
      reason: value.reason,
      stoppedAt: value.stoppedAt,
      resumeNotBefore: null,
    };
  }

  if (
    value.version !== SOURCE_SAFETY_STOP_MARKER_VERSION ||
    keys.join(',') !== 'reason,resumeNotBefore,stoppedAt,version'
  ) {
    return null;
  }
  if (value.reason !== 'source_rate_limited') {
    if (value.resumeNotBefore !== null) return null;
  } else {
    if (
      typeof value.resumeNotBefore !== 'string' ||
      !isCanonicalIsoTimestamp(value.resumeNotBefore)
    ) {
      return null;
    }
    const delayMs = Date.parse(value.resumeNotBefore) - Date.parse(value.stoppedAt);
    if (delayMs < 0 || delayMs > MAX_SOURCE_SAFETY_RESUME_DELAY_MS) return null;
  }
  return {
    reason: value.reason,
    stoppedAt: value.stoppedAt,
    resumeNotBefore: typeof value.resumeNotBefore === 'string' ? value.resumeNotBefore : null,
  };
}

function boundedSourceResumeDelayMs(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return MAX_SOURCE_SAFETY_RESUME_DELAY_MS;
  }
  return Math.min(MAX_SOURCE_SAFETY_RESUME_DELAY_MS, Math.ceil(value));
}

function timestampOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSourceSafetyStopReason(value: unknown): value is SourceSafetyStopReason {
  return (
    value === 'robots_disallow' || value === 'source_forbidden' || value === 'source_rate_limited'
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function inspectMissingMarkerParent(path: string): Promise<SourceSafetyStopState> {
  try {
    const parent = dirname(path);
    const parentStats = await stat(parent);
    if (!parentStats.isDirectory()) {
      return { stopped: true, classification: 'marker_unreadable' };
    }
    await access(parent, fsConstants.W_OK | fsConstants.X_OK);
    return { stopped: false };
  } catch {
    return { stopped: true, classification: 'marker_unreadable' };
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (
      !isNodeErrorCode(error, 'EINVAL') &&
      !isNodeErrorCode(error, 'ENOTSUP') &&
      !isNodeErrorCode(error, 'EBADF')
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function assertResetConfirmation(confirmation: string): void {
  if (confirmation !== SOURCE_SAFETY_STOP_RESET_CONFIRMATION) {
    throw new Error('source safety-stop reset confirmation rejected');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
