import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AdmissionModeSchema,
  DEFAULT_ADMISSION_MODE,
  PILOT_SUBSCRIBER_LIMIT,
  PilotInviteCodeSchema,
  type AdmissionMode,
} from '../shared/api';

const SHA256_DIGEST_BYTES = 32;

/**
 * Server-only admission state. The raw pilot bearer is reduced to a digest
 * immediately after environment validation and never crosses into a repo,
 * response, durable job, or log record.
 */
export interface AdmissionPolicy {
  mode: AdmissionMode;
  pilotInviteDigest: Buffer | null;
}

function digestInvite(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Parse fail-closed admission configuration without retaining the raw bearer. */
export function readAdmissionPolicy(env: NodeJS.ProcessEnv = process.env): AdmissionPolicy {
  const rawMode = env.ADMISSION_MODE;
  const parsedMode = AdmissionModeSchema.safeParse(
    rawMode === undefined ? DEFAULT_ADMISSION_MODE : rawMode,
  );
  if (!parsedMode.success) {
    throw new Error('ADMISSION_MODE must be one of closed, pilot, or public');
  }

  if (parsedMode.data !== 'pilot') {
    return { mode: parsedMode.data, pilotInviteDigest: null };
  }

  const parsedInvite = PilotInviteCodeSchema.safeParse(env.PILOT_INVITE_CODE);
  if (!parsedInvite.success) {
    throw new Error(
      'PILOT_INVITE_CODE must be a 32-256 character unpadded base64url value in pilot mode',
    );
  }
  return {
    mode: parsedMode.data,
    pilotInviteDigest: digestInvite(parsedInvite.data),
  };
}

/**
 * Decide only whether the rollout gate admits a new subscriber. Request/body,
 * abuse-limit, and source-capacity checks remain separate.
 *
 * Pilot comparisons always execute one fixed-size timing-safe digest compare,
 * including for missing or malformed candidates. Oversize input is never
 * hashed, keeping attacker-controlled CPU and allocation bounded.
 */
export function admissionAllowsCreate(
  policy: AdmissionPolicy,
  candidate: string | null | undefined,
): boolean {
  if (policy.mode === 'public') return true;
  if (policy.mode === 'closed') return false;

  const parsedCandidate = PilotInviteCodeSchema.safeParse(candidate);
  const candidateDigest = digestInvite(parsedCandidate.success ? parsedCandidate.data : '');
  const expectedDigest =
    policy.pilotInviteDigest?.byteLength === SHA256_DIGEST_BYTES
      ? policy.pilotInviteDigest
      : Buffer.alloc(SHA256_DIGEST_BYTES);
  const matches = timingSafeEqual(expectedDigest, candidateDigest);
  return parsedCandidate.success && matches;
}

/** The DB receives only this server-decided count, never the invite bearer. */
export function subscriberLimitForAdmission(policy: AdmissionPolicy): number | undefined {
  return policy.mode === 'pilot' ? PILOT_SUBSCRIBER_LIMIT : undefined;
}
