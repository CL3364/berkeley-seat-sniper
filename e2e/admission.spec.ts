/**
 * AC-25 browser admission coverage.
 *
 * These tests intercept the API boundary so one Playwright web server can keep
 * the legacy journeys in explicit public mode while this file exercises the
 * pilot invite's browser-only privacy lifecycle and canonical admission error.
 * The generated fixture value exists only for one test and is never a
 * production credential.
 */

import { expect, test as base } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001';
const INVITE_HEADER = 'x-seat-sniper-invite-code';

interface AdmissionFixtures {
  pilotInviteCode: string;
}

const test = base.extend<AdmissionFixtures>({
  pilotInviteCode: async ({ browserName }, use, testInfo) => {
    const testLabel = `${browserName}_${testInfo.workerIndex}_${testInfo.repeatEachIndex}`;
    const code = `e2e_${testLabel}_${'fixture'.repeat(6)}`.slice(0, 48);
    await use(code);
  },
});

interface CapturedApiRequest {
  method: string;
  pathname: string;
  inviteHeader: string | undefined;
  body: string | null;
}

function subscribeForm(page: Page) {
  return page
    .getByRole('region', { name: /watch a class/i })
    .locator('form')
    .first();
}

async function submitCreate(page: Page, email: string): Promise<void> {
  await subscribeForm(page).getByLabel('Berkeley email address').fill(email);
  await page.getByLabel('Class 1').fill(CLASS_KEY);
  await subscribeForm(page).getByRole('button', { name: 'Subscribe' }).click();
}

async function submitResend(page: Page, email: string): Promise<void> {
  const form = page.getByRole('region', {
    name: /already subscribed\? lost your link\?/i,
  });
  await form.getByLabel('Berkeley email address').fill(email);
  await form.getByRole('button', { name: 'Email me my link' }).click();
  await expect(
    form.getByText("If that address is subscribed, we've emailed its link. Check your inbox."),
  ).toBeVisible();
}

async function sessionValues(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.values(window.sessionStorage));
}

async function localValues(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.values(window.localStorage));
}

async function expectInviteOutsidePersistentSurfaces(page: Page, code: string): Promise<void> {
  expect(page.url()).not.toContain(code);
  expect(await page.content()).not.toContain(code);
  expect(await localValues(page)).not.toContain(code);

  const cookies = await page.context().cookies();
  for (const cookie of cookies) {
    expect(cookie.name).not.toContain(code);
    expect(cookie.value).not.toContain(code);
  }
}

function capture(request: Request): CapturedApiRequest {
  return {
    method: request.method(),
    pathname: new URL(request.url()).pathname,
    inviteHeader: request.headers()[INVITE_HEADER],
    body: request.postData(),
  };
}

