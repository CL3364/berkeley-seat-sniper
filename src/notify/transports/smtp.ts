/**
 * Production Resend transport.
 *
 * The adapter returns classified outcomes instead of leaking provider response
 * bodies or exception messages across the notify boundary. Every durable job
 * uses one individual request with its own idempotency key. Requests share one
 * start-rate budget (four requests/second by default) and every request has an
 * absolute timeout.
 */

import { EmailSchema } from '../../shared/api';
import { isReservedDeploymentHostname } from '../../shared/deployment-host';
import { getSendTimeoutMs } from '../timeout';
import type { ProviderOutcome, ProviderSuccess, Transport, TransportMessage } from '../types';

const RESEND_API_ORIGIN = 'https://api.resend.com';
const RESEND_SINGLE_PATH = '/emails';
const DEFAULT_RESEND_REQUESTS_PER_SECOND = 4;
const DEFAULT_RATE_LIMIT_RETRY_MS = 1_000;
const MAX_RATE_LIMIT_RETRY_MS = 60 * 60 * 1_000;

export interface ResendConfig {
  provider: 'resend';
  apiKey: string;
  from: string;
  requestsPerSecond?: number;
}

interface HeadersLike {
  get(name: string): string | null;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: HeadersLike | Record<string, string | undefined>;
  body?: { cancel(): Promise<void> } | null;
  json?(): Promise<unknown>;
}

/**
 * Minimal injectable fetch seam. It intentionally exposes no response text:
 * provider error bodies can echo recipient PII and are never needed to classify
 * an HTTP response.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Read and validate required env vars at construction time. */
function readConfig(): ResendConfig {
  const provider = process.env['MAIL_PROVIDER']?.trim() || 'resend';
  const from = process.env['MAIL_FROM']?.trim();
  if (!from) throw new Error('MAIL_FROM env var is required for the real mail transport');
  if (/[\r\n]/.test(from)) throw new Error('MAIL_FROM must be a valid sender mailbox');

  const displayMatch = /^.+\s<([^<>]+)>$/.exec(from);
  const mailbox = displayMatch?.[1] ?? from;
  const senderDomain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
  const placeholderSender =
    process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(senderDomain);
  if (
    !EmailSchema.safeParse(mailbox).success ||
    (from.includes('<') && !displayMatch) ||
    placeholderSender
  ) {
    throw new Error('MAIL_FROM must be a valid sender mailbox or "Display Name <mailbox>"');
  }

  if (provider !== 'resend') {
    throw new Error(
      `unknown MAIL_PROVIDER "${provider}" — Berkeley Seat Sniper v0.4 supports 'resend'`,
    );
  }

  const apiKey = process.env['RESEND_API_KEY']?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY env var is required when MAIL_PROVIDER=resend');

  return {
    provider: 'resend',
    apiKey,
    from,
    requestsPerSecond: parseRequestBudget(process.env['RESEND_REQUESTS_PER_SECOND']),
  };
}

function parseRequestBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESEND_REQUESTS_PER_SECOND;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('RESEND_REQUESTS_PER_SECOND must be a positive integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('RESEND_REQUESTS_PER_SECOND must be an integer from 1 to 100');
  }
  return parsed;
}

/** Create the configured production adapter. */
export function createRealTransport(): Transport {
  return createResendTransport(readConfig(), globalThis.fetch as unknown as FetchLike);
}

/**
 * Build a Resend adapter against an injectable fetch. One process-wide
 * transport instance provides the global request scheduler.
 */
export function createResendTransport(config: ResendConfig, fetchImpl: FetchLike): Transport {
  const timeoutMs = getSendTimeoutMs();
  const reserveRequest = createStartRateBudget(
    config.requestsPerSecond ?? DEFAULT_RESEND_REQUESTS_PER_SECOND,
  );

  async function request(
    wireBody: unknown,
    idempotencyKey: string | undefined,
  ): Promise<ProviderOutcome> {
    await reserveRequest();

    let response: FetchResponseLike;
    try {
      response = await fetchImpl(`${RESEND_API_ORIGIN}${RESEND_SINGLE_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(wireBody),
      });
    } catch {
      return { status: 'retryable', errorCode: 'provider_network_error' };
    }

    if (response.ok) {
      const acceptedAt = new Date();
      const providerMessageId = await readAcceptedId(response);
      const accepted: ProviderSuccess = providerMessageId
        ? { status: 'success', acceptedAt, providerMessageId }
        : { status: 'success', acceptedAt };
      return accepted;
    }

    await discardBody(response);
    return classifyHttpFailure(response);
  }

  return {
    async send(message: TransportMessage): Promise<ProviderOutcome> {
      logAttempt();
      return request(toWireMessage(config.from, message), message.idempotencyKey);
    },
  };
}

function toWireMessage(from: string, message: TransportMessage): Record<string, unknown> {
  return {
    from,
    to: [message.to],
    subject: message.subject,
    text: message.body,
    ...(message.headers ? { headers: message.headers } : {}),
  };
}

function classifyHttpFailure(response: FetchResponseLike): ProviderOutcome {
  if (response.status === 429) {
    return {
      status: 'rate-limited',
      errorCode: 'provider_rate_limited',
      retryAfterMs: parseRetryAfterMs(readHeader(response.headers, 'retry-after')),
    };
  }
  if (response.status === 408 || response.status >= 500) {
    return {
      status: 'retryable',
      errorCode: `provider_http_${boundedHttpStatus(response.status)}`,
    };
  }
  return {
    status: 'permanent',
    errorCode: `provider_http_${boundedHttpStatus(response.status)}`,
  };
}

function boundedHttpStatus(status: number): string {
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : 'unknown';
}

function readHeader(headers: FetchResponseLike['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === 'string') return value;
  }
  return undefined;
}

function parseRetryAfterMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_RATE_LIMIT_RETRY_MS;
  const trimmed = raw.trim();
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    milliseconds = Math.ceil(Number(trimmed) * 1_000);
  } else {
    const retryAt = Date.parse(trimmed);
    milliseconds = Number.isNaN(retryAt) ? DEFAULT_RATE_LIMIT_RETRY_MS : retryAt - Date.now();
  }
  if (!Number.isFinite(milliseconds)) return DEFAULT_RATE_LIMIT_RETRY_MS;
  return Math.min(
    MAX_RATE_LIMIT_RETRY_MS,
    Math.max(DEFAULT_RATE_LIMIT_RETRY_MS, Math.ceil(milliseconds)),
  );
}

async function readAcceptedId(response: FetchResponseLike): Promise<string | undefined> {
  if (!response.json) {
    await discardBody(response);
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  const record = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
  if (!isRecord(record)) return undefined;
  const id = record['id'];
  return typeof id === 'string' && id.length > 0 && id.length <= 512 ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function discardBody(response: FetchResponseLike): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Socket cleanup is best effort and never changes the classified outcome.
  }
}

/**
 * FIFO start-rate scheduler. Provider calls can overlap, but no more than the
 * configured number begin in any one-second interval.
 */
function createStartRateBudget(requestsPerSecond: number): () => Promise<void> {
  const spacingMs = 1_000 / requestsPerSecond;
  let nextStartAt = 0;
  let tail = Promise.resolve();

  return (): Promise<void> => {
    const reservation = tail.then(async () => {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      nextStartAt = Date.now() + spacingMs;
    });
    tail = reservation.catch(() => undefined);
    return reservation;
  };
}

function logAttempt(): void {
  console.log(
    JSON.stringify({
      level: 'info',
      transport: 'resend',
      event: 'mail_attempt',
    }),
  );
}
