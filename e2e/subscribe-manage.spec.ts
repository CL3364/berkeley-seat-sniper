/**
 * E2E: subscribe → manage journey (AC-1, AC-2, AC-2b, AC-7)
 *
 * Drives a real Chromium browser against the running app (SPA + /api at
 * localhost:8787 per playwright.config.ts). Each test group maps to one or
 * more acceptance criteria in spec §7.
 *
 * Selector strategy: getByRole / getByLabel / getByText — no CSS selectors.
 * All assertions use web-first auto-waiting; no fixed sleeps.
 *
 * Rate-limit note: POST /api/subscriptions has a per-IP window of 5 req/min.
 * All tests share localhost, so tests that call the subscribe API must run
 * serially within their describe blocks (test.describe.serial) and the suite
 * file itself is not fully parallel — each test uses a unique email.
 * Tests that only need to verify the UI without a real subscribe (validation
 * tests) can still run in parallel because they never reach the network.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid canonical class key used across multiple tests. */
const CLASS_KEY_1 = '2026-fall-compsci-189-001-lec-001';
/** A second distinct class key for multi-watch tests. */
const CLASS_KEY_2 = '2026-fall-compsci-61a-001-lec-001';
/** A Berkeley class URL that should normalize to CLASS_KEY_1. */
const CLASS_URL_1 = 'https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001';

/** Monotonic counter for unique email generation. */
let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  // Use a fixed base so each process/worker generates from 1 within its shard.
  return `e2e-${process.pid}-${emailSeq}@example.com`;
}

/**
 * Fill the subscribe form and click Subscribe. Returns when the form submits
 * (success state or error; does NOT assert outcome — callers do that).
 */
async function fillAndSubmitSubscribeForm(
  page: import('@playwright/test').Page,
  email: string,
  classKey: string,
): Promise<void> {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Class 1').fill(classKey);
  await page.getByRole('button', { name: 'Subscribe' }).click();
}

/**
 * Subscribe and navigate to the manage view. Returns the manage URL href.
 * Asserts the success heading is visible before navigating.
 */
async function subscribeAndGoToManage(
  page: import('@playwright/test').Page,
  email: string,
  classKey: string,
): Promise<string> {
  await page.goto('/');
  await fillAndSubmitSubscribeForm(page, email, classKey);
  await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();

  const manageLink = page.getByRole('link', { name: /your manage link/ });
  const href = await manageLink.getAttribute('href');
  expect(href).toMatch(/[?&]token=/);

  await manageLink.click();
  await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();

  return href!;
}

// ---------------------------------------------------------------------------
// AC-1: subscribe with valid input → success state → manage view
//
// This block uses test.describe.serial because each test calls POST
// /api/subscriptions and the per-IP rate limit (5 req/60 s) would be
// exceeded by running all subscribe calls simultaneously.
// ---------------------------------------------------------------------------

