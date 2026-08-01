/**
 * Cross-process origin single-flight and durable request spacing.
 *
 * One fence is acquired for each Section operation. The global fence path is
 * intentionally shared by all Sections, which is stricter than per-Section
 * exclusion: only one worker process can touch the Berkeley origin at a time.
 * Persisted files contain no URL, ClassKey, subscriber data, or response data.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEGACY_ORIGIN_STATE_VERSION = 1;
const ORIGIN_STATE_VERSION = 2;
const ORIGIN_FENCE_VERSION = 1;
const MAX_STATE_BYTES = 1_024;
const MAX_ORIGIN_DEFER_MS = 86_400_000;
const DEFAULT_HEARTBEAT_FILE = '/tmp/seat-sniper-worker-heartbeat';

export type SourceOriginBlockClassification =
  | 'origin_fence_active'
  | 'origin_fence_unavailable'
  | 'origin_state_invalid'
  | 'origin_state_unreadable'
  | 'origin_state_persist_failed';

export type SourceOriginStartResult<T> =
  | { status: 'started'; value: T }
  | { status: 'interrupted' }
  | { status: 'aborted' }
  | {
      status: 'blocked';
      classification: SourceOriginBlockClassification;
    };

export type SourceOriginDeferResult =
  | { deferred: true }
  | {
      deferred: false;
      classification:
        | 'origin_state_invalid'
        | 'origin_state_unreadable'
        | 'origin_state_persist_failed';
    };

export interface SourceOriginPermitOptions {
  requestsPerSecond: number;
  nowMs(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  /**
   * Runs after the durable reservation wait and immediately before the
   * synchronous start callback. The worker uses it to re-check its safety
   * latch and kill switch at the final request boundary.
   */
  beforeStart(): Promise<boolean>;
}

export interface SourceOriginFence {
  /**
   * Owns the synchronous physical-request start boundary. The returned value
   * must keep any asynchronous request promise nested so this queue admits the
   * next start without awaiting the response.
   */
  runWithPermit<T>(
    options: SourceOriginPermitOptions,
    start: () => T,
  ): Promise<SourceOriginStartResult<T>>;
  /**
   * Durably extends the earliest next permit time. This shares the permit
   * serialization queue, so a cooldown cannot race a physical request.
   */
  deferUntil(notBeforeMs: number): Promise<SourceOriginDeferResult>;
  /** Keep a crash-style fence as durable fail-closed evidence. */
  retain(): void;
  /** Removes only this owner's fence. Retained fences are deliberate no-ops. */
  release(): Promise<void>;
}

export type SourceOriginFenceResult =
  | { acquired: true; fence: SourceOriginFence }
  | {
      acquired: false;
      classification: SourceOriginBlockClassification;
    };

export type SourceOriginControlState =
  | { blocked: false }
  | {
      blocked: true;
      classification: SourceOriginBlockClassification;
    };

export interface SourceOriginControl {
  /** Read-only fail-closed health inspection; never creates or clears a fence. */
  inspect(): Promise<SourceOriginControlState>;
  acquireFence(): Promise<SourceOriginFenceResult>;
  /** Explicit Operator reset only; never removes the last-permit timestamp. */
  clearFence(): Promise<void>;
}

export interface FileSourceOriginControlOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  ownerToken?: () => string;
  temporarySuffix?: () => string;
}

export function defaultSourceOriginStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['SOURCE_ORIGIN_STATE_FILE']?.trim();
  if (configured) return configured;
  const safetyFile =
    env['SOURCE_SAFETY_STOP_FILE']?.trim() ||
    `${env['WORKER_HEARTBEAT_FILE']?.trim() || DEFAULT_HEARTBEAT_FILE}.source-safety-stop`;
  return `${safetyFile}.origin-state`;
}

export function sourceOriginFenceFile(statePath: string): string {
  return `${statePath}.fence`;
}

