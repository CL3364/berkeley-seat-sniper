/**
 * Web-push transport (FR-15 / D10). Two implementations behind one interface:
 *
 *   createWebPushTransport() — real, wraps the `web-push` library. Reads VAPID
 *     keys from the environment ONLY. When VAPID is unset, push is silently
 *     DISABLED (email-only) — legal config per the spec, unlike a missing
 *     OPERATOR_EMAIL.
 *
 *   createFakePushTransport() — records `(endpoint, payload)` pairs so tests
 *     verify the alerts-only payload and the 404/410 cleanup with NO network.
 *
 * Contract invariants:
 *   - ALERTS-ONLY: the payload is always a PushAlertPayload (no token, no
 *     confirm/manage URL — enforced by the schema at the seam in index.ts).
 *   - A normal delivery failure (incl. a gone subscription) returns a result;
 *     it does NOT throw. The notifier isolates everything anyway so push can
 *     never block or fail the email path.
 *   - Delivery credentials (endpoint, keys) are NEVER logged (constitution / AC-8).
 *
 * Required env vars (names only — values from the environment, never committed):
 *   VAPID_PUBLIC_KEY   VAPID public key (also served by GET /api/push/vapid-public-key)
 *   VAPID_PRIVATE_KEY  VAPID private key (secret)
 *   VAPID_SUBJECT      a mailto: or https: contact URL for the push service
 */

import webpush from 'web-push';
import { createECDH, ECDH, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { PushAlertPayload } from '../../shared/seat-state';
import { isSafePushEndpointUrl } from '../../shared/push-endpoint';
import { EmailSchema } from '../../shared/api';
import { isReservedDeploymentHostname } from '../../shared/deployment-host';
import type { PushSendResult, PushTarget, PushTransport } from '../types';
import { getSendTimeoutMs } from '../timeout';

/** HTTP statuses from a push service meaning "this subscription is gone" (spec §5). */
const GONE_STATUSES = new Set([404, 410]);
/** Seat availability is volatile; never let a push service retain it for weeks. */
const PUSH_TTL_SECONDS = 5 * 60;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

const IPV4_SPECIAL_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  IPV4_SPECIAL_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
const IPV6_SPECIAL_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  IPV6_SPECIAL_NETWORKS.addSubnet(network, prefix, 'ipv6');
}

/** Reject every non-global address before opening a push-service connection. */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !IPV4_SPECIAL_NETWORKS.check(address, 'ipv4');
  }
  if (family === 6) {
    return !IPV6_SPECIAL_NETWORKS.check(address, 'ipv6');
  }
  return false;
}

async function resolvePublicAddresses(
  hostname: string,
  timeoutMs: number,
): Promise<ResolvedAddress[]> {
  const resolver = new Resolver();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resolver.cancel();
  }, timeoutMs);
  try {
    const [v6, v4] = await Promise.allSettled([
      resolver.resolve6(hostname),
      resolver.resolve4(hostname),
    ]);
    if (timedOut) throw new Error('push DNS resolution timed out');
    const addresses = [
      ...(v6.status === 'fulfilled'
        ? v6.value.map((address) => ({ address, family: 6 as const }))
        : []),
      ...(v4.status === 'fulfilled'
        ? v4.value.map((address) => ({ address, family: 4 as const }))
        : []),
    ];
    const publicAddresses = addresses
      .filter(
        (candidate): candidate is { address: string; family: 4 | 6 } =>
          (candidate.family === 4 || candidate.family === 6) &&
          isPublicNetworkAddress(candidate.address),
      )
      .map(({ address, family }) => ({ address, family }));
    const unique = Array.from(
      new Map(
        publicAddresses.map((candidate) => [`${candidate.family}:${candidate.address}`, candidate]),
      ).values(),
    );
    if (unique.length === 0) throw new Error('push endpoint did not resolve to a public address');
    return unique;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one generated web-push request with an absolute deadline. We connect to
 * the already-vetted IP while retaining the original hostname for Host/SNI, so
 * DNS cannot rebind between validation and egress. The response body is never
 * buffered; only the status code is needed.
 */
async function tryPreparedPushAddress(
  endpoint: URL,
  resolved: ResolvedAddress,
  details: ReturnType<typeof webpush.generateRequestDetails>,
  timeoutMs: number,
): Promise<PushSendResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let tlsConnected = false;
    const finish = (result: PushSendResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = request(
      {
        protocol: 'https:',
        hostname: resolved.address,
        family: resolved.family,
        port: endpoint.port ? Number(endpoint.port) : 443,
        servername: endpoint.hostname,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: details.method,
        headers: { ...details.headers, host: endpoint.host },
        agent: false,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        // Do not let an untrusted endpoint stream an unbounded response body.
        response.destroy();
        finish({
          ok: statusCode >= 200 && statusCode < 300,
          gone: GONE_STATUSES.has(statusCode),
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('absolute push deadline exceeded'));
      finish(tlsConnected ? { ok: false, gone: false } : null);
    }, timeoutMs);
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        tlsConnected = true;
      });
    });
    // Retry only failures proven to precede a TLS connection. Once connected,
    // the provider may have accepted a request even if its response is lost;
    // replaying against another address could create a duplicate notification.
    req.on('error', () => finish(tlsConnected ? { ok: false, gone: false } : null));
    req.end(details.body ?? undefined);
  });
}

