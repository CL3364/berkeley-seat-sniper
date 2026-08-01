/**
 * E2E: subscribe / confirm / manage / unsubscribe / resend journeys
 * (spec v0.4 exact Berkeley identity + durable outbox). Drives a real Chromium
 * browser against Vite and the same-process API/dispatcher harness configured
 * in playwright.config.ts.
 * Each test group maps to one or more acceptance criteria in spec §7. Selector
 * strategy: getByRole / getByLabel / getByText — no CSS selectors. All assertions
 * use web-first auto-waiting; no fixed sleeps.
 *
 * ---------------------------------------------------------------------------
 * The emailed-token wall and the sanctioned noop outbox bridge
 * ---------------------------------------------------------------------------
 * POST /api/subscriptions returns 202 { status: 'pending' } with NO token and NO
 * subscriberId; the manage/confirm token (one HMAC token type, spec §4) reaches
 * the subscriber ONLY by email. So a black-box browser test cannot read a valid
 * token from any API response or the page.
 *
 * FR-8 adds the env-gated bridge this suite uses: with the noop
 * transport AND NOOP_OUTBOX_FILE set (playwright.config.ts points it under the
 * gitignored test-results/), the notifier appends every outbox entry as one
 * NDJSON line { kind, to, subject, body, sentAt } — confirmation bodies carry
 * `${APP_BASE_URL}/?confirm=<token>` on their own line, manage-link bodies
 * `?token=<token>`. The e2e helper pollOutboxFor(email, kind) (e2e/outbox.ts)
 * reads that file, filters kind + exact `to`, takes the LAST match, and extracts
 * the URL + token — exactly how a subscriber "clicks the link in their email".
 *
 * COVERAGE — token-FREE surface (reachable without the sink):
 *  - AC-1 (head): subscribe → 202 { status:'pending' } (no token) →
 *    "Check your inbox to confirm" success state + resend form present.
 *  - AC-2:  inline validation blocks submission; no request leaves the browser.
 *  - AC-2b: duplicate email → conflict copy inline; no token/subscriberId/watch
 *           list anywhere in the response body or on the page.
 *  - AC-11 (non-enumerating): resend reassurance is byte-identical for a known
 *           and an unknown address (FR-10).
 *  - Confirm landing error (?confirm=<invalid> → explicit gesture → "Unable to
 *    confirm") — the scanner-safe explicit-POST design (§4).
 *  - Manage error (?token=<invalid> → "Unable to load subscription").
 *  - Push "not configured" default: GET /api/push/vapid-public-key → null.
 *  - Accessibility (labels, roles, skip-link, keyboard) on the token-free views.
 *
 * COVERAGE — token-GATED surface (unlocked via the noop outbox sink):
 *  - AC-1 (tail): subscribe → extract confirm link → confirm → manage shows the
 *    watched class + email.
 *  - AC-10: revisit the same confirm link → still lands in manage (idempotent).
 *  - Pending banner: `?token=` before confirm shows the confirm banner; gone after.
 *  - AC-7: unsubscribe via manage, then the manage link 404s ("Unable to load
 *    subscription") and the confirm link errors ("Unable to confirm").
 *  - Push toggle (manage, VAPID unset): "Browser push alerts" shows the
 *    not-configured note and no enable button (FR-15).
 *  - AC-11 (upgrade): resend for a Confirmed subscriber emits a manage-link whose
 *    `?token=` URL loads the manage view.
 *
 * Rate-limit note: the E2E harness raises both limits because Redis atomicity
 * and 429 behavior have dedicated integration coverage. Every browser journey
 * still uses a fresh exact @berkeley.edu address.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { pollOutboxFor } from './outbox';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** A valid canonical class key used across multiple tests. */
const CLASS_KEY_1 = '2026-fall-compsci-189-001-lec-001';
/** A second distinct class key. */
const CLASS_KEY_2 = '2026-fall-compsci-61a-001-lec-001';
/** A Berkeley class URL that normalizes to CLASS_KEY_1. */
const CLASS_URL_1 = 'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001';
/** Real catalog-style widened identifier: alphanumeric section/component ids. */
const CLASS_KEY_999L = '2026-fall-compsci-10-999l-lab-999l';
const CLASS_URL_999L = 'https://classes.berkeley.edu/content/2026-fall-compsci-10-999l-lab-999l';
/** Real component shapes covered by the v0.4 bounded grammar. */
const CLASS_KEY_COL = '2026-fall-info-295-001-col-001';
const CLASS_KEY_GRP = '2026-fall-compsci-198-001-grp-001';
const CLASS_KEY_SLF = '2026-fall-english-98-001-slf-001';
const CLASS_KEY_TUT = '2026-fall-math-1a-001-tut-001';

/** Tokens are HMAC `<base64url-payload>.<base64url-sig>`; this matches neither. */
const TOKEN_LOOKING = /[?&](token|confirm)=/;

/** Monotonic counter for unique exact-domain subscriber emails. */
let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `e2e-${process.pid}-${emailSeq}@berkeley.edu`;
}

function uniqueMixedCaseEmail(): { raw: string; normalized: string } {
  emailSeq += 1;
  const local = `e2e-${process.pid}-${emailSeq}`;
  return {
    raw: `  ${local.toUpperCase()}@BERKELEY.EDU  `,
    normalized: `${local}@berkeley.edu`,
  };
}

/**
 * The subscribe FORM (the one with the "Subscribe" submit button). The subscribe
 * page renders TWO inputs labelled "Berkeley email address" — the subscribe form's #email
 * AND the resend form's #resend-email (ResendLinkForm, "Already subscribed? Lost
 * your link?"), which is NESTED inside the same "Watch a class" region. A bare
 * getByLabel('Berkeley email address') — even scoped to the region — is therefore
 * AMBIGUOUS (strict-mode violation). The subscribe and resend <form>s are
 * siblings, so scoping to the subscribe form (first form in the region) isolates
 * its email field cleanly.
 */
function subscribeForm(page: Page) {
  return page
    .getByRole('region', { name: /watch a class/i })
    .locator('form')
    .first();
}

