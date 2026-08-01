import { statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const DEFAULT_DISK_MIN_FREE_KB = 1_048_576;
const MAX_DISK_READINESS_PATH_LENGTH = 1_024;
const BYTES_PER_KIBIBYTE = 1_024n;

export interface DiskReadinessConfig {
  path: string;
  minFreeKb: number;
}

export interface DiskReadinessResult {
  ready: boolean;
}

interface DiskStats {
  bavail: bigint;
  bsize: bigint;
}

export interface DiskReadinessOptions extends DiskReadinessConfig {
  statfsReader?(path: string): Promise<DiskStats>;
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
 * Validate the operator-selected filesystem probe before the API binds.
 * Production must point this at the mounted runtime filesystem. Development
 * and tests may omit the probe entirely.
 */
export function readDiskReadinessConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiskReadinessConfig | null {
  const required = env.NODE_ENV === 'production';
  const path = env.DISK_READINESS_PATH?.trim();
  if (!path) {
    if (required) {
      throw new Error('DISK_READINESS_PATH is required in production');
    }
    return null;
  }
  if (!isAbsolute(path) || path.length > MAX_DISK_READINESS_PATH_LENGTH || path.includes('\0')) {
    throw new Error('DISK_READINESS_PATH must be a bounded absolute path');
  }
  return {
    path,
    minFreeKb: positiveIntegerEnv(env, 'HEALTH_DISK_MIN_FREE_KB', DEFAULT_DISK_MIN_FREE_KB),
  };
}

async function readNodeDiskStats(path: string): Promise<DiskStats> {
  const stats = await statfs(path, { bigint: true });
  return {
    bavail: stats.bavail,
    bsize: stats.bsize,
  };
}

/**
 * Measure space available to the API process on the configured filesystem.
 * Missing or unreadable paths and invalid filesystem results fail closed. The
 * result intentionally carries no path, errno, or exception detail.
 */
export async function readDiskReadiness(
  options: DiskReadinessOptions,
): Promise<DiskReadinessResult> {
  if (!Number.isSafeInteger(options.minFreeKb) || options.minFreeKb < 1) {
    return { ready: false };
  }

  try {
    const stats = await (options.statfsReader ?? readNodeDiskStats)(options.path);
    if (stats.bavail < 0n || stats.bsize < 1n) return { ready: false };

    const availableBytes = stats.bavail * stats.bsize;
    const requiredBytes = BigInt(options.minFreeKb) * BYTES_PER_KIBIBYTE;
    return { ready: availableBytes >= requiredBytes };
  } catch {
    return { ready: false };
  }
}
