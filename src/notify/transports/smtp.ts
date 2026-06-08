/**
 * Real-mail transport stub (Resend / SMTP adapter).
 *
 * Required env vars (names only — values NEVER committed or logged):
 *   MAIL_PROVIDER   'resend' | 'smtp'  (defaults to 'smtp' when unset)
 *   MAIL_FROM       sender address, e.g. alerts@yourdomain.com
 *
 *   Resend:
 *     RESEND_API_KEY  secret API key from resend.com
 *
 *   SMTP:
 *     SMTP_HOST       mail server hostname
 *     SMTP_PORT       mail server port (default 587)
 *     SMTP_USER       SMTP username / login
 *     SMTP_PASS       SMTP password
 *
 * This stub is intentionally thin: it validates that the required env vars are
 * present at construction time and then logs what it *would* send without
 * making an actual network call. Replace the stub body of `send` with a real
 * Resend SDK call or nodemailer invocation when the provider is ready — the
 * interface and env-var contract are stable.
 *
 * NEVER add any network call here that tests can trigger without guarding on
 * MAIL_TRANSPORT !== 'noop'. Tests wire the noop transport; this file is not
 * exercised in automated tests (by design — no real network in tests).
 */

import type { Transport, TransportMessage } from '../types';

interface ResendConfig {
  provider: 'resend';
  apiKey: string;
  from: string;
}

interface SmtpConfig {
  provider: 'smtp';
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

type MailConfig = ResendConfig | SmtpConfig;

/** Read and validate required env vars at construction time. Throws on missing keys. */
function readConfig(): MailConfig {
  const provider = process.env['MAIL_PROVIDER'] ?? 'smtp';
  const from = process.env['MAIL_FROM'];
  if (!from) throw new Error('MAIL_FROM env var is required for the real mail transport');

  if (provider === 'resend') {
    const apiKey = process.env['RESEND_API_KEY'];
    if (!apiKey) throw new Error('RESEND_API_KEY env var is required when MAIL_PROVIDER=resend');
    return { provider: 'resend', apiKey, from };
  }

  // Default: smtp
  const host = process.env['SMTP_HOST'];
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];
  if (!host) throw new Error('SMTP_HOST env var is required for the smtp mail transport');
  if (!user) throw new Error('SMTP_USER env var is required for the smtp mail transport');
  if (!pass) throw new Error('SMTP_PASS env var is required for the smtp mail transport');

  const portRaw = process.env['SMTP_PORT'];
  const port = portRaw ? parseInt(portRaw, 10) : 587;
  if (Number.isNaN(port)) throw new Error('SMTP_PORT must be a number');

  return { provider: 'smtp', host, port, user, pass, from };
}

/**
 * Create the real-mail transport. Throws at construction time when required
 * env vars are missing, so misconfiguration surfaces at startup, not mid-cycle.
 *
 * Delivery failures are re-thrown so the Notifier layer can surface them to
 * the worker (the cycle fails loudly rather than silently dropping alerts).
 */
export function createRealTransport(): Transport {
  const config = readConfig();

  return {
    async send(message: TransportMessage): Promise<void> {
      // Structured log — address is NOT included (PII rule / AC-8).
      console.log(
        JSON.stringify({
          level: 'info',
          transport: config.provider,
          event: 'mail_attempt',
          subject: message.subject,
          from: message.from,
        }),
      );

      if (config.provider === 'resend') {
        await sendViaResend(config, message);
      } else {
        await sendViaSmtp(config, message);
      }
    },
  };
}

/**
 * Send via Resend REST API. Swap the stub body for the real `fetch` call once
 * the dependency is approved (library-governance / constitution: no new runtime
 * dep without a clear reason; use the existing `fetch` global from Node 20+).
 */
async function sendViaResend(config: ResendConfig, message: TransportMessage): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      text: message.body,
    }),
  });

  if (!response.ok) {
    // Do not log the response body — it may contain PII or secrets.
    throw new Error(`Resend API error: HTTP ${response.status}`);
  }
}

/**
 * Send via SMTP. Requires nodemailer at runtime — add it to dependencies when
 * this path is enabled. The stub throws a clear error rather than crashing
 * silently so the operator knows exactly what to add.
 *
 * Replace this stub with:
 *   import nodemailer from 'nodemailer';
 *   const transporter = nodemailer.createTransport({ host, port, auth: { user, pass } });
 *   await transporter.sendMail({ from, to, subject, text: body });
 */
async function sendViaSmtp(_config: SmtpConfig, message: TransportMessage): Promise<void> {
  // STUB: Replace with real nodemailer invocation (add nodemailer to deps).
  // Required fields from _config: host, port, user, pass, from.
  throw new Error(
    'SMTP transport is a stub. Add nodemailer to dependencies and replace this throw ' +
      `with a real sendMail call. Message subject: ${message.subject}`,
  );
}
