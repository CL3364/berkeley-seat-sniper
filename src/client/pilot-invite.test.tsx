// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSubscription, resendManageLink } from './api';
import {
  capturePilotInviteFromUrl,
  pilotInviteCreateHeaders,
  readStoredPilotInvite,
  type SessionStorageLike,
} from './pilot-invite';
import { PILOT_INVITE_CODE_HEADER } from '../shared/api';
import { SubscribeView } from '../components/SubscribeView';

const VALID_INVITE = 'A'.repeat(32);
const CLASS_KEY = '2026-fall-compsci-189-001-lec-001';

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function loadInviteUrl(code = VALID_INVITE, suffix = ''): void {
  window.history.replaceState(null, '', `/?invite=${encodeURIComponent(code)}${suffix}`);
  capturePilotInviteFromUrl();
}

describe('pilot invite URL capture', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips invite before session storage and preserves other query values, encoding, hash, and state', () => {
    const state = { route: 'keep-me' };
    const events: string[] = [];
    const values = new Map<string, string>();
    const storage: SessionStorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        events.push('store');
        values.set(key, value);
      },
      removeItem: (key) => {
        events.push('remove');
        values.delete(key);
      },
    };
    const history = {
      state,
      replaceState(receivedState: unknown, _unused: string, url?: string | URL | null) {
        expect(receivedState).toBe(state);
        expect(url).toBe('/manage?keep=a%20b&keep=two#status');
        events.push('strip');
      },
    };

    capturePilotInviteFromUrl(
      {
        href: `https://seat-sniper.example/manage?keep=a%20b&invite=${VALID_INVITE}&keep=two#status`,
      },
      history,
      storage,
    );

    expect(events).toEqual(['strip', 'store']);
    expect(readStoredPilotInvite(storage)).toBe(VALID_INVITE);
  });

  it('removes invalid and duplicate invite inputs without persisting them anywhere', () => {
    window.sessionStorage.setItem('seat-sniper:pilot-invite-code', VALID_INVITE);
    window.history.replaceState(
      { preserved: true },
      '',
      '/?page=1&invite=too-short&invite=also-invalid#help',
    );

    capturePilotInviteFromUrl();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/?page=1#help',
    );
    expect(window.history.state).toEqual({ preserved: true });
    expect(readStoredPilotInvite()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('keeps a valid session invite across a reload URL that has no invite parameter', () => {
    loadInviteUrl();
    expect(window.location.search).toBe('');

    window.history.replaceState(null, '', '/?token=manage-token#watch');
    capturePilotInviteFromUrl();

    expect(window.location.search).toBe('?token=manage-token');
    expect(window.location.hash).toBe('#watch');
    expect(readStoredPilotInvite()).toBe(VALID_INVITE);
  });

  it('revalidates altered session values before creating a header', () => {
    window.sessionStorage.setItem('seat-sniper:pilot-invite-code', 'not valid');

    expect(pilotInviteCreateHeaders()).toEqual({});
    expect(readStoredPilotInvite()).toBeNull();
  });
});

describe('pilot invite request lifecycle', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer only on create, never in JSON, and clears it only after 202', async () => {
    loadInviteUrl();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: 'sent' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'pending' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await resendManageLink('student@berkeley.edu');
    expect(readStoredPilotInvite()).toBe(VALID_INVITE);

    await createSubscription({
      email: 'student@berkeley.edu',
      classKeys: [CLASS_KEY],
    });

    const resendInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(resendInit?.headers).has(PILOT_INVITE_CODE_HEADER)).toBe(false);

    const createInit = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(createInit?.headers).get(PILOT_INVITE_CODE_HEADER)).toBe(VALID_INVITE);
    expect(String(createInit?.body)).not.toContain(VALID_INVITE);
    expect(window.location.href).not.toContain(VALID_INVITE);
    expect(window.localStorage.length).toBe(0);
    expect(readStoredPilotInvite()).toBeNull();
  });

  it('retains the bearer after admission denial and surfaces only generic Retry-After copy', async () => {
    loadInviteUrl();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'admission_unavailable',
            message: 'new subscriptions are not currently available',
          },
        },
        503,
        { 'Retry-After': '3600' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SubscribeView />);
    fireEvent.change(document.querySelector<HTMLInputElement>('#email')!, {
      target: { value: 'student@berkeley.edu' },
    });
    fireEvent.change(screen.getByLabelText('Class 1'), {
      target: { value: CLASS_KEY },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'New subscriptions are not currently available. Try again in about 1 hour.',
    );
    expect(alert.textContent).not.toMatch(/closed|pilot|invite|code|full/i);
    expect(readStoredPilotInvite()).toBe(VALID_INVITE);
  });

  it('does not clear the bearer for a non-202 success or an invalid create input', async () => {
    loadInviteUrl();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ status: 'pending' }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSubscription({
        email: 'student@berkeley.edu',
        classKeys: [CLASS_KEY],
      }),
    ).rejects.toMatchObject({ error: { code: 'internal_error' } });
    expect(readStoredPilotInvite()).toBe(VALID_INVITE);

    await expect(
      createSubscription({
        email: 'student@example.com',
        classKeys: [CLASS_KEY],
      }),
    ).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readStoredPilotInvite()).toBe(VALID_INVITE);
  });

  it('leaves no invite value in rendered content after capture', async () => {
    loadInviteUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: 'pending' }, 202)),
    );

    render(<SubscribeView />);
    expect(document.body.textContent).not.toContain(VALID_INVITE);

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
  });
});
