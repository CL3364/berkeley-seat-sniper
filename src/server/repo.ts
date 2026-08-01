/**
 * Server binding for the database lane.
 *
 * The DB adapter owns transactional subscription/watch/outbox behavior. This
 * module supplies the v0.4 source-capacity default and adds bounded aggregate
 * readiness probes without exposing recipient or watch data.
 */

import { sql } from 'drizzle-orm';
import {
  getMailOutboxHealth,
  makeRepo,
  type BoundRepo,
  type CapacityAdmissionOptions,
  type Db,
} from '../db';

export interface SourceCapacityConfig {
  requestsPerSecond: number;
  visibleTargetSeconds: number;
  maxUniqueSections: number;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = positiveNumber(env, name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** floor(0.8 × request ceiling × source-visible target); defaults to 96. */
export function readSourceCapacityConfig(
  env: NodeJS.ProcessEnv = process.env,
): SourceCapacityConfig {
  const requestsPerSecond = positiveNumber(env, 'SOURCE_REQUESTS_PER_SECOND', 1);
  if (requestsPerSecond > 1) {
    throw new Error('SOURCE_REQUESTS_PER_SECOND must be no greater than 1');
  }
  const visibleTargetSeconds = positiveInteger(env, 'SOURCE_VISIBLE_TARGET_SECONDS', 120);
  const maxUniqueSections = Math.floor(0.8 * requestsPerSecond * visibleTargetSeconds);
  if (!Number.isSafeInteger(maxUniqueSections) || maxUniqueSections < 1) {
    throw new Error(
      'SOURCE_REQUESTS_PER_SECOND and SOURCE_VISIBLE_TARGET_SECONDS yield zero capacity',
    );
  }
  return { requestsPerSecond, visibleTargetSeconds, maxUniqueSections };
}

export interface ServerOutboxHealth {
  queued: number;
  processing: number;
  deadLetter: number;
  oldestQueuedAgeSeconds: number | null;
}

export interface ServerRepo extends BoundRepo {
  healthCheck(): Promise<void>;
  getOutboxHealth(): Promise<ServerOutboxHealth>;
}

export function makeServerRepo(
  db: Db,
  options: CapacityAdmissionOptions = {
    maxUniqueSections: readSourceCapacityConfig().maxUniqueSections,
  },
): ServerRepo {
  const bound = makeRepo(db, options);
  return {
    ...bound,

    async healthCheck(): Promise<void> {
      await db.execute(sql`select 1`);
    },

    async getOutboxHealth(): Promise<ServerOutboxHealth> {
      const health = await getMailOutboxHealth(db);
      return {
        queued: health.queued,
        processing: health.processing,
        deadLetter: health.deadLetter,
        oldestQueuedAgeSeconds: health.oldestQueuedAt
          ? Math.max(0, Math.floor((Date.now() - health.oldestQueuedAt.getTime()) / 1_000))
          : null,
      };
    },
  };
}