export function createMemorySourceOriginControl(
  initialLastPermitAtMs: number | null = null,
): SourceOriginControl {
  let activeOwner: string | null = null;
  let lastPermitAtMs = initialLastPermitAtMs;
  let notBeforeMs: number | null = null;

  return {
    async inspect(): Promise<SourceOriginControlState> {
      if (activeOwner !== null) {
        return { blocked: true, classification: 'origin_fence_active' };
      }
      if (
        (lastPermitAtMs !== null && !Number.isFinite(lastPermitAtMs)) ||
        (notBeforeMs !== null && !Number.isFinite(notBeforeMs))
      ) {
        return { blocked: true, classification: 'origin_state_invalid' };
      }
      return { blocked: false };
    },
    async acquireFence(): Promise<SourceOriginFenceResult> {
      if (activeOwner !== null) {
        return { acquired: false, classification: 'origin_fence_active' };
      }
      const ownerToken = randomUUID();
      activeOwner = ownerToken;
      let retained = false;
      const permits = createSerialExecutor();
      return {
        acquired: true,
        fence: {
          runWithPermit<T>(
            options: SourceOriginPermitOptions,
            start: () => T,
          ): Promise<SourceOriginStartResult<T>> {
            return permits.run(async () => {
              const spacingMs = requestSpacingMs(options.requestsPerSecond);
              if (spacingMs === null) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }
              const currentMs = options.nowMs();
              const spacingEligibleAtMs =
                lastPermitAtMs === null ? currentMs : lastPermitAtMs + spacingMs;
              const eligibleAtMs = Math.max(
                currentMs + spacingMs,
                spacingEligibleAtMs,
                notBeforeMs ?? currentMs,
              );
              const waitMs = Math.max(0, eligibleAtMs - currentMs);
              if (waitMs > 0) await options.sleep(waitMs, options.signal);
              if (options.signal?.aborted) return { status: 'aborted' };
              if (!(await options.beforeStart())) return { status: 'interrupted' };
              if (options.signal?.aborted) return { status: 'aborted' };
              const actualStartAtMs = options.nowMs();
              if (!Number.isFinite(actualStartAtMs)) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }
              // The memory control is a deterministic development/test
              // adapter; production uses the file control, whose durable
              // reservation verifies the wall clock reached its boundary.
              lastPermitAtMs = Math.max(actualStartAtMs, eligibleAtMs);
              notBeforeMs = null;
              return { status: 'started', value: start() };
            });
          },
          deferUntil(requestedNotBeforeMs): Promise<SourceOriginDeferResult> {
            return permits.run(async () => {
              if (!Number.isFinite(requestedNotBeforeMs)) {
                retained = true;
                return { deferred: false, classification: 'origin_state_invalid' };
              }
              notBeforeMs = Math.max(notBeforeMs ?? requestedNotBeforeMs, requestedNotBeforeMs);
              return { deferred: true };
            });
          },
          retain(): void {
            retained = true;
          },
          async release(): Promise<void> {
            await permits.idle();
            if (!retained && activeOwner === ownerToken) activeOwner = null;
          },
        },
      };
    },
    async clearFence(): Promise<void> {
      const resetAtMs = Date.now();
      const invalidLastPermit = lastPermitAtMs !== null && !Number.isFinite(lastPermitAtMs);
      const invalidNotBefore = notBeforeMs !== null && !Number.isFinite(notBeforeMs);
      if (invalidLastPermit || invalidNotBefore) {
        lastPermitAtMs = resetAtMs;
        notBeforeMs = null;
      } else {
        lastPermitAtMs = Math.max(lastPermitAtMs ?? resetAtMs, resetAtMs);
      }
      activeOwner = null;
    },
  };
}