async function sendPreparedPush(
  target: PushTarget,
  payload: PushAlertPayload,
  timeoutMs: number,
): Promise<PushSendResult> {
  if (!isSafePushEndpointUrl(target.endpoint)) return { ok: false, gone: false };

  const endpoint = new URL(target.endpoint);
  const deadlineAt = Date.now() + timeoutMs;
  const details = webpush.generateRequestDetails(
    { endpoint: target.endpoint, keys: target.keys },
    JSON.stringify(payload),
    { TTL: PUSH_TTL_SECONDS, urgency: 'high' },
  );
  const addresses = await resolvePublicAddresses(endpoint.hostname, timeoutMs);

  for (let index = 0; index < addresses.length; index += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    // Divide the remaining deadline among the remaining addresses. This keeps
    // an unreachable first AAAA record from consuming the whole send budget.
    const attemptMs = Math.max(1, Math.floor(remainingMs / (addresses.length - index)));
    const result = await tryPreparedPushAddress(endpoint, addresses[index]!, details, attemptMs);
    if (result !== null) return result;
  }

  return { ok: false, gone: false };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function decodeVapidKey(value: string, expectedBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === expectedBytes && decoded.toString('base64url') === value
    ? decoded
    : null;
}

function validateVapidPublicKey(publicKey: string): Buffer {
  const publicBytes = decodeVapidKey(publicKey, 65);
  if (!publicBytes || publicBytes[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a canonical uncompressed P-256 key');
  }
  try {
    void ECDH.convertKey(publicBytes, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    throw new Error('VAPID_PUBLIC_KEY must encode a valid P-256 curve point');
  }
  return publicBytes;
}

/**
 * API-role config: the browser endpoint needs only the public key. When a
 * single-process/dev environment also supplies signing material, validate the
 * complete unit; production Compose withholds both private key and subject.
 */
export function readVapidPublicKey(): string | null {
  const publicKey = process.env['VAPID_PUBLIC_KEY']?.trim();
  const privateKey = process.env['VAPID_PRIVATE_KEY']?.trim();
  const subject = process.env['VAPID_SUBJECT']?.trim();
  if (!publicKey) {
    if (privateKey || subject) {
      throw new Error('VAPID_PRIVATE_KEY/VAPID_SUBJECT cannot be set without VAPID_PUBLIC_KEY');
    }
    return null;
  }
  void validateVapidPublicKey(publicKey);
  if (privateKey || subject) return readVapidConfig()?.publicKey ?? null;
  return publicKey;
}

/**
 * Read VAPID config from env. All three values are one configuration unit:
 * none means push is disabled; any partial set is a startup error.
 */
export function readVapidConfig(): VapidConfig | null {
  const publicKey = process.env['VAPID_PUBLIC_KEY']?.trim();
  const privateKey = process.env['VAPID_PRIVATE_KEY']?.trim();
  const subject = process.env['VAPID_SUBJECT']?.trim();
  const configured = [publicKey, privateKey, subject].filter(
    (value): value is string => value !== undefined && value.length > 0,
  ).length;
  if (configured === 0) return null;
  if (configured !== 3 || !publicKey || !privateKey || !subject) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be set together');
  }
  const publicBytes = validateVapidPublicKey(publicKey);
  const privateBytes = decodeVapidKey(privateKey, 32);
  if (!privateBytes) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be canonical P-256 keys');
  }
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    const derivedPublic = ecdh.getPublicKey(undefined, 'uncompressed');
    if (!timingSafeEqual(publicBytes, derivedPublic)) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be one matching P-256 pair');
  }
  let subjectUrl: URL;
  try {
    subjectUrl = new URL(subject);
  } catch {
    throw new Error('VAPID_SUBJECT must be an https: or mailto: contact URI');
  }
  if (!['https:', 'mailto:'].includes(subjectUrl.protocol)) {
    throw new Error('VAPID_SUBJECT must be an https: or mailto: contact URI');
  }
  if (subjectUrl.protocol === 'mailto:') {
    const mailbox = decodeURIComponent(subjectUrl.pathname);
    const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
    if (
      subjectUrl.search ||
      subjectUrl.hash ||
      !EmailSchema.safeParse(mailbox).success ||
      (process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(domain))
    ) {
      throw new Error('VAPID_SUBJECT mailto: must name a real monitored inbox');
    }
  } else {
    const hostname = subjectUrl.hostname.toLowerCase();
    const literalIp = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
    const localName = /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname);
    if (
      subjectUrl.username ||
      subjectUrl.password ||
      !hostname.includes('.') ||
      literalIp ||
      localName ||
      (process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(hostname))
    ) {
      throw new Error('VAPID_SUBJECT https: must name a real public operator page');
    }
  }
  return { publicKey, privateKey, subject };
}