/** The subscribe form's email field, unambiguously scoped to its <form>. */
function subscribeEmailInput(page: Page) {
  return subscribeForm(page).getByLabel('Berkeley email address');
}

/**
 * Fill the subscribe form and click Subscribe. Does not assert the outcome —
 * callers assert success vs. inline error.
 */
async function fillAndSubmitSubscribeForm(
  page: Page,
  email: string,
  classKey: string,
): Promise<void> {
  await subscribeEmailInput(page).fill(email);
  await page.getByLabel('Class 1').fill(classKey);
  await page.getByRole('button', { name: 'Subscribe' }).click();
}

// ---------------------------------------------------------------------------
// Token-gated flow helpers (noop outbox sink) — see the file header.
// ---------------------------------------------------------------------------

/**
 * Subscribe `email` to `classKey`, confirm the check-your-inbox success state,
 * then read the emitted confirmation link out of the outbox sink and return the
 * match ({ entry, url, token }). This is one subscribe request (per-email budget).
 */
async function subscribeAndReadConfirmLink(page: Page, email: string, classKey: string) {
  await page.goto('/');
  await fillAndSubmitSubscribeForm(page, email, classKey);
  await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
  // The confirm link is emailed only — pull it out of band from the noop sink.
  return pollOutboxFor(email, 'confirmation');
}

/**
 * Visit a confirm link and perform the EXPLICIT confirm gesture (§4: a GET
 * prefetch must not auto-confirm). Does NOT assert the outcome — the caller
 * asserts manage (success/idempotent) vs. "Unable to confirm" (missing/invalid).
 */
async function visitAndClickConfirm(page: Page, confirmUrl: string): Promise<void> {
  await page.goto(confirmUrl);
  await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm my email' }).click();
}

/**
 * Submit the subscribe-page resend form ("Already subscribed? Lost your link?")
 * for `email` and wait for the constant reassurance. One resend request
 * (per-email budget). Returns nothing — the caller reads the resulting link from
 * the outbox sink via pollOutboxFor.
 */
async function submitSubscribePageResend(page: Page, email: string): Promise<void> {
  const form = page.getByRole('region', { name: /already subscribed\? lost your link\?/i });
  await form.getByLabel('Berkeley email address').fill(email);
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/subscriptions/resend'),
  );
  await form.getByRole('button', { name: 'Email me my link' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  await expect(
    form.getByText("If that address is subscribed, we've emailed its link. Check your inbox."),
  ).toBeVisible();
}

// ---------------------------------------------------------------------------
// AC-1 (head) [FR-1, FR-9]: subscribe → 202 { status:'pending' }, no token in
// the body, "Check your inbox to confirm" success state.
//
// Serial: each test POSTs /api/subscriptions. Even with the raised per-IP limit
// the per-email window (3/900s) would trip if the SAME email were reused, so we
// use a fresh email per test.
// ---------------------------------------------------------------------------

test.describe.serial('AC-1 (head): subscribe acknowledges with check-your-inbox', () => {
  test('subscribe with a full Berkeley URL → 202 pending, body carries no token, inbox prompt shown', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Watch a class' })).toBeVisible();

    // Intercept the create response to assert the 202 body has NO token and NO
    // subscriberId (FR-9 / AC-1). The URL ends with /api/subscriptions exactly
    // (not /resend) and the method is POST.
    const responsePromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().endsWith('/api/subscriptions') &&
        r.request().resourceType() === 'fetch',
    );

    await subscribeEmailInput(page).fill(email);
    await page.getByLabel('Class 1').fill(CLASS_URL_1);
    await page.getByRole('button', { name: 'Subscribe' }).click();

    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'pending' });
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('subscriberId');
    expect(body).not.toHaveProperty('watches');

    // The double opt-in success state.
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // The OLD deep-link must NOT exist — there is no manage link in the response.
    await expect(page.getByRole('link', { name: /your manage link/i })).toHaveCount(0);

    // No token-bearing href is present anywhere on the success page.
    const tokenHrefs = await page.locator('a[href*="token="], a[href*="confirm="]').count();
    expect(tokenHrefs).toBe(0);

    // The success state offers a resend path ("Didn't get the email?").
    await expect(page.getByRole('heading', { name: /didn't get the email/i })).toBeVisible();
  });

  test('subscribe with a plain code → same check-your-inbox success state', async ({ page }) => {
    const email = uniqueEmail();

    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);

    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
    // Reassurance copy names the address we submitted (status, polite).
    await expect(page.getByText(email)).toBeVisible();
  });

  test('whitespace and case normalize one base Berkeley mailbox', async ({ page }) => {
    const email = uniqueMixedCaseEmail();

    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email.raw, CLASS_KEY_1);

    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
    await expect(page.getByText(email.normalized)).toBeVisible();

    const confirmation = await pollOutboxFor(email.normalized, 'confirmation');
    expect(confirmation.entry.to).toBe(email.normalized);
  });
});

// ---------------------------------------------------------------------------
// AC-2 [FR-1]: invalid input is caught inline — no request sent.
// These never reach the API (client-side validation), so they run in parallel.
// ---------------------------------------------------------------------------