test.describe('AC-25: pilot invite browser privacy boundary', () => {
  test('strips the URL before render, sends the bearer only on create, and clears it after exact 202', async ({
    page,
    pilotInviteCode,
  }) => {
    const captured: CapturedApiRequest[] = [];
    const manageToken = 'pilot-e2e-manage-token';

    await page.addInitScript(() => {
      const toBase64Url = (bytes: Uint8Array): string => {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      const publicKey = new Uint8Array(65);
      publicKey[0] = 0x04;
      publicKey.fill(0x01, 1);
      const authSecret = new Uint8Array(16);
      authSecret.fill(0x02);
      const pushSubscription = {
        endpoint: 'https://push.example.com/subscriptions/browser-fixture',
        toJSON: () => ({
          endpoint: 'https://push.example.com/subscriptions/browser-fixture',
          keys: {
            p256dh: toBase64Url(publicKey),
            auth: toBase64Url(authSecret),
          },
        }),
      };
      const registration = {
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => pushSubscription,
        },
      };

      Object.defineProperty(window, 'PushManager', {
        configurable: true,
        value: class PushManager {},
      });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { requestPermission: async () => 'granted' },
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistration: async () => null,
          register: async () => registration,
          ready: Promise.resolve(registration),
        },
      });
    });

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const item = capture(request);
      captured.push(item);

      if (item.pathname === '/api/subscriptions/resend' && item.method === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          json: { status: 'sent' },
        });
        return;
      }

      if (item.pathname === `/api/subscriptions/${manageToken}` && item.method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            email: 'pilot-browser@berkeley.edu',
            confirmed: true,
            watches: [CLASS_KEY],
            watchFreshness: [
              {
                classKey: CLASS_KEY,
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
        return;
      }

      if (item.pathname === '/api/push/vapid-public-key' && item.method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: { publicKey: 'AQAB' },
        });
        return;
      }

      if (item.pathname === `/api/subscriptions/${manageToken}/push` && item.method === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          json: { status: 'enabled' },
        });
        return;
      }

      if (item.pathname === '/api/subscriptions' && item.method === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          json: { status: 'pending' },
        });
        return;
      }

      await route.abort('failed');
    });

    const rawUrl = `/?keep=a%20b&invite=${encodeURIComponent(pilotInviteCode)}&keep=two#status`;
    await page.goto(rawUrl, { waitUntil: 'domcontentloaded' });

    expect(page.url()).toBe('http://127.0.0.1:5173/?keep=a%20b&keep=two#status');
    await expect(page.getByRole('heading', { name: 'Watch a class' })).toBeVisible();
    expect(await sessionValues(page)).toContain(pilotInviteCode);
    await expectInviteOutsidePersistentSurfaces(page, pilotInviteCode);

    await submitResend(page, 'pilot-resend@berkeley.edu');

    await page.goto(`/?token=${manageToken}`);
    await expect(page.getByRole('heading', { name: 'Manage your subscription' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable push on this browser' })).toBeVisible();
    await page.getByRole('button', { name: 'Enable push on this browser' }).click();
    await expect(page.getByText(/push alerts are on for this browser/i)).toBeVisible();
    expect(await sessionValues(page)).toContain(pilotInviteCode);

    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/subscriptions',
    );
    await page.goto('/');
    await submitCreate(page, 'pilot-create@berkeley.edu');
    expect((await createResponse).status()).toBe(202);
    await expect(page.getByRole('heading', { name: 'Check your inbox to confirm' })).toBeVisible();

    const create = captured.find(
      (request) => request.method === 'POST' && request.pathname === '/api/subscriptions',
    );
    expect(create).toBeDefined();
    expect(create?.inviteHeader).toBe(pilotInviteCode);
    expect(create?.body).not.toContain(pilotInviteCode);

    const expectedHeaderFreeRequests = [
      ['POST', '/api/subscriptions/resend'],
      ['GET', `/api/subscriptions/${manageToken}`],
      ['GET', '/api/push/vapid-public-key'],
      ['POST', `/api/subscriptions/${manageToken}/push`],
    ] as const;
    for (const [method, pathname] of expectedHeaderFreeRequests) {
      const request = captured.find(
        (candidate) => candidate.method === method && candidate.pathname === pathname,
      );
      expect(request, `${method} ${pathname} should have reached the API`).toBeDefined();
      expect(request?.inviteHeader).toBeUndefined();
    }

    const requestsWithInvite = captured.filter(
      (request) => request.inviteHeader === pilotInviteCode,
    );
    expect(requestsWithInvite).toEqual([create]);
    for (const request of captured) {
      if (request !== create) {
        expect(request.inviteHeader).toBeUndefined();
      }
      expect(request.body ?? '').not.toContain(pilotInviteCode);
    }

    expect(await sessionValues(page)).not.toContain(pilotInviteCode);
    await expectInviteOutsidePersistentSurfaces(page, pilotInviteCode);
  });

  test('invalid and duplicate invite parameters are stripped and clear tab-scoped state', async ({
    page,
    pilotInviteCode,
  }) => {
    await page.goto(`/?invite=${encodeURIComponent(pilotInviteCode)}`);
    expect(await sessionValues(page)).toContain(pilotInviteCode);

    await page.goto('/?keep=one&invite=too-short&keep=two#invalid', {
      waitUntil: 'domcontentloaded',
    });
    expect(page.url()).toBe('http://127.0.0.1:5173/?keep=one&keep=two#invalid');
    expect(await sessionValues(page)).not.toContain(pilotInviteCode);
    expect(await sessionValues(page)).not.toContain('too-short');

    await page.goto(`/?invite=${encodeURIComponent(pilotInviteCode)}`);
    expect(await sessionValues(page)).toContain(pilotInviteCode);

    const secondCode = `${pilotInviteCode.slice(0, -1)}z`;
    await page.goto(
      `/?keep=a%20b&invite=${encodeURIComponent(pilotInviteCode)}&invite=${encodeURIComponent(secondCode)}&keep=two#duplicate`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(page.url()).toBe('http://127.0.0.1:5173/?keep=a%20b&keep=two#duplicate');
    expect(await sessionValues(page)).not.toContain(pilotInviteCode);
    expect(await sessionValues(page)).not.toContain(secondCode);
    await expectInviteOutsidePersistentSurfaces(page, pilotInviteCode);
    await expectInviteOutsidePersistentSurfaces(page, secondCode);
  });

  test('canonical admission denial shows generic Retry-After copy and retains the bearer', async ({
    page,
    pilotInviteCode,
  }) => {
    let createRequest: CapturedApiRequest | undefined;
    await page.route('**/api/subscriptions', async (route) => {
      createRequest = capture(route.request());
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'Retry-After': '3600' },
        json: {
          error: {
            code: 'admission_unavailable',
            message: 'new subscriptions are not currently available',
          },
        },
      });
    });

    await page.goto(`/?invite=${encodeURIComponent(pilotInviteCode)}`);
    await submitCreate(page, 'pilot-denied@berkeley.edu');

    const alert = subscribeForm(page).locator('[role="alert"]');
    await expect(alert).toHaveText(
      'New subscriptions are not currently available. Try again in about 1 hour.',
    );
    expect((await alert.textContent()) ?? '').not.toMatch(/closed|pilot|invite|code|full/i);
    expect(createRequest?.inviteHeader).toBe(pilotInviteCode);
    expect(createRequest?.body).not.toContain(pilotInviteCode);
    expect(await sessionValues(page)).toContain(pilotInviteCode);
    await expectInviteOutsidePersistentSurfaces(page, pilotInviteCode);
  });

  test('an unexpected non-202 success acknowledgement retains the bearer for retry', async ({
    page,
    pilotInviteCode,
  }) => {
    await page.route('**/api/subscriptions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { status: 'pending' },
      });
    });

    await page.goto(`/?invite=${encodeURIComponent(pilotInviteCode)}`);
    await submitCreate(page, 'pilot-unexpected-status@berkeley.edu');

    await expect(
      subscribeForm(page)
        .locator('[role="alert"]')
        .filter({ hasText: /unexpected success status/i }),
    ).toBeVisible();
    expect(await sessionValues(page)).toContain(pilotInviteCode);
    await expectInviteOutsidePersistentSurfaces(page, pilotInviteCode);
  });
});