export function createFileSourceOriginControl(
  options: FileSourceOriginControlOptions = {},
): SourceOriginControl {
  const statePath = options.path?.trim() || defaultSourceOriginStateFile(options.env);
  const fencePath = sourceOriginFenceFile(statePath);
  const nowMs = options.nowMs ?? Date.now;
  const ownerToken = options.ownerToken ?? randomUUID;
  const temporarySuffix = options.temporarySuffix ?? randomUUID;

  return {
    async inspect(): Promise<SourceOriginControlState> {
      const fence = await readFenceMarker(fencePath);
      if (fence.kind !== 'missing') {
        return {
          blocked: true,
          classification:
            fence.kind === 'valid' ? 'origin_fence_active' : 'origin_fence_unavailable',
        };
      }
      const state = await readOriginState(statePath);
      if (state.kind === 'invalid') {
        return { blocked: true, classification: state.classification };
      }
      if (!(await hasWritableParent(statePath))) {
        return { blocked: true, classification: 'origin_fence_unavailable' };
      }
      return { blocked: false };
    },

    async acquireFence(): Promise<SourceOriginFenceResult> {
      const token = ownerToken();
      const marker: OriginFenceMarker = {
        version: ORIGIN_FENCE_VERSION,
        ownerToken: token,
        acquiredAt: new Date(nowMs()).toISOString(),
      };

      let handle;
      try {
        handle = await open(
          fencePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
          0o600,
        );
      } catch (error) {
        return {
          acquired: false,
          classification: isNodeErrorCode(error, 'EEXIST')
            ? 'origin_fence_active'
            : 'origin_fence_unavailable',
        };
      }

      try {
        await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncParentDirectory(fencePath);
      } catch {
        // Deliberately retain even a partial fence. Its mere existence is
        // fail-closed evidence after process restart.
        try {
          await handle?.close();
        } catch {
          // The fixed classification below is the only surfaced detail.
        }
        return { acquired: false, classification: 'origin_fence_unavailable' };
      }

      let retained = false;
      let lastActualStartAtMs: number | null = null;
      const permits = createSerialExecutor();
      return {
        acquired: true,
        fence: {
          runWithPermit<T>(
            permitOptions: SourceOriginPermitOptions,
            start: () => T,
          ): Promise<SourceOriginStartResult<T>> {
            return permits.run(async () => {
              const spacingMs = requestSpacingMs(permitOptions.requestsPerSecond);
              if (spacingMs === null) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }

              const previous = await readOriginState(statePath);
              if (previous.kind === 'invalid') {
                retained = true;
                return { status: 'blocked', classification: previous.classification };
              }
              const currentMs = permitOptions.nowMs();
              if (!Number.isFinite(currentMs)) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }
              const spacingEligibleAtMs =
                previous.kind === 'missing'
                  ? currentMs + spacingMs
                  : previous.marker.lastPermitAtMs + spacingMs;
              const ownerEligibleAtMs =
                lastActualStartAtMs === null
                  ? currentMs + spacingMs
                  : lastActualStartAtMs + spacingMs;
              const reservedStartAtMs = Math.max(
                currentMs + spacingMs,
                spacingEligibleAtMs,
                ownerEligibleAtMs,
                previous.kind === 'valid' ? (previous.marker.notBeforeMs ?? currentMs) : currentMs,
              );
              const reserved = await writeOriginState(
                statePath,
                {
                  version: ORIGIN_STATE_VERSION,
                  ownerToken: token,
                  lastPermitAt: new Date(reservedStartAtMs).toISOString(),
                  notBefore: null,
                  notBeforeSetAt: null,
                },
                temporarySuffix,
              );
              if (!reserved) {
                retained = true;
                return {
                  status: 'blocked',
                  classification: 'origin_state_persist_failed',
                };
              }

              const afterReservationMs = permitOptions.nowMs();
              if (!Number.isFinite(afterReservationMs)) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }
              const waitMs = Math.max(0, reservedStartAtMs - afterReservationMs);
              if (waitMs > 0) await permitOptions.sleep(waitMs, permitOptions.signal);
              if (permitOptions.signal?.aborted) return { status: 'aborted' };
              if (!(await permitOptions.beforeStart())) return { status: 'interrupted' };
              if (permitOptions.signal?.aborted) return { status: 'aborted' };

              const actualStartAtMs = permitOptions.nowMs();
              if (!Number.isFinite(actualStartAtMs) || actualStartAtMs < reservedStartAtMs) {
                retained = true;
                return { status: 'blocked', classification: 'origin_state_invalid' };
              }
              lastActualStartAtMs = actualStartAtMs;
              let started: { ok: true; value: T } | { ok: false; error: unknown };
              try {
                started = { ok: true, value: start() };
              } catch (error) {
                started = { ok: false, error };
              }
              const reconciled = await writeOriginState(
                statePath,
                {
                  version: ORIGIN_STATE_VERSION,
                  ownerToken: token,
                  lastPermitAt: new Date(lastActualStartAtMs).toISOString(),
                  notBefore: null,
                  notBeforeSetAt: null,
                },
                temporarySuffix,
              );
              if (!reconciled) {
                retained = true;
                return {
                  status: 'blocked',
                  classification: 'origin_state_persist_failed',
                };
              }
              if (!started.ok) throw started.error;
              return { status: 'started', value: started.value };
            });
          },
          deferUntil(requestedNotBeforeMs): Promise<SourceOriginDeferResult> {
            return permits.run(async () => {
              const setAtMs = nowMs();
              if (!Number.isFinite(setAtMs) || !Number.isFinite(requestedNotBeforeMs)) {
                retained = true;
                return { deferred: false, classification: 'origin_state_invalid' };
              }

              const previous = await readOriginState(statePath);
              if (previous.kind === 'invalid') {
                retained = true;
                return { deferred: false, classification: previous.classification };
              }

              const boundedNotBeforeMs = Math.min(
                setAtMs + MAX_ORIGIN_DEFER_MS,
                Math.max(setAtMs, requestedNotBeforeMs),
              );
              let marker: OriginStateMarker;
              try {
                const keepPreviousCooldown =
                  previous.kind === 'valid' &&
                  previous.marker.notBeforeMs !== null &&
                  previous.marker.notBeforeSetAt !== null &&
                  previous.marker.notBeforeMs > boundedNotBeforeMs;
                marker = {
                  version: ORIGIN_STATE_VERSION,
                  ownerToken: token,
                  lastPermitAt:
                    previous.kind === 'valid'
                      ? previous.marker.lastPermitAt
                      : new Date(setAtMs).toISOString(),
                  notBefore: keepPreviousCooldown
                    ? previous.marker.notBefore
                    : new Date(boundedNotBeforeMs).toISOString(),
                  notBeforeSetAt: keepPreviousCooldown
                    ? previous.marker.notBeforeSetAt
                    : new Date(setAtMs).toISOString(),
                };
              } catch {
                retained = true;
                return { deferred: false, classification: 'origin_state_invalid' };
              }

              const persisted = await writeOriginState(statePath, marker, temporarySuffix);
              if (!persisted) {
                retained = true;
                return { deferred: false, classification: 'origin_state_persist_failed' };
              }
              return { deferred: true };
            });
          },
          retain(): void {
            retained = true;
          },
          async release(): Promise<void> {
            await permits.idle();
            if (retained) return;
            const current = await readFenceMarker(fencePath);
            if (current.kind === 'missing') return;
            if (current.kind !== 'valid' || current.marker.ownerToken !== token) {
              throw new Error('source origin fence release rejected');
            }
            if (lastActualStartAtMs !== null) {
              const state = await readOriginState(statePath);
              if (state.kind !== 'valid') {
                retained = true;
                throw new Error('source origin fence release failed');
              }
              if (state.marker.lastPermitAtMs < lastActualStartAtMs) {
                retained = true;
                throw new Error('source origin fence release failed');
              }
            }
            try {
              await unlink(fencePath);
              await syncParentDirectory(fencePath);
            } catch (error) {
              if (!isNodeErrorCode(error, 'ENOENT')) {
                throw new Error('source origin fence release failed');
              }
            }
          },
        },
      };
    },

    async clearFence(): Promise<void> {
      const state = await readOriginState(statePath);
      const resetAtMs = nowMs();
      if (!Number.isFinite(resetAtMs)) {
        throw new Error('source origin state reset failed');
      }
      const resetMarker: OriginStateMarker =
        state.kind === 'valid'
          ? {
              version: ORIGIN_STATE_VERSION,
              ownerToken: state.marker.ownerToken,
              lastPermitAt: new Date(
                Math.max(state.marker.lastPermitAtMs, resetAtMs),
              ).toISOString(),
              notBefore: state.marker.notBefore,
              notBeforeSetAt: state.marker.notBeforeSetAt,
            }
          : {
              version: ORIGIN_STATE_VERSION,
              ownerToken: ownerToken(),
              lastPermitAt: new Date(resetAtMs).toISOString(),
              notBefore: null,
              notBeforeSetAt: null,
            };
      const resetPersisted = await writeOriginState(statePath, resetMarker, temporarySuffix);
      if (!resetPersisted) throw new Error('source origin state reset failed');
      try {
        await unlink(fencePath);
        await syncParentDirectory(fencePath);
      } catch (error) {
        if (!isNodeErrorCode(error, 'ENOENT')) {
          throw new Error('source origin fence reset failed');
        }
      }
    },
  };
}