/**
 * Create the real web-push transport. If VAPID env is unset the transport is
 * inert (`enabled === false`) and every `send` is a no-op returning
 * `{ ok: false, gone: false }` — the notifier then delivers email only.
 */
export function createWebPushTransport(): PushTransport {
  const config = readVapidConfig();
  const timeoutMs = getSendTimeoutMs();

  if (config === null) {
    console.log(
      JSON.stringify({
        level: 'info',
        transport: 'web-push',
        event: 'push_disabled',
        reason: 'vapid_unconfigured',
      }),
    );
    return disabledPushTransport();
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  return {
    enabled: true,
    async send(target: PushTarget, payload: PushAlertPayload): Promise<PushSendResult> {
      try {
        return await sendPreparedPush(target, payload, timeoutMs);
      } catch {
        return { ok: false, gone: false };
      }
    },
  };
}

/** A push transport that always reports disabled. Used when VAPID is unset. */
function disabledPushTransport(): PushTransport {
  return {
    enabled: false,
    async send(): Promise<PushSendResult> {
      return { ok: false, gone: false };
    },
  };
}

/** A recorded push for test assertions: the endpoint + the exact payload sent. */
export interface RecordedPush {
  endpoint: string;
  payload: PushAlertPayload;
}

/** A fake push transport with programmable per-endpoint outcomes (for tests). */
export interface FakePushTransport extends PushTransport {
  /** Every `(endpoint, payload)` the notifier handed this transport. */
  readonly sent: RecordedPush[];
  /** Mark an endpoint as gone (next send for it returns gone:true). */
  markGone(endpoint: string): void;
  /** Make the next send for an endpoint throw (to test failure isolation). */
  throwOn(endpoint: string): void;
}

/**
 * Create a fake push transport (FR-8 verification universe). Records every
 * `(endpoint, payload)` pair. By default `enabled: true` so dispatch attempts a
 * push; pass `{ enabled: false }` to simulate VAPID-unconfigured.
 */
export function createFakePushTransport(opts: { enabled?: boolean } = {}): FakePushTransport {
  const sent: RecordedPush[] = [];
  const goneEndpoints = new Set<string>();
  const throwEndpoints = new Set<string>();

  return {
    enabled: opts.enabled ?? true,
    sent,
    markGone(endpoint: string): void {
      goneEndpoints.add(endpoint);
    },
    throwOn(endpoint: string): void {
      throwEndpoints.add(endpoint);
    },
    async send(target: PushTarget, payload: PushAlertPayload): Promise<PushSendResult> {
      if (throwEndpoints.has(target.endpoint)) {
        throw new Error('fake push transport: forced throw');
      }
      sent.push({ endpoint: target.endpoint, payload });
      if (goneEndpoints.has(target.endpoint)) {
        return { ok: false, gone: true };
      }
      return { ok: true, gone: false };
    },
  };
}