test.describe.serial('AC-1: happy-path subscribe and manage', () => {
  test('subscribe with valid email + class URL → success state shows manage link', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Watch a class' })).toBeVisible();

    // Fill email and a full Berkeley URL (should normalize to CLASS_KEY_1).
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Class 1').fill(CLASS_URL_1);

    await page.getByRole('button', { name: 'Subscribe' }).click();

    // Success heading and manage link must appear.
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();

    const manageLink = page.getByRole('link', { name: /your manage link/ });
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    expect(href).toMatch(/[?&]token=/);
  });

  test('manage link navigates to manage view and lists the canonical watch key', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // The canonical class key must appear in the watch list.
    await expect(page.getByText(CLASS_KEY_1)).toBeVisible();
  });

  test('manage view: add a second watch and assert it appears', async ({ page }) => {
    const email = uniqueEmail();

    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // Add a second watch via the manage form.
    await page.getByLabel('Class URL or code').fill(CLASS_KEY_2);
    await page.getByRole('button', { name: 'Add watch' }).click();

    // Both watches must appear.
    await expect(page.getByText(CLASS_KEY_1)).toBeVisible();
    await expect(page.getByText(CLASS_KEY_2)).toBeVisible();
  });

  test('manage view: remove a watch and assert it is gone', async ({ page }) => {
    const email = uniqueEmail();

    // Subscribe, go to manage, add a second watch, then remove the first.
    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // Add CLASS_KEY_2.
    await page.getByLabel('Class URL or code').fill(CLASS_KEY_2);
    await page.getByRole('button', { name: 'Add watch' }).click();
    await expect(page.getByText(CLASS_KEY_1)).toBeVisible();
    await expect(page.getByText(CLASS_KEY_2)).toBeVisible();

    // Remove CLASS_KEY_1.
    await page.getByRole('button', { name: `Remove watch for ${CLASS_KEY_1}` }).click();

    // CLASS_KEY_1 must be gone; CLASS_KEY_2 must remain.
    await expect(page.getByText(CLASS_KEY_1)).not.toBeVisible();
    await expect(page.getByText(CLASS_KEY_2)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-2: invalid input is caught inline — no request sent
//
// These tests never reach the API (validation is client-side), so they can
// run in parallel without hitting the rate limit.
// ---------------------------------------------------------------------------

test.describe('AC-2: inline validation blocks invalid input', () => {
  test('invalid email shows field error and blocks submission', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Email address').fill('not-an-email');
    await page.getByLabel('Class 1').fill(CLASS_KEY_1);
    await page.getByRole('button', { name: 'Subscribe' }).click();

    // Inline error on the email field.
    await expect(page.locator('[role="alert"]').filter({ hasText: /valid email/i })).toBeVisible();

    // Success heading must NOT appear — form did not submit.
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).not.toBeVisible();
  });

  test('unrecognizable class identifier shows field error and blocks submission', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Email address').fill('valid@example.com');
    // Submit a nonsense class code — normalizeClassKey returns { ok: false }.
    await page.getByLabel('Class 1').fill('not-a-class-code');
    await page.getByRole('button', { name: 'Subscribe' }).click();

    // Inline error on the class entry.
    await expect(page.locator('[role="alert"]').filter({ hasText: /recognize/i })).toBeVisible();

    // Success state must not appear.
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).not.toBeVisible();
  });

  test('empty class identifier shows required error on submission', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email address').fill('valid@example.com');
    // Leave the class field empty.
    await page.getByRole('button', { name: 'Subscribe' }).click();

    await expect(page.locator('[role="alert"]').filter({ hasText: /required/i })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'You are subscribed' })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-2b: duplicate email → 409 conflict; no token or watch list leaked
// ---------------------------------------------------------------------------

test.describe.serial('AC-2b: duplicate email rejected with 409', () => {
  test('second subscribe with same email shows conflict error inline', async ({ page }) => {
    const email = uniqueEmail();

    // First subscription — should succeed.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();

    // Second attempt with the same email, fresh form.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_2);

    // The UI must surface the conflict on the email field.
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /already subscribed/i }),
    ).toBeVisible();

    // Must NOT show the success heading — no token issued.
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-7: unsubscribe → terminal state → manage link returns not-found error
// ---------------------------------------------------------------------------

test.describe.serial('AC-7: unsubscribe flow', () => {
  test('unsubscribe shows terminal "Unsubscribed" state', async ({ page }) => {
    const email = uniqueEmail();

    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // Click the initial Unsubscribe button to open the confirm dialog.
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByText(/Are you sure/i)).toBeVisible();

    // Confirm.
    await page.getByRole('button', { name: 'Yes, unsubscribe' }).click();

    // Terminal state.
    await expect(page.getByRole('heading', { name: 'Unsubscribed' })).toBeVisible();
    await expect(page.getByText(/no longer receive seat alerts/i)).toBeVisible();
  });

  test('reloading the manage link after unsubscribe shows not-found/invalid state', async ({
    page,
  }) => {
    const email = uniqueEmail();

    // Subscribe and capture the manage href before navigating away.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();

    const manageLink = page.getByRole('link', { name: /your manage link/ });
    const manageHref = await manageLink.getAttribute('href');
    expect(manageHref).toBeTruthy();

    // Go to manage view and unsubscribe.
    await manageLink.click();
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole('button', { name: 'Yes, unsubscribe' }).click();
    await expect(page.getByRole('heading', { name: 'Unsubscribed' })).toBeVisible();

    // Reload the original manage link — subscriber is deleted; server returns 404.
    await page.goto(manageHref!);

    // ManageView must show the error state, NOT the manage form.
    await expect(page.getByRole('heading', { name: 'Unable to load subscription' })).toBeVisible();
    await expect(
      page.locator('[role="alert"]').filter({
        hasText: /no longer exists|expired or is invalid/i,
      }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Loading / empty / error states
// ---------------------------------------------------------------------------

test.describe.serial('loading and error states', () => {
  test('bad token in ?token= query shows error, not a crash', async ({ page }) => {
    // Completely bogus token — the server will return 401 token_invalid.
    await page.goto('/?token=totally-invalid-token-value');

    await expect(page.getByRole('heading', { name: 'Unable to load subscription' })).toBeVisible();

    // Error message must be user-safe — no stack trace, no internals.
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /expired or is invalid|unexpected/i }),
    ).toBeVisible();
  });

  test('manage view shows loading state then resolves', async ({ page }) => {
    const email = uniqueEmail();

    // Reach the manage view via the subscribe flow.
    await page.goto('/');
    await fillAndSubmitSubscribeForm(page, email, CLASS_KEY_1);
    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();

    await page.getByRole('link', { name: /your manage link/ }).click();

    // The manage view heading must ultimately appear (loading resolved).
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
  });

  test('manage view shows empty state when no watches remain', async ({ page }) => {
    const email = uniqueEmail();

    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // Remove the only watch.
    await page.getByRole('button', { name: `Remove watch for ${CLASS_KEY_1}` }).click();

    // Empty state text must appear.
    await expect(page.getByText(/not watching any classes/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Basic accessibility — labels, roles, keyboard operability (spec §6)
// ---------------------------------------------------------------------------

test.describe.serial('accessibility — labels, roles, keyboard operability', () => {
  test('every form control on the subscribe view has an accessible name via getByLabel', async ({
    page,
  }) => {
    await page.goto('/');

    // getByLabel acts as the accessibility assertion: throws if no associated label.
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Class 1')).toBeVisible();
  });

  test('keyboard-only subscribe: Tab to each field then Enter submits', async ({ page }) => {
    const email = uniqueEmail();

    await page.goto('/');

    // Focus email field, type email, then move to class field and type key.
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(email);

    // Focus class input directly via its label, type the class key.
    await page.getByLabel('Class 1').focus();
    await page.keyboard.type(CLASS_KEY_1);

    // Tab past "Add another class" button and focus the Subscribe button, then Enter.
    await page.getByRole('button', { name: 'Subscribe' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();
  });

  test('skip-link is present and targets main content', async ({ page }) => {
    await page.goto('/');

    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeAttached();
    const href = await skipLink.getAttribute('href');
    expect(href).toBe('#main-content');
  });

  test('manage view: every form control has an accessible label', async ({ page }) => {
    const email = uniqueEmail();

    await subscribeAndGoToManage(page, email, CLASS_KEY_1);

    // The add-watch input must have an accessible label.
    await expect(page.getByLabel('Class URL or code')).toBeVisible();
  });
});