interface OriginFenceMarker {
  version: typeof ORIGIN_FENCE_VERSION;
  ownerToken: string;
  acquiredAt: string;
}

interface OriginStateMarker {
  version: typeof ORIGIN_STATE_VERSION;
  ownerToken: string;
  lastPermitAt: string;
  notBefore: string | null;
  notBeforeSetAt: string | null;
}

type ReadFenceResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; marker: OriginFenceMarker };

type ReadStateResult =
  | { kind: 'missing' }
  | {
      kind: 'invalid';
      classification: 'origin_state_invalid' | 'origin_state_unreadable';
    }
  | {
      kind: 'valid';
      marker: OriginStateMarker & {
        lastPermitAtMs: number;
        notBeforeMs: number | null;
      };
    };

async function readFenceMarker(path: string): Promise<ReadFenceResult> {
  const read = await readBoundedRegularFile(path);
  if (read.kind !== 'content') return read.kind === 'missing' ? read : { kind: 'invalid' };
  const parsed = parseJsonRecord(read.content);
  if (
    parsed === null ||
    !hasExactKeys(parsed, ['acquiredAt', 'ownerToken', 'version']) ||
    parsed.version !== ORIGIN_FENCE_VERSION ||
    !isOwnerToken(parsed.ownerToken) ||
    !isCanonicalIsoTimestamp(parsed.acquiredAt)
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'valid',
    marker: {
      version: ORIGIN_FENCE_VERSION,
      ownerToken: parsed.ownerToken,
      acquiredAt: parsed.acquiredAt,
    },
  };
}

