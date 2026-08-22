/**
 * Service-worker push copy (FR-15, FR-27).
 *
 * `public/sw.js` had NO coverage at all, and it is one of the two channels that
 * actually reaches a Subscriber. Before FR-27 it appended "some open seats are
 * reserved" to EVERY seats-open alert, which understates a fully-reserved opening
 * (41 of 41, observed live on 2026-08-21) and asserts a reservation that does not
 * exist when the page reported zero.
 *
 * The worker is a classic script, not a module: it declares helpers at top level and
 * registers listeners on `self`. We evaluate it in a `vm` sandbox with a stub `self`
 * and pull the two helpers out, so the copy is tested exactly as shipped — no
 * refactor, no duplicated logic to drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface AlertPayload {
  classKey: string;
  reason: string;
  openSeats: number;
  openReserved: number | null;
}
interface Rendered {
  title: string;
  body: string;
}
type Helpers = {
  parseAlertPayload(event: { data?: { json(): unknown } }): AlertPayload | null;
  renderNotification(payload: AlertPayload): Rendered;
};

function loadServiceWorker(): Helpers {
  const source = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: () => undefined, clients: {}, registration: {} },
    caches: undefined,
    console,
  };
  const context = createContext(sandbox);
  // Append an export hook rather than editing the shipped file.
  runInContext(
    `${source}\n;globalThis.__helpers = { parseAlertPayload, renderNotification };`,
    context,
  );
  return (sandbox as { __helpers: Helpers }).__helpers;
}

const { parseAlertPayload, renderNotification } = loadServiceWorker();

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001';

function render(openSeats: number, openReserved: number | null | undefined): string {
  const parsed = parseAlertPayload({
    data: {
      json: () => ({
        kind: 'alert',
        classKey: CLASS_KEY,
        reason: 'seats-open',
        openSeats,
        openedAt: '2026-08-21T22:19:15.592Z',
        ...(openReserved === undefined ? {} : { openReserved }),
      }),
    },
  });
  expect(parsed).not.toBeNull();
  return renderNotification(parsed as AlertPayload).body;
}

describe('service worker push copy — reserved seats', () => {
  it('warns that ALL seats are reserved when reserved covers open', () => {
    const body = render(41, 41);
    expect(body).toContain('ALL 41 are RESERVED');
    expect(body).toContain('you may not be able to take them');
  });

  it('names the split when only some are reserved', () => {
    const body = render(10, 3);
    expect(body).toContain('3 of those are reserved');
    expect(body).not.toContain('ALL');
  });

  it('says nothing about reservations on an OBSERVED zero', () => {
    const body = render(5, 0);
    expect(body).not.toMatch(/reserved/i);
    expect(body).toContain('5 open seats');
  });

  it('hedges only when the count is unknown', () => {
    const body = render(5, null);
    expect(body).toContain('may be reserved');
  });

  it('treats an absent field as unknown, not as zero', () => {
    const body = render(5, undefined);
    expect(body).toContain('may be reserved');
  });

  it('degrades a non-subset reserved count to unknown rather than trusting it', () => {
    // The payload arrives over the network. 3 reserved of 2 open is impossible, so
    // the worker must not render "ALL 2 are RESERVED" off a malformed push.
    const body = render(2, 3);
    expect(body).toContain('may be reserved');
    expect(body).not.toContain('ALL');
  });

  it('never leaks a token, email, or link into the notification body', () => {
    const parsed = parseAlertPayload({
      data: {
        json: () => ({
          kind: 'alert',
          classKey: CLASS_KEY,
          reason: 'seats-open',
          openSeats: 41,
          openReserved: 41,
          openedAt: '2026-08-21T22:19:15.592Z',
          token: 'signed.manage.token',
          email: 'student@berkeley.edu',
          url: 'https://example.com/manage?token=secret',
        }),
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('token');
    expect(parsed).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('url');

    const body = renderNotification(parsed as AlertPayload).body;
    expect(body).not.toMatch(/token|@|https?:\/\//i);
  });
});