test.describe('AC-2: inline validation blocks invalid input (no request)', () => {
  test('invalid email shows a field error and blocks submission', async ({ page }) => {
    await page.goto('/');

    // Fail the test if ANY subscribe request leaves the browser (AC-2: no row).
    let sawRequest = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/subscriptions')) sawRequest = true;
    });

    await subscribeEmailInput(page).fill('not-an-email');
    await page.getByLabel('Class 1').fill(CLASS_KEY_1);
    await page.getByRole('button', { name: 'Subscribe' }).click();

    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /valid email/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Check your inbox to confirm' }),
    ).not.toBeVisible();
    expect(sawRequest).toBe(false);
  });

  for (const [caseName, email] of [
    ['non-Berkeley domain', 'student@gmail.com'],
    ['Berkeley subdomain', 'student@students.berkeley.edu'],
    ['lookalike suffix', 'student@berkeley.edu.example'],
    ['lookalike domain', 'student@notberkeley.edu'],
  ] as const) {
    test(`${caseName} is rejected by the client before a request leaves`, async ({ page }) => {
      await page.goto('/');
      let sawRequest = false;
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/api/subscriptions')) {
          sawRequest = true;
        }
      });

      await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);

      await expect(
        subscribeForm(page)
          .locator('[role="alert"]')
          .filter({ hasText: /@berkeley\.edu/i }),
      ).toBeVisible();
      expect(sawRequest).toBe(false);
    });
  }

  test('a +tag is rejected before request while its base address remains usable', async ({
    page,
  }) => {
    const base = uniqueEmail();
    const tagged = base.replace('@', '+browser@');
    await page.goto('/');
    let sawTaggedRequest = false;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/subscriptions')) {
        sawTaggedRequest = true;
      }
    });

    await fillAndSubmitSubscribeForm(page, tagged, CLASS_KEY_1);
    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /without a \+ tag|base/i }),
    ).toBeVisible();
    expect(sawTaggedRequest).toBe(false);

    await fillAndSubmitSubscribeForm(page, base, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
    await expect(page.getByText(base)).toBeVisible();
  });

  test('unrecognizable class identifier shows a field error and blocks submission', async ({
    page,
  }) => {
    await page.goto('/');

    let sawRequest = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/subscriptions')) sawRequest = true;
    });

    await subscribeEmailInput(page).fill('valid@berkeley.edu');
    await page.getByLabel('Class 1').fill('not-a-class-code');
    await page.getByRole('button', { name: 'Subscribe' }).click();

    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /recognize/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Check your inbox to confirm' }),
    ).not.toBeVisible();
    expect(sawRequest).toBe(false);
  });

  test('empty class identifier shows the required error on submit', async ({ page }) => {
    await page.goto('/');
    await subscribeEmailInput(page).fill('valid@berkeley.edu');
    await page.getByRole('button', { name: 'Subscribe' }).click();

    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /required/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Check your inbox to confirm' }),
    ).not.toBeVisible();
  });
});

