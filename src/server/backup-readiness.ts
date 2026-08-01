import { open } from 'node:fs/promises';

const DEFAULT_BACKUP_MAX_STALE_SECONDS = 5_400;
const MAX_BACKUP_MARKER_BYTES = 1_024;
const UTC_RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export interface BackupReadinessConfig {
  path: string;
  maxStaleSeconds: number;
}

export interface BackupReadinessSnapshot {
  completedAt: string;
  ageSeconds: number;
}

export interface BackupReadinessResult {
  ready: boolean;
  snapshot: BackupReadinessSnapshot | null;
}

export interface BackupReadinessOptions extends BackupReadinessConfig {
  nowMs?: number;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Validate the shared backup marker configuration before the API binds.
 * Production requires the read-only marker mount; local/test processes may
 * omit it.
 */
export function readBackupReadinessConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackupReadinessConfig | null {
  const required = env.NODE_ENV === 'production';
  const path = env.BACKUP_SUCCESS_MARKER_FILE?.trim();
  if (!path) {
    if (required) {
      throw new Error('BACKUP_SUCCESS_MARKER_FILE is required in production');
    }
    return null;
  }
  if (!path.startsWith('/') || path.length > 1_024 || path.includes('\0')) {
    throw new Error('BACKUP_SUCCESS_MARKER_FILE must be a bounded absolute path');
  }
  return {
    path,
    maxStaleSeconds: positiveIntegerEnv(
      env,
      'BACKUP_MAX_STALE_SECONDS',
      DEFAULT_BACKUP_MAX_STALE_SECONDS,
    ),
  };
}

async function readBoundedMarker(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(MAX_BACKUP_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_BACKUP_MARKER_BYTES + 1, 0);
    if (bytesRead === 0 || bytesRead > MAX_BACKUP_MARKER_BYTES) return null;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseUtcRfc3339(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = UTC_RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  if (!Number.isFinite(milliseconds)) return null;

  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  return milliseconds;
}

/**
 * Read the backup service's bounded, atomically replaced success marker.
 * Missing, oversized, malformed, stale, or future-dated content fails closed
 * without exposing paths or parser details through readiness.
 */
export async function readBackupReadiness(
  options: BackupReadinessOptions,
): Promise<BackupReadinessResult> {
  const raw = await readBoundedMarker(options.path);
  if (raw === null) return { ready: false, snapshot: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ready: false, snapshot: null };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, 'completedAt')
  ) {
    return { ready: false, snapshot: null };
  }

  const completedAt = (parsed as { completedAt?: unknown }).completedAt;
  const completedAtMs = parseUtcRfc3339(completedAt);
  if (completedAtMs === null || typeof completedAt !== 'string') {
    return { ready: false, snapshot: null };
  }

  const nowMs = options.nowMs ?? Date.now();
  const ageMs = nowMs - completedAtMs;
  const snapshot: BackupReadinessSnapshot = {
    completedAt,
    ageSeconds: Math.max(0, Math.floor(ageMs / 1_000)),
  };
  return {
    ready: ageMs >= 0 && ageMs <= options.maxStaleSeconds * 1_000,
    snapshot,
  };
}
