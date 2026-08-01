/**
 * Playwright global setup — clears the NDJSON outbox sink before the run.
 *
 * The notifier APPENDS to `NOOP_OUTBOX_FILE`; without a reset, entries from a
 * previous `npx playwright test` invocation would linger and a link-extraction
 * poll could match a stale token for a reused email. Deleting the file here (once,
 * before any test or the webServer emits mail) guarantees every run starts from a
 * clean sink. The server re-creates the file (and its dir) on first append.
 *
 * Runs before the tests start, so no email has been sent yet — truncating is safe
 * regardless of the webServer launch order.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { OUTBOX_FILE } from './outbox';

export default function globalSetup(): void {
  // The configured path is unique per Playwright invocation. Remove only that
  // sink so retries within the run share it while concurrent runs stay isolated.
  rmSync(OUTBOX_FILE, { force: true });
  mkdirSync(dirname(OUTBOX_FILE), { recursive: true });
}