async function readOriginState(path: string): Promise<ReadStateResult> {
  const read = await readBoundedRegularFile(path);
  if (read.kind === 'missing') return read;
  if (read.kind === 'unreadable') {
    return { kind: 'invalid', classification: 'origin_state_unreadable' };
  }
  const parsed = parseJsonRecord(read.content);
  if (parsed === null || !isOwnerToken(parsed.ownerToken)) {
    return { kind: 'invalid', classification: 'origin_state_invalid' };
  }
  if (
    parsed.version === LEGACY_ORIGIN_STATE_VERSION &&
    hasExactKeys(parsed, ['lastPermitAt', 'ownerToken', 'version']) &&
    isCanonicalIsoTimestamp(parsed.lastPermitAt)
  ) {
    return {
      kind: 'valid',
      marker: {
        version: ORIGIN_STATE_VERSION,
        ownerToken: parsed.ownerToken,
        lastPermitAt: parsed.lastPermitAt,
        lastPermitAtMs: Date.parse(parsed.lastPermitAt),
        notBefore: null,
        notBeforeSetAt: null,
        notBeforeMs: null,
      },
    };
  }
  if (
    parsed.version !== ORIGIN_STATE_VERSION ||
    !hasExactKeys(parsed, [
      'lastPermitAt',
      'notBefore',
      'notBeforeSetAt',
      'ownerToken',
      'version',
    ]) ||
    !isCanonicalIsoTimestamp(parsed.lastPermitAt) ||
    !isNullableCanonicalTimestamp(parsed.notBefore) ||
    !isNullableCanonicalTimestamp(parsed.notBeforeSetAt) ||
    !isValidCooldownPair(parsed.notBefore, parsed.notBeforeSetAt)
  ) {
    return { kind: 'invalid', classification: 'origin_state_invalid' };
  }
  return {
    kind: 'valid',
    marker: {
      version: ORIGIN_STATE_VERSION,
      ownerToken: parsed.ownerToken,
      lastPermitAt: parsed.lastPermitAt,
      lastPermitAtMs: Date.parse(parsed.lastPermitAt),
      notBefore: parsed.notBefore,
      notBeforeSetAt: parsed.notBeforeSetAt,
      notBeforeMs: parsed.notBefore === null ? null : Date.parse(parsed.notBefore),
    },
  };
}

type ReadFileResult =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'content'; content: string };

async function readBoundedRegularFile(path: string): Promise<ReadFileResult> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  } catch (error) {
    return isNodeErrorCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STATE_BYTES) {
      return { kind: 'unreadable' };
    }
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > 0 && offset <= MAX_STATE_BYTES
      ? { kind: 'content', content: buffer.toString('utf8', 0, offset) }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeOriginState(
  path: string,
  marker: OriginStateMarker,
  suffix: () => string,
): Promise<boolean> {
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
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
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

async function hasWritableParent(path: string): Promise<boolean> {
  try {
    const parent = dirname(path);
    const parentStats = await stat(parent);
    if (!parentStats.isDirectory()) return false;
    await access(parent, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function requestSpacingMs(requestsPerSecond: number): number | null {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 1) {
    return null;
  }
  return Math.ceil(1_000 / requestsPerSecond);
}

interface SerialExecutor {
  run<T>(task: () => Promise<T>): Promise<T>;
  idle(): Promise<void>;
}

function createSerialExecutor(): SerialExecutor {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async idle(): Promise<void> {
      await tail;
    },
  };
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(record).sort().join(',') === [...expected].sort().join(',');
}

function isOwnerToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNullableCanonicalTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalIsoTimestamp(value);
}

function isValidCooldownPair(notBefore: string | null, notBeforeSetAt: string | null): boolean {
  if (notBefore === null || notBeforeSetAt === null) {
    return notBefore === null && notBeforeSetAt === null;
  }
  if (!isCanonicalIsoTimestamp(notBefore) || !isCanonicalIsoTimestamp(notBeforeSetAt)) {
    return false;
  }
  const delayMs = Date.parse(notBefore) - Date.parse(notBeforeSetAt);
  return delayMs >= 0 && delayMs <= MAX_ORIGIN_DEFER_MS;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