test.describe('AC-17: widened real-world class keys survive the full browser journey', () => {
  test('999l plus COL/GRP/SLF/TUT forms normalize across cap-compliant subscriptions', async ({
    page,
  }) => {
    const email = uniqueEmail();
    const rawInputs = [
      CLASS_URL_999L,
      '2026 Fall INFO 295 001 COL 001',
      '2026 Fall COMPSCI 198 001 GRP 001',
      '2026 Fall ENGLISH 98 001 SLF 001',
    ];
    const expected = [CLASS_KEY_999L, CLASS_KEY_COL, CLASS_KEY_GRP, CLASS_KEY_SLF];

    await page.goto('/');
    await subscribeEmailInput(page).fill(email);
    await page.getByLabel('Class 1').fill(rawInputs[0]!);
    for (let index = 1; index < rawInputs.length; index += 1) {
      await page.getByRole('button', { name: 'Add another class' }).click();
      await page
        .getByRole('textbox', { name: `Class ${index + 1}`, exact: true })
        .fill(rawInputs[index]!);
    }
    await expect(page.getByRole('button', { name: 'Add another class' })).toBeDisabled();

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/subscriptions'),
    );
    await page.getByRole('button', { name: 'Subscribe' }).click();
    const response = await responsePromise;

    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toEqual({ email, classKeys: expected });

    const confirmation = await pollOutboxFor(email, 'confirmation');
    await visitAndClickConfirm(page, confirmation.url);
    const list = page.getByRole('list', { name: 'watched classes' });
    for (const classKey of expected) {
      await expect(list.getByText(classKey)).toBeVisible();
    }

    const tutorialEmail = uniqueEmail();
    await page.goto('/');
    await subscribeEmailInput(page).fill(tutorialEmail);
    await page.getByLabel('Class 1').fill('2026 Fall MATH 1A 001 TUT 001');
    const tutorialResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/subscriptions'),
    );
    await page.getByRole('button', { name: 'Subscribe' }).click();
    const tutorialResponse = await tutorialResponsePromise;
    expect(tutorialResponse.status()).toBe(202);
    expect(tutorialResponse.request().postDataJSON()).toEqual({
      email: tutorialEmail,
      classKeys: [CLASS_KEY_TUT],
    });
    const tutorialConfirmation = await pollOutboxFor(tutorialEmail, 'confirmation');
    await visitAndClickConfirm(page, tutorialConfirmation.url);
    await expect(
      page.getByRole('list', { name: 'watched classes' }).getByText(CLASS_KEY_TUT),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-2b [FR-1, §6 authz]: duplicate email → 409 conflict; the response body
// carries the constant-shaped { error } envelope only — no token, no
// subscriberId, no watch list — and nothing leaks onto the page.
// ---------------------------------------------------------------------------

test.describe.serial('AC-2b: duplicate email rejected with 409, nothing leaked', () => {
  test('second subscribe with the same email → conflict copy inline, no token anywhere', async ({
    page,
  }) => {
    const email = uniqueEmail();

    // First subscription — pending acknowledgement.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();

    // Second attempt with the SAME email on a fresh form. Capture the 409 body.
    await page.goto('/');
    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/subscriptions'),
    );
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_2);
    const response = await responsePromise;

    expect(response.status()).toBe(409);
    const body = (await response.json()) as { error?: { code?: string } } & Record<string, unknown>;
    // Constant-shaped { error } envelope only.
    expect(body.error?.code).toBe('conflict');
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('subscriberId');
    expect(body).not.toHaveProperty('watches');
    // The raw serialized body must not contain a token-ish field name either.
    const raw = await response.text();
    expect(raw).not.toMatch(/"token"|"subscriberId"|"watches"/);

    // The UI surfaces the conflict on the email field and stays on the form.
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /already subscribed/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Check your inbox to confirm' }),
    ).not.toBeVisible();

    // No token-bearing link rendered anywhere.
    const tokenHrefs = await page.locator('a[href*="token="], a[href*="confirm="]').count();
    expect(tokenHrefs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-11 [FR-10]: resend is non-enumerating — a known and an unknown address get
// byte-identical reassurance copy and an identical 202 { status:'sent' } body.
//
// The reassurance form lives on the subscribe page (heading "Already
// subscribed? Lost your link?"). We submit a KNOWN address (subscribed in this
// test) and an UNKNOWN one, and assert identical UI + identical response body.
// ---------------------------------------------------------------------------

test.describe.serial('AC-11: resend is non-enumerating (identical for known + unknown)', () => {
  const REASSURANCE = "If that address is subscribed, we've emailed its link. Check your inbox.";

  /** Submit the subscribe-page resend form for `email`; return the 202 body text. */
  async function submitResend(page: Page, email: string): Promise<string> {
    // The subscribe page has two resend forms (one in the success state, one at
    // the bottom). On the plain subscribe page only the bottom one is present.
    const form = page.getByRole('region', { name: /already subscribed\? lost your link\?/i });
    await form.getByLabel('Berkeley email address').fill(email);
    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/subscriptions/resend'),
    );
    await form.getByRole('button', { name: 'Email me my link' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    // The reassurance is shown identically regardless of existence.
    await expect(form.getByText(REASSURANCE)).toBeVisible();
    return response.text();
  }

  test('a subscribed address and an unknown address get byte-identical responses + copy', async ({
    page,
  }) => {
    const knownEmail = uniqueEmail();
    const unknownEmail = uniqueEmail();

    // Make `knownEmail` a real (pending) subscriber first.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, knownEmail, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();

    // Resend for the KNOWN address.
    await page.goto('/');
    const knownBody = await submitResend(page, knownEmail);

    // Resend for the UNKNOWN address.
    await page.goto('/');
    const unknownBody = await submitResend(page, unknownEmail);

    // Byte-identical bodies — no enumeration oracle (FR-10).
    expect(JSON.parse(knownBody)).toEqual({ status: 'sent' });
    expect(knownBody).toBe(unknownBody);
  });

  test('resend with a malformed email shows an inline validation error (not the reassurance)', async ({
    page,
  }) => {
    await page.goto('/');
    const form = page.getByRole('region', { name: /already subscribed\? lost your link\?/i });
    await form.getByLabel('Berkeley email address').fill('not-an-email');
    await form.getByRole('button', { name: 'Email me my link' }).click();

    await expect(form.locator('[role="alert"]').filter({ hasText: /valid email/i })).toBeVisible();
    // The success reassurance must NOT appear for a malformed shape (400 path).
    await expect(form.getByText(/we've emailed its link/i)).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Confirm landing error path [FR-9, §4]: ?confirm=<invalid> renders the idle
// ConfirmView with an EXPLICIT "Confirm my email" button (a mail-scanner GET
// prefetch cannot auto-confirm). Clicking it calls the confirm endpoint, which
// rejects the bad token (401) → "Unable to confirm".
//
// Happy confirm → manage journeys below obtain a valid token only from noop
// mail, preserving the public API's token-free response contract.
// ---------------------------------------------------------------------------

test.describe('confirm landing (?confirm=) — explicit gesture + invalid-token error', () => {
  test('?confirm=<token> shows an idle confirm screen and confirms only on click', async ({
    page,
  }) => {
    // Track whether the confirm endpoint is hit WITHOUT a user gesture (it must
    // not be — explicit POST only, §4). Navigating must not auto-confirm.
    let confirmCalled = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/confirm$/.test(new URL(req.url()).pathname)) {
        confirmCalled = true;
      }
    });

    await page.goto('/?confirm=some-confirm-token-value');

    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    const confirmButton = page.getByRole('button', { name: 'Confirm my email' });
    await expect(confirmButton).toBeVisible();

    // Give the page a beat to prove no request fired on mere navigation.
    await expect(confirmButton).toBeEnabled();
    expect(confirmCalled).toBe(false);

    // Now the explicit gesture.
    await confirmButton.click();
    // Bad token → 401 → "Unable to confirm" with a safe, friendly message.
    await expect(page.getByRole('heading', { name: 'Unable to confirm' })).toBeVisible();
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /expired or is invalid/i }),
    ).toBeVisible();

    // The error state offers a fresh-link path (the resend form).
    await expect(page.getByRole('heading', { name: /get a fresh link/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Manage error path [FR-2, §4]: an invalid ?token= shows the safe error view,
// never a crash and never internals. This is the same surface a revisited link
// after unsubscribe would hit (AC-7 tail); populated-manage flows below cross
// the emailed-token wall through the sanctioned noop sink.
// ---------------------------------------------------------------------------

test.describe('manage error states (?token=)', () => {
  test('a bogus ?token= shows "Unable to load subscription" with a safe message', async ({
    page,
  }) => {
    await page.goto('/?token=totally-invalid-token-value');

    await expect(page.getByRole('heading', { name: 'Unable to load subscription' })).toBeVisible();
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /expired or is invalid|no longer exists/i }),
    ).toBeVisible();

    // No stack trace / internals leaked into the page.
    await expect(page.getByText(/at .*\(.*:\d+:\d+\)/)).toHaveCount(0);
  });

  test('a syntactically token-shaped but unsigned ?token= still shows the error view', async ({
    page,
  }) => {
    // payload.sig shape but a forged signature → token_invalid (401), safe error.
    // Built at runtime so no JWT-shaped literal sits in source (avoids a
    // false-positive secret finding); the base64url payload is {"sub":"x","exp":9999999999}.
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'x', exp: 9999999999 })).toString(
      'base64url',
    );
    const forgedToken = `${forgedPayload}.forged-signature-bytes`;
    await page.goto(`/?token=${forgedToken}`);
    await expect(page.getByRole('heading', { name: 'Unable to load subscription' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Push "not configured" default [FR-15]: with the noop env (VAPID unset) the
// public-key route returns { publicKey: null }. That null is exactly what makes
// the manage view render "Browser push isn't configured for this site yet."
// We assert the public API directly here and the manage-view note in the real
// confirmed-subscriber journey below.
// ---------------------------------------------------------------------------

test.describe('push availability default (noop env → VAPID unconfigured)', () => {
  test('GET /api/push/vapid-public-key returns { publicKey: null }', async ({ page }) => {
    const res = await page.request.get('/api/push/vapid-public-key');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { publicKey: string | null };
    expect(body).toHaveProperty('publicKey');
    expect(body.publicKey).toBeNull();
  });
});

test.describe('AC-18: manage view renders source freshness truthfully', () => {
  test('fresh, overdue, and never-observed watches remain aligned with their class', async ({
    page,
  }) => {
    const token = 'freshness-contract-token';
    const freshAt = '2026-07-23T18:00:00.000Z';
    const staleAt = '2026-07-23T17:30:00.000Z';

    await page.route(`**/api/subscriptions/${token}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          email: 'freshness-e2e@berkeley.edu',
          confirmed: true,
          watches: [CLASS_KEY_999L, CLASS_KEY_COL, CLASS_KEY_TUT],
          watchFreshness: [
            {
              classKey: CLASS_KEY_999L,
              source: 'public-class-page',
              lastCheckedAt: freshAt,
              sourceStale: false,
              displayName: 'COMPSCI 999L 001 - LEC 001',
              openSeats: 3,
              enrolled: 27,
              capacity: 30,
              waitlisted: 5,
              waitlistMax: 10,
              waitlistOpen: true,
            },
            {
              classKey: CLASS_KEY_COL,
              source: 'public-class-page',
              lastCheckedAt: staleAt,
              sourceStale: true,
              displayName: 'COMPSCI 189 001 - COL 001',
              openSeats: 0,
              enrolled: 350,
              capacity: 350,
              waitlisted: 100,
              waitlistMax: 100,
              waitlistOpen: false,
            },
            {
              classKey: CLASS_KEY_TUT,
              source: 'public-class-page',
              lastCheckedAt: null,
              sourceStale: true,
              displayName: null,
              openSeats: null,
              enrolled: null,
              capacity: null,
              waitlisted: null,
              waitlistMax: null,
              waitlistOpen: null,
            },
          ],
        },
      });
    });

    await page.goto(`/?token=${token}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    const list = page.getByRole('list', { name: 'watched classes' });
    const freshItem = list.getByRole('listitem').filter({ hasText: CLASS_KEY_999L });
    const staleItem = list.getByRole('listitem').filter({ hasText: CLASS_KEY_COL });
    const unseenItem = list.getByRole('listitem').filter({ hasText: CLASS_KEY_TUT });

    await expect(freshItem.getByText('Source recently checked.')).toBeVisible();
    await expect(freshItem.locator('time')).toHaveAttribute('datetime', freshAt);
    await expect(freshItem.getByText('5 of 10')).toBeVisible();
    await expect(staleItem.getByText('Source status is stale.')).toBeVisible();
    await expect(staleItem.locator('time')).toHaveAttribute('datetime', staleAt);
    await expect(unseenItem.getByText(/waiting for the first successful check/i)).toBeVisible();
  });
});

test.describe('AC-33: the watch dashboard renders seat and waitlist counts truthfully', () => {
  test('a FULL waitlist renders as 0 open spots, never as waitlisted-of-max', async ({ page }) => {
    const token = 'dashboard-contract-token';

    await page.route(`**/api/subscriptions/${token}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          email: 'dashboard-e2e@berkeley.edu',
          confirmed: true,
          watches: [CLASS_KEY_999L, CLASS_KEY_COL],
          watchFreshness: [
            {
              // Mirrors src/scraper/fixtures/open-seats.html exactly: 3 open of
              // 350 capacity, and a waitlist of 100 queued against a max of 100
              // — i.e. FULL. `waitlisted` counts people in line, so rendering it
              // as "open" would report this full waitlist as 100 of 100 open.
              classKey: CLASS_KEY_999L,
              source: 'public-class-page',
              lastCheckedAt: '2026-07-23T18:00:00.000Z',
              sourceStale: false,
              displayName: 'COMPSCI 189 001 - LEC 001',
              openSeats: 3,
              enrolled: 347,
              capacity: 350,
              waitlisted: 100,
              waitlistMax: 100,
              waitlistOpen: false,
            },
            {
              // Never polled: every observation null. Must render dashes and
              // must not error — this is a normal new watch.
              classKey: CLASS_KEY_COL,
              source: 'public-class-page',
              lastCheckedAt: null,
              sourceStale: true,
              displayName: null,
              openSeats: null,
              enrolled: null,
              capacity: null,
              waitlisted: null,
              waitlistMax: null,
              waitlistOpen: null,
            },
          ],
        },
      });
    });

    await page.goto(`/?token=${token}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

    const list = page.getByRole('list', { name: 'watched classes' });
    const observed = list.getByRole('listitem').filter({ hasText: CLASS_KEY_999L });
    const unseen = list.getByRole('listitem').filter({ hasText: CLASS_KEY_COL });

    // The class name from the page heading is the box title.
    await expect(observed.getByText('COMPSCI 189 001 - LEC 001')).toBeVisible();
    await expect(observed.getByText('3 of 350')).toBeVisible();

    // The invariant this test exists for: waitlistMax - waitlisted, clamped.
    await expect(observed.getByText('0 of 100')).toBeVisible();
    await expect(observed.getByText('100 of 100')).toHaveCount(0);

    // Official link is DERIVED from the classKey, not stored or scraped.
    await expect(observed.getByRole('link', { name: /official berkeley page/i })).toHaveAttribute(
      'href',
      `https://classes.berkeley.edu/content/${CLASS_KEY_999L}`,
    );

    // A never-polled watch shows dashes and still renders its remove control.
    // Scope to the stat values: a bare getByText('—') also matches the freshness
    // sentence ("Source status is stale — waiting for…"), which is a different
    // em dash and would make this assertion pass or fail for the wrong reason.
    const unseenStats = unseen.locator('.watch-card__stat dd');
    await expect(unseenStats).toHaveCount(2);
    await expect(unseenStats.nth(0)).toHaveText('—');
    await expect(unseenStats.nth(1)).toHaveText('—');
    // Falls back to the class key when the page heading has not been read yet.
    await expect(unseen.getByText(CLASS_KEY_COL)).toBeVisible();
    await expect(unseen.getByRole('button', { name: /remove watch/i })).toBeVisible();

    // The cap has to be visible for the student to act on it.
    await expect(page.getByText(/using 2 of 4 slots/i)).toBeVisible();
  });

  test('waitlistOpen=false wins over the arithmetic and renders 0 open spots', async ({ page }) => {
    const token = 'waitlist-closed-token';

    // The FALSE branch of the AC-33 implication. The wire contract carries the
    // flag and counts independently, so the client must treat the alert-driving
    // flag as authoritative even when arithmetic alone would render "5 of 10".
    await page.route(`**/api/subscriptions/${token}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          email: 'waitlist-closed-e2e@berkeley.edu',
          confirmed: true,
          watches: [CLASS_KEY_999L],
          watchFreshness: [
            {
              classKey: CLASS_KEY_999L,
              source: 'public-class-page',
              lastCheckedAt: '2026-07-23T18:00:00.000Z',
              sourceStale: false,
              displayName: 'COMPSCI 10 999L - LAB 999L',
              openSeats: 0,
              enrolled: 30,
              capacity: 30,
              waitlisted: 5,
              waitlistMax: 10,
              waitlistOpen: false,
            },
          ],
        },
      });
    });

    await page.goto(`/?token=${token}`);
    const card = page
      .getByRole('list', { name: 'watched classes' })
      .getByRole('listitem')
      .filter({ hasText: CLASS_KEY_999L });

    await expect(card.getByText('0 of 10')).toBeVisible();
    await expect(card.getByText('5 of 10')).toHaveCount(0);
  });

  test('waitlistOpen=null renders a dash even when the counts would compute', async ({ page }) => {
    const token = 'waitlist-unknown-token';

    // The NULL-flag branch of the AC-33 implication. The wire schema permits this
    // defensive snapshot, and not knowing whether the waitlist is moving means
    // the client cannot honestly print a number even though 10 - 5 computes.
    await page.route(`**/api/subscriptions/${token}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          email: 'waitlist-unknown-e2e@berkeley.edu',
          confirmed: true,
          watches: [CLASS_KEY_999L],
          watchFreshness: [
            {
              classKey: CLASS_KEY_999L,
              source: 'public-class-page',
              lastCheckedAt: '2026-07-23T18:00:00.000Z',
              sourceStale: false,
              displayName: 'COMPSCI 10 999L - LAB 999L',
              openSeats: 2,
              enrolled: 28,
              capacity: 30,
              waitlisted: 5,
              waitlistMax: 10,
              waitlistOpen: null,
            },
          ],
        },
      });
    });

    await page.goto(`/?token=${token}`);
    const card = page
      .getByRole('list', { name: 'watched classes' })
      .getByRole('listitem')
      .filter({ hasText: CLASS_KEY_999L });

    // Seats still render — only the waitlist is unknown.
    await expect(card.getByText('2 of 30')).toBeVisible();
    await expect(card.getByText('5 of 10')).toHaveCount(0);
    const stats = card.locator('.watch-card__stat dd');
    await expect(stats.nth(1)).toHaveText('—');
  });

  test('waitlistOpen=true with unknown counts renders a dash', async ({ page }) => {
    const token = 'waitlist-counts-unknown-token';

    // Migration 0011 adds nullable count columns beside the pre-existing NOT
    // NULL flag, so a previously observed open waitlist can legitimately have no
    // persisted arithmetic yet. True gates a known count; it never fabricates one.
    await page.route(`**/api/subscriptions/${token}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          email: 'waitlist-counts-unknown-e2e@berkeley.edu',
          confirmed: true,
          watches: [CLASS_KEY_999L],
          watchFreshness: [
            {
              classKey: CLASS_KEY_999L,
              source: 'public-class-page',
              lastCheckedAt: '2026-07-23T18:00:00.000Z',
              sourceStale: false,
              displayName: 'COMPSCI 10 999L - LAB 999L',
              openSeats: 2,
              enrolled: 28,
              capacity: 30,
              waitlisted: null,
              waitlistMax: null,
              waitlistOpen: true,
            },
          ],
        },
      });
    });

    await page.goto(`/?token=${token}`);
    const card = page
      .getByRole('list', { name: 'watched classes' })
      .getByRole('listitem')
      .filter({ hasText: CLASS_KEY_999L });

    await expect(card.getByText('2 of 30')).toBeVisible();
    const stats = card.locator('.watch-card__stat dd');
    await expect(stats.nth(1)).toHaveText('—');
  });
});

test.describe('AC-21 / capacity: canonical backend errors produce actionable UI copy', () => {
  test('409 watch_limit_reached tells the student to remove one, not that it is a duplicate', async ({
    page,
  }) => {
    const token = 'watch-limit-contract-token';
    // THREE watches, not four, and that is the point of the test.
    //
    // The manage view gates its own add form at MAX_WATCHES_PER_SUBSCRIBER, so a
    // client that already shows four can never submit and could never reach this
    // server error — mocking four would assert against an unreachable path.
    // Three leaves the form live while the server still refuses, which is the
    // real condition the `watch_limit_reached` handler exists for: a STALE view
    // (a second tab added the fourth, or a retired watch was revived elsewhere).
    // The server stays authoritative; the client gate is only a courtesy.
    const watches = [CLASS_KEY_1, CLASS_KEY_999L, CLASS_KEY_COL];
    const unobserved = (classKey: string) => ({
      classKey,
      source: 'public-class-page',
      lastCheckedAt: null,
      sourceStale: true,
      displayName: null,
      openSeats: null,
      enrolled: null,
      capacity: null,
      waitlisted: null,
      waitlistMax: null,
      waitlistOpen: null,
    });

    await page.route(`**/api/subscriptions/${token}**`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            email: 'watch-limit-e2e@berkeley.edu',
            confirmed: true,
            watches,
            watchFreshness: watches.map(unobserved),
          },
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        json: {
          error: {
            code: 'watch_limit_reached',
            message: 'remove a watch before adding another',
          },
        },
      });
    });

    await page.goto(`/?token=${token}`);
    await page.getByLabel('Class URL or code').fill(CLASS_KEY_TUT);
    await page.getByRole('button', { name: 'Add watch' }).click();

    const alert = page.locator('#add-class-error');
    await expect(alert).toContainText(/maximum of 4 classes.+remove one/i);
    await expect(alert).not.toContainText(/already watching/i);
  });

  test('413 payload_too_large on subscribe explains how to recover', async ({ page }) => {
    await page.route('**/api/subscriptions', async (route) => {
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        json: {
          error: {
            code: 'payload_too_large',
            message: 'request body exceeds the 64 KiB limit',
          },
        },
      });
    });

    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, uniqueEmail(), CLASS_KEY_1);
    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /request is too large.+shorten the class list/i }),
    ).toBeVisible();
  });

  test('503 capacity_exceeded preserves existing-watch reassurance and Retry-After', async ({
    page,
  }) => {
    await page.route('**/api/subscriptions', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'Retry-After': '120' },
        json: {
          error: {
            code: 'capacity_exceeded',
            message: 'source monitoring capacity is full; please try again later',
          },
        },
      });
    });

    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, uniqueEmail(), CLASS_KEY_1);
    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({
          hasText:
            /reached its current public-page monitoring capacity.+in about 2 minutes.+existing watches remain active/i,
        }),
    ).toBeVisible();
  });

  test('the real API rejects an oversized body before JSON validation', async ({ request }) => {
    const response = await request.post('/api/subscriptions', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        email: uniqueEmail(),
        classKeys: ['x'.repeat(70 * 1024)],
      }),
    });

    expect(response.status()).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 'payload_too_large',
        message: 'request body exceeds the 64 KiB limit',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Accessibility (spec §6) — labels, roles, skip-link, keyboard — on the
// token-free views (subscribe, confirm landing, resend).
// ---------------------------------------------------------------------------

test.describe('accessibility — token-free views', () => {
  test('subscribe view: every control has an accessible name via getByLabel', async ({ page }) => {
    await page.goto('/');
    // getByLabel resolves only when an accessible name exists — it doubles as the
    // a11y assertion. Scoped to the subscribe <form> because the page renders two
    // "Berkeley email address" inputs (subscribe + resend).
    await expect(subscribeEmailInput(page)).toBeVisible();
    await expect(page.getByLabel('Class 1')).toBeVisible();
    await expect(subscribeForm(page).getByRole('button', { name: 'Subscribe' })).toBeVisible();
  });

  test('skip-link is present and targets the main content landmark', async ({ page }) => {
    await page.goto('/');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeAttached();
    expect(await skipLink.getAttribute('href')).toBe('#main-content');
  });

  test('keyboard-only subscribe reaches the check-your-inbox state', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/');

    await subscribeEmailInput(page).focus();
    await page.keyboard.type(email);
    await page.getByLabel('Class 1').focus();
    await page.keyboard.type(CLASS_KEY_1);
    await page.getByRole('button', { name: 'Subscribe' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();
  });

  test('confirm landing view: the gesture is a real, labelled <button>', async ({ page }) => {
    await page.goto('/?confirm=any-token');
    const button = page.getByRole('button', { name: 'Confirm my email' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('resend form on the subscribe page has a labelled email input', async ({ page }) => {
    await page.goto('/');
    const form = page.getByRole('region', { name: /already subscribed\? lost your link\?/i });
    await expect(form.getByLabel('Berkeley email address')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Email me my link' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Guard: the OLD double-opt-in-violating surface must be GONE everywhere.
// A regression that leaks a token into the subscribe response or page would
// re-introduce the account-takeover / scanner-confirm risks the design
// closed (FR-9 / §4 / AC-2b).
// ---------------------------------------------------------------------------

test.describe('regression guard: no token ever leaks into the subscribe surface', () => {
  test('the subscribe success state never renders a manage/confirm link', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();

    // No anchor on the page carries a token/confirm query param.
    const anchors = await page
      .locator('a')
      .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''));
    for (const href of anchors) {
      expect(href).not.toMatch(TOKEN_LOOKING);
    }

    // The old "You are subscribed" heading must not exist anywhere.
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toHaveCount(0);
  });
});

// ===========================================================================
// TOKEN-GATED JOURNEYS (noop outbox sink) — the confirm→manage tail and the
// flows behind it. Each block owns its subscriber; the outbox helper extracts
// the emailed confirm/manage link (see the file header + e2e/outbox.ts).
// ===========================================================================

// ---------------------------------------------------------------------------
// AC-1 (tail) / AC-10 / push-toggle / AC-11 (upgrade) [FR-2, FR-9, FR-15, FR-10]
//
// One SHARED subscriber, exercised serially: subscribe + confirm (AC-1 tail),
// re-confirm the same link (AC-10 idempotent), inspect the push toggle in manage,
// then resend-while-Confirmed and follow the manage link (AC-11 upgrade). Serial
// because every test reuses the same confirmed subscriber. Per-email budget: 1
// subscribe (test 1) + 1 resend (test 4) = 2, under the 3/900s window.
// ---------------------------------------------------------------------------

test.describe
  .serial('AC-1 tail + AC-10 + push toggle + AC-11 upgrade (confirmed subscriber)', () => {
  let email: string;
  let confirmUrl: string;
  let confirmToken: string;

  test('AC-1 (tail): confirming the emailed link lands in manage with the watched class', async ({
    page,
  }) => {
    email = uniqueEmail();
    const match = await subscribeAndReadConfirmLink(page, email, CLASS_KEY_1);
    // Persist the emailed link + token for the sibling serial tests below.
    confirmUrl = match.url;
    confirmToken = match.token;

    // The confirmation entry is addressed to this subscriber and carries the link.
    expect(match.entry.kind).toBe('confirmation');
    expect(match.entry.to).toBe(email);
    // The extracted URL points at the test server (APP_BASE_URL) confirm route.
    expect(confirmUrl).toContain('/?confirm=');

    // Perform the explicit confirm gesture → pivots to the manage view (AC-1 tail).
    await visitAndClickConfirm(page, confirmUrl);

    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    // Manage shows the confirmed subscriber's address and the watch it created.
    await expect(page.getByText(email)).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'watched classes' }).getByText(CLASS_KEY_1),
    ).toBeVisible();
    // Confirmed: the pending banner must NOT be present.
    await expect(page.getByText('Confirm your email to start receiving alerts.')).toHaveCount(0);
  });

  test('AC-10: revisiting the same confirm link still lands in manage (idempotent, no error)', async ({
    page,
  }) => {
    // The subscriber is already Confirmed; re-confirming is a 200 no-op that still
    // pivots to manage — never an error screen.
    await visitAndClickConfirm(page, confirmUrl);

    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Unable to confirm' })).toHaveCount(0);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('push toggle (VAPID unset): manage shows the not-configured note and no enable button', async ({
    page,
  }) => {
    // Land directly in manage for the confirmed subscriber via the same token.
    await page.goto(`/?token=${encodeURIComponent(confirmToken)}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

    // The push section renders (Confirmed subscriber); with VAPID unset it shows
    // the not-configured note and offers NO enable/disable control (FR-15).
    await expect(page.getByRole('heading', { name: 'Browser push alerts' })).toBeVisible();
    await expect(page.getByText(/browser push isn.t configured for this site yet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /enable push/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /turn off push/i })).toHaveCount(0);
  });

  test('manage can add and remove a widened class key without disturbing existing watches', async ({
    page,
  }) => {
    await page.goto(`/?token=${encodeURIComponent(confirmToken)}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

    await page.getByLabel('Class URL or code').fill('2026 Fall MATH 1A 001 TUT 001');
    await page.getByRole('button', { name: 'Add watch' }).click();

    const list = page.getByRole('list', { name: 'watched classes' });
    await expect(list.getByText(CLASS_KEY_1)).toBeVisible();
    await expect(list.getByText(CLASS_KEY_TUT)).toBeVisible();
    await expect(
      list
        .getByRole('listitem')
        .filter({ hasText: CLASS_KEY_TUT })
        .getByText(/waiting for the first successful check/i),
    ).toBeVisible();

    await page.getByRole('button', { name: `Remove watch for ${CLASS_KEY_TUT}` }).click();
    await expect(list.getByText(CLASS_KEY_TUT)).toHaveCount(0);
    await expect(list.getByText(CLASS_KEY_1)).toBeVisible();
  });

  test('AC-11 (upgrade): resend for a Confirmed subscriber emits a manage link that loads manage', async ({
    page,
  }) => {
    // Resend for the now-Confirmed address → the notifier sends a MANAGE-LINK
    // (kind 'manage-link', ?token=), not a confirmation.
    await page.goto('/');
    await submitSubscribePageResend(page, email);

    const match = await pollOutboxFor(email, 'manage-link');
    expect(match.entry.kind).toBe('manage-link');
    expect(match.entry.to).toBe(email);
    expect(match.url).toContain('/?token=');

    // Following the emailed manage link loads the manage view for this subscriber.
    await page.goto(match.url);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'watched classes' }).getByText(CLASS_KEY_1),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Pending banner [FR-9]: a `?token=` visit BEFORE confirming shows the "confirm
// your email" banner (GET returns confirmed:false); after confirming, it's gone.
// One subscribe request; a dedicated subscriber.
// ---------------------------------------------------------------------------

test.describe('pending banner shows before confirm and clears after', () => {
  const BANNER = 'Confirm your email to start receiving alerts.';

  test('?token= before confirm shows the pending banner; confirming removes it', async ({
    page,
  }) => {
    const email = uniqueEmail();
    const { token } = await subscribeAndReadConfirmLink(page, email, CLASS_KEY_1);

    // BEFORE confirming: the same token opens manage in the Pending state.
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    await expect(page.getByText(BANNER)).toBeVisible();

    // Confirm via the explicit gesture, then land back in manage.
    await visitAndClickConfirm(page, `/?confirm=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

    // AFTER confirming: the banner is gone (confirmed:true).
    await expect(page.getByText(BANNER)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7 [FR-2, FR-4]: unsubscribe via manage removes the subscriber; afterwards
// the manage link 404s ("Unable to load subscription") and the confirm link
// errors ("Unable to confirm") — the token is still well-signed but the
// subscriber is gone. One subscribe request; a dedicated subscriber.
// ---------------------------------------------------------------------------

test.describe('AC-7: unsubscribe via manage, then both links error safely', () => {
  test('unsubscribe → manage link 404s and confirm link errors', async ({ page }) => {
    const email = uniqueEmail();
    const { url: confirmUrl, token } = await subscribeAndReadConfirmLink(page, email, CLASS_KEY_1);

    // Confirm, then land in manage.
    await visitAndClickConfirm(page, confirmUrl);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

    // Unsubscribe: reveal the confirm dialog, then commit.
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByText('Are you sure? This cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, unsubscribe' }).click();
    await expect(page.getByRole('heading', { name: 'Unsubscribed' })).toBeVisible();

    // Revisiting the manage link now hits a deleted subscriber → safe error state.
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Unable to load subscription' })).toBeVisible();
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /no longer exists|expired or is invalid/i }),
    ).toBeVisible();

    // A fresh visit to the old confirm link + gesture now errors too (404 → safe).
    await visitAndClickConfirm(page, confirmUrl);
    await expect(page.getByRole('heading', { name: 'Unable to confirm' })).toBeVisible();
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /no longer exists|expired or is invalid/i }),
    ).toBeVisible();
  });
});
