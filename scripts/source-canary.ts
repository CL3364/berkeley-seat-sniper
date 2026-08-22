/**
 * One-shot live-source canary (LEAD-ONLY, owner-authorized, run by hand).
 *
 * Purpose: answer the single question the fixtures cannot — does `parseClassPage`
 * still understand a REAL `classes.berkeley.edu` page today? Every seat number this
 * project has ever parsed came from `src/scraper/fixtures/**`, captured in June.
 *
 * This is NOT the poller and must never become it:
 *   - exactly ONE class page is fetched, once, and the process exits;
 *   - robots.txt is evaluated first through the production code path
 *     (`fetchClassObservation` -> `checkRobots`), and a disallow aborts before any
 *     content request;
 *   - the identifying, contactable `FETCH_USER_AGENT` is required — no default;
 *   - `KILL_SWITCH=0` must be set EXPLICITLY by the operator for this run. The
 *     tracked repository default stays `1`, and nothing here changes it.
 *
 * Usage:
 *   KILL_SWITCH=0 FETCH_USER_AGENT='BerkeleySeatSniper/1 (+mailto:you@example.com)' \
 *     npx tsx scripts/source-canary.ts <class-key-or-url>
 *
 * Output is operator-facing only: parsed field values and HTTP metadata. It prints
 * no page HTML and no PII (§6 / constitution).
 */

import { writeFileSync } from 'node:fs';

import { fetchClassObservation } from '../src/scraper/fetch';
import { normalizeClassKey } from '../src/shared/class-key';
import { isParserBroke, isClassGone } from '../src/shared/seat-state';

function fail(message: string): never {
  console.error(`canary: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) fail('usage: npx tsx scripts/source-canary.ts <class-key-or-url>');

  // Refuse to run unless the operator opted in deliberately, per FR-7. These are
  // the same two gates the worker enforces; the canary must not be an easier path.
  if (process.env.KILL_SWITCH !== '0') {
    fail('KILL_SWITCH must be exactly "0" for this run — refusing to fetch');
  }
  const userAgent = process.env.FETCH_USER_AGENT?.trim();
  if (!userAgent || !/mailto:|https?:\/\//i.test(userAgent)) {
    fail('FETCH_USER_AGENT must be set and carry a contactable mailto: or URL');
  }

  const normalized = normalizeClassKey(raw);
  if (!normalized.ok) fail(`could not normalize "${raw}" (${normalized.reason})`);
  const classKey = normalized.key;

  console.log(`canary: user-agent  ${userAgent}`);
  console.log(`canary: class-key   ${classKey}`);
  console.log('canary: checking robots.txt first, then ONE class page…\n');

  // Optional: keep the exact bytes as a regression fixture so the next parser
  // change is testable OFFLINE. Capturing turns a live dependency into a
  // permanent test — the whole point of one authorized fetch.
  const saveIndex = process.argv.indexOf('--save');
  const savePath = saveIndex === -1 ? null : process.argv[saveIndex + 1];
  if (saveIndex !== -1 && !savePath) fail('--save requires a path');

  const started = Date.now();
  const observation = await fetchClassObservation(classKey, {
    onNetworkError: 'return-broke',
    ...(savePath
      ? {
          fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const response = await fetch(input, init);
            const url = typeof input === 'string' ? input : String(input);
            // Only capture the class page, never robots.txt.
            if (url.includes('/content/')) {
              const clone = response.clone();
              writeFileSync(savePath, await clone.text(), 'utf8');
              console.log(`canary: saved live page -> ${savePath}`);
            }
            return response;
          },
        }
      : {}),
  });
  const elapsedMs = Date.now() - started;

  if (observation.kind === 'not-modified') {
    console.log(`RESULT: not-modified (304) in ${elapsedMs}ms — no body to parse`);
    return;
  }

  const result = observation.result;

  if (isParserBroke(result)) {
    console.log(`RESULT: parser-broke in ${elapsedMs}ms`);
    console.log(`  detail: ${result.detail}`);
    console.log('\nThe page exists but the parser could not read it. If the detail names a');
    console.log('missing labeled field, Berkeley changed the markup and the fixtures are stale.');
    process.exitCode = 2;
    return;
  }

  if (isClassGone(result)) {
    console.log(`RESULT: class-gone in ${elapsedMs}ms`);
    console.log(`  detail: ${result.detail}`);
    console.log('\nThat class key does not resolve to a live page. Re-run with a current one;');
    console.log('this is NOT evidence that the parser is broken.');
    process.exitCode = 3;
    return;
  }

  console.log(`RESULT: parsed OK in ${elapsedMs}ms`);
  console.log(`  status         ${result.status}`);
  console.log(`  openSeats      ${result.openSeats}`);
  console.log(`  waitlistOpen   ${result.waitlistOpen}`);
  console.log(`  displayName    ${result.displayName ?? '(absent)'}`);
  console.log(`  enrolled       ${result.enrolled ?? '(absent)'}`);
  console.log(`  capacity       ${result.capacity ?? '(absent)'}`);
  console.log(`  waitlisted     ${result.waitlisted ?? '(absent)'}`);
  console.log(`  waitlistMax    ${result.waitlistMax ?? '(absent)'}`);
  console.log(`  fetchedAt      ${result.fetchedAt}`);
  if (observation.cache) {
    console.log(`  cache          ${JSON.stringify(observation.cache)}`);
  }
  console.log('\nThe live markup still parses. Dashboard fields marked "(absent)" are OPTIONAL');
  console.log('by FR-26 and correctly render as a dash — they are not a parser failure.');
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
