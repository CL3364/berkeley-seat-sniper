/**
 * E2E outbox sink — the black-box bridge to the emailed confirm/manage links.
 *
 * The token that reaches a subscriber (the signed HMAC manage/confirm token)
 * lives ONLY in the email body — never in any API response (double opt-in, D3 /
 * FR-9). To drive the token-gated journeys (confirm → manage, unsubscribe,
 * pending banner, resend-upgrade) a black-box browser test needs to read that
 * link out of band.
 *
 * The mechanism (FR-8 / §6): when `NOOP_OUTBOX_FILE` is set AND the
 * transport is noop, the durable worker dispatcher appends every accepted
 * outbox entry as one NDJSON line `{ kind, to, subject, body, sentAt }`. The
 * file is PII+token-bearing BY DESIGN — dev/test only, gitignored
 * (`test-results/`), never set in production.
 *
 * playwright.config.ts points `NOOP_OUTBOX_FILE` at OUTBOX_FILE below and sets
 * APP_BASE_URL to the test server so the emitted links are directly navigable.
 * `e2e/global-setup.ts` deletes the file before the run so a stale file from a
 * prior run can never pollute link extraction.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface E2ePaths {
  runDir: string;
  outboxFile: string;
  artifactDir: string;
}

/** Create invocation-isolated, gitignored paths before Playwright forks. */
export function defaultE2ePaths(configPid: number): E2ePaths {
  const runDir = resolve(HERE, '..', 'test-results', `e2e-${configPid}`);
  return {
    runDir,
    outboxFile: resolve(runDir, 'noop-outbox.ndjson'),
    artifactDir: resolve(runDir, 'artifacts'),
  };
}

/**
 * `playwright.config.ts` pins this before global setup/test workers fork. A
 * direct helper import outside Playwright retains a harmless isolated fallback.
 */
export const OUTBOX_FILE = process.env.E2E_OUTBOX_FILE ?? defaultE2ePaths(process.pid).outboxFile;

/** Kinds that carry an extractable emailed link (spec §4 pinned formats). */
export type LinkKind = 'confirmation' | 'manage-link';

/** Which query param each link kind puts the token in (spec §4). */
const LINK_PARAM: Record<LinkKind, 'confirm' | 'token'> = {
  confirmation: 'confirm',
  'manage-link': 'token',
};

/** One appended outbox line — exactly the pinned NDJSON shape. */
export interface OutboxLine {
  kind: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** Result of a successful outbox match: the raw entry plus the extracted link. */
export interface OutboxMatch {
  entry: OutboxLine;
  /** The absolute confirm/manage URL as emailed (its own line in the body). */
  url: string;
  /** The raw signed token from that URL's query param. */
  token: string;
}

/**
 * Read + parse every NDJSON line currently in the sink. A missing file (nothing
 * emailed yet) reads as empty; a partial/corrupt trailing line (a read racing an
 * append) is skipped rather than throwing — the caller polls, so a transient
 * empty/partial read just retries.
 */
export function readOutboxLines(): OutboxLine[] {
  let raw: string;
  try {
    raw = readFileSync(OUTBOX_FILE, 'utf8');
  } catch {
    return [];
  }
  const out: OutboxLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as OutboxLine);
    } catch {
      // A line still being written — ignore; the next poll will pick it up.
    }
  }
  return out;
}

/**
 * Poll the sink for the LAST entry of `kind` addressed to exactly `email`, then
 * regex/URL-extract the emailed link + its token from the body.
 *
 * Why last-match + exact-email filter: the sink ACCUMULATES across every test in
 * a run (one shared file), so filtering by the test's unique @berkeley.edu address
 * AND taking the most recent entry isolates this test's link deterministically —
 * no cross-test bleed even though many entries share the file.
 *
 * Why poll: the API commits the durable job before returning, but the worker
 * dispatcher accepts and records it asynchronously. Web-first polling absorbs
 * that queue handoff and the filesystem round-trip without a fixed sleep.
 */
export async function pollOutboxFor(email: string, kind: LinkKind): Promise<OutboxMatch> {
  let last: OutboxLine | undefined;
  await expect
    .poll(
      () => {
        const matches = readOutboxLines().filter((e) => e.kind === kind && e.to === email);
        last = matches.at(-1);
        return matches.length;
      },
      {
        message: `expected an outbox entry kind="${kind}" to="${email}" in ${OUTBOX_FILE} — is the webServer running with NOOP_OUTBOX_FILE + MAIL_TRANSPORT=noop?`,
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);

  // `last` is defined here: the poll only resolves once the count is > 0.
  const entry = last as OutboxLine;
  const param = LINK_PARAM[kind];

  // The link is rendered on its own line (render.ts); grab the whole absolute URL.
  const urlLine = entry.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^https?:\/\//.test(l) && l.includes(`${param}=`));
  if (!urlLine) {
    throw new Error(`no ${param} link line found in ${kind} body for ${email}`);
  }

  const token = new URL(urlLine).searchParams.get(param);
  if (!token) {
    throw new Error(`no "${param}" token in extracted URL ${urlLine}`);
  }

  return { entry, url: urlLine, token };
}
