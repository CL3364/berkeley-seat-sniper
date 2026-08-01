import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMailDispatcher, createNoopTransport, createNotifier } from '../../src/notify';
import { validateServerRuntimeConfig } from '../../src/server/app';
import { readBackupReadiness, readBackupReadinessConfig } from '../../src/server/backup-readiness';
import { readProxyTrustPolicy } from '../../src/server/rate-limit';

const RUNTIME_ENV_KEYS = [
  'NODE_ENV',
  'MAIL_TRANSPORT',
  'MAIL_PROVIDER',
  'MAIL_FROM',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'OPERATOR_EMAIL',
  'APP_BASE_URL',
  'TOKEN_SECRET',
  'NOOP_OUTBOX_FILE',
  'TRUST_PROXY',
  'PROXY_HEADER_SECRET',
  'BACKUP_SUCCESS_MARKER_FILE',
  'BACKUP_MAX_STALE_SECONDS',
  'DISK_READINESS_PATH',
  'HEALTH_DISK_MIN_FREE_KB',
] as const;

let originalEnv: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of RUNTIME_ENV_KEYS) {
    if (process.env[key] !== undefined) originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureValidProduction(markerPath: string): void {
  process.env.NODE_ENV = 'production';
  process.env.MAIL_TRANSPORT = 'real';
  process.env.MAIL_PROVIDER = 'resend';
  process.env.MAIL_FROM = 'Berkeley Seat Sniper <alerts@calstudent.org>';
  process.env.RESEND_API_KEY = 're_runtime_test_value';
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.alloc(24, 0x42).toString('base64')}`;
  process.env.OPERATOR_EMAIL = 'ops@calstudent.org';
  process.env.APP_BASE_URL = 'https://seats.calstudent.org';
  process.env.TOKEN_SECRET = 'runtime-safety-token-secret-at-least-32-characters';
  process.env.TRUST_PROXY = '1';
  process.env.PROXY_HEADER_SECRET = 'proxy-runtime-secret-at-least-32-characters';
  process.env.BACKUP_SUCCESS_MARKER_FILE = markerPath;
  process.env.BACKUP_MAX_STALE_SECONDS = '5400';
  process.env.DISK_READINESS_PATH = join(markerPath, '..');
  process.env.HEALTH_DISK_MIN_FREE_KB = '1';
}

describe('AC-26 production mail and entrypoint guards', () => {
  let directory: string;
  let markerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'seat-sniper-runtime-'));
    markerPath = join(directory, 'backup-success.json');
    writeFileSync(markerPath, JSON.stringify({ completedAt: new Date().toISOString() }));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['unset transport', 'MAIL_TRANSPORT', undefined, /MAIL_TRANSPORT/],
    ['noop transport', 'MAIL_TRANSPORT', 'noop', /MAIL_TRANSPORT/],
    ['wrong provider', 'MAIL_PROVIDER', 'smtp', /MAIL_PROVIDER/],
    ['noop sink', 'NOOP_OUTBOX_FILE', '/tmp/forbidden.ndjson', /NOOP_OUTBOX_FILE/],
  ] as const)('server rejects %s before serving', (_name, key, value, expected) => {
    configureValidProduction(markerPath);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(() => validateServerRuntimeConfig()).toThrow(expected);
  });

  it.each([
    ['MAIL_FROM', /MAIL_FROM/],
    ['RESEND_API_KEY', /RESEND_API_KEY/],
    ['RESEND_WEBHOOK_SECRET', /RESEND_WEBHOOK_SECRET/],
    ['OPERATOR_EMAIL', /OPERATOR_EMAIL/],
    ['APP_BASE_URL', /APP_BASE_URL/],
    ['TOKEN_SECRET', /TOKEN_SECRET/],
  ] as const)('notify and worker dispatcher fail loudly without %s', (key, expected) => {
    configureValidProduction(markerPath);
    delete process.env[key];
    expect(() => createNotifier({ push: null })).toThrow(expected);
    expect(() => createMailDispatcher({ push: null })).toThrow(expected);
  });

  it('rejects an explicitly injected noop transport in production', () => {
    configureValidProduction(markerPath);
    const noop = createNoopTransport();
    expect(() => createNotifier({ transport: noop, push: null })).toThrow(/noop/i);
    expect(() => createMailDispatcher({ transport: noop, push: null })).toThrow(/noop/i);
  });

  it('requires a strong TOKEN_SECRET for an injected unbranded real transport', () => {
    process.env.NODE_ENV = 'test';
    process.env.MAIL_TRANSPORT = 'noop';
    const transport = {
      async send(): Promise<void> {},
    };

    delete process.env.TOKEN_SECRET;
    expect(() => createNotifier({ transport, push: null })).toThrow(/TOKEN_SECRET/);

    process.env.TOKEN_SECRET = 'short';
    expect(() => createNotifier({ transport, push: null })).toThrow(/TOKEN_SECRET/);

    process.env.TOKEN_SECRET = 'injected-real-token-secret-at-least-32-characters';
    expect(() => createNotifier({ transport, push: null })).not.toThrow();
  });

  it('constructs server, notifier, and worker dispatcher guards with complete real-mail config', () => {
    configureValidProduction(markerPath);
    expect(validateServerRuntimeConfig().diskReadinessConfig).toEqual({
      path: directory,
      minFreeKb: 1,
    });
    expect(() => createNotifier({ push: null })).not.toThrow();
    expect(() => createMailDispatcher({ push: null })).not.toThrow();
  });

  it('keeps the dev/test noop verification path valid', () => {
    process.env.NODE_ENV = 'test';
    process.env.MAIL_TRANSPORT = 'noop';
    process.env.NOOP_OUTBOX_FILE = join(markerPath, '..', 'noop.ndjson');
    expect(() => validateServerRuntimeConfig()).not.toThrow();
    expect(() => createNotifier({ push: null })).not.toThrow();
    expect(() => createMailDispatcher({ push: null })).not.toThrow();
  });
});

describe('AC-20 authenticated production proxy configuration', () => {
  it.each([
    [{ NODE_ENV: 'production', TRUST_PROXY: '0' }, /TRUST_PROXY=1/],
    [{ NODE_ENV: 'production' }, /TRUST_PROXY=1/],
    [{ NODE_ENV: 'production', TRUST_PROXY: '1' }, /PROXY_HEADER_SECRET.*32-256.*base64url/],
    [
      { NODE_ENV: 'production', TRUST_PROXY: '1', PROXY_HEADER_SECRET: 'short' },
      /PROXY_HEADER_SECRET.*32-256.*base64url/,
    ],
    [
      {
        NODE_ENV: 'production',
        TRUST_PROXY: '1',
        PROXY_HEADER_SECRET: `${'a'.repeat(31)}!`,
      },
      /PROXY_HEADER_SECRET.*32-256.*base64url/,
    ],
  ])('rejects invalid proxy policy %#', (env, expected) => {
    expect(() => readProxyTrustPolicy(env)).toThrow(expected);
  });

  it('accepts the exact authenticated production proxy policy', () => {
    const policy = readProxyTrustPolicy({
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      PROXY_HEADER_SECRET: 'proxy-runtime-secret-at-least-32-characters',
    });
    expect(policy.trustProxy).toBe(true);
    expect(policy.proxySecretDigest).toHaveLength(32);
  });
});

describe('AC-30 bounded production backup marker', () => {
  const nowMs = Date.parse('2030-07-24T12:00:00.000Z');
  let directory: string;
  let markerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'seat-sniper-backup-'));
    markerPath = join(directory, 'backup-success.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function readMarker(
    contents: string,
    maxStaleSeconds = 5_400,
  ): ReturnType<typeof readBackupReadiness> {
    writeFileSync(markerPath, contents);
    return readBackupReadiness({ path: markerPath, maxStaleSeconds, nowMs });
  }

  it('accepts a fresh strict marker and exposes only bounded freshness data', async () => {
    await expect(
      readMarker(JSON.stringify({ completedAt: '2030-07-24T11:59:30.000Z' })),
    ).resolves.toEqual({
      ready: true,
      snapshot: {
        completedAt: '2030-07-24T11:59:30.000Z',
        ageSeconds: 30,
      },
    });
  });

  it.each([
    [
      'missing file',
      async () => readBackupReadiness({ path: markerPath, maxStaleSeconds: 60, nowMs }),
    ],
    ['malformed JSON', async () => readMarker('{not-json')],
    ['malformed timestamp', async () => readMarker(JSON.stringify({ completedAt: 'yesterday' }))],
    [
      'extra key',
      async () => readMarker(JSON.stringify({ completedAt: '2030-07-24T12:00:00Z', extra: true })),
    ],
    ['oversized marker', async () => readMarker('x'.repeat(1_025))],
    [
      'read error',
      async () => readBackupReadiness({ path: directory, maxStaleSeconds: 60, nowMs }),
    ],
  ] as const)('fails closed for %s', async (_name, read) => {
    await expect(read()).resolves.toEqual({ ready: false, snapshot: null });
  });

  it('rejects stale and any future-dated marker', async () => {
    await expect(
      readMarker(JSON.stringify({ completedAt: '2030-07-24T11:58:59.999Z' }), 60),
    ).resolves.toMatchObject({ ready: false });
    await expect(
      readMarker(JSON.stringify({ completedAt: '2030-07-24T12:00:00.001Z' }), 60),
    ).resolves.toMatchObject({ ready: false });
  });

  it('requires a bounded absolute marker path only in production', () => {
    expect(readBackupReadinessConfig({ NODE_ENV: 'test' })).toBeNull();
    expect(() => readBackupReadinessConfig({ NODE_ENV: 'production' })).toThrow(
      /BACKUP_SUCCESS_MARKER_FILE/,
    );
    expect(() =>
      readBackupReadinessConfig({
        NODE_ENV: 'production',
        BACKUP_SUCCESS_MARKER_FILE: 'relative.json',
      }),
    ).toThrow(/absolute path/);
    expect(
      readBackupReadinessConfig({
        NODE_ENV: 'production',
        BACKUP_SUCCESS_MARKER_FILE: markerPath,
      }),
    ).toEqual({ path: markerPath, maxStaleSeconds: 5_400 });
  });
});
