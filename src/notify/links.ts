import { API_ROUTES } from '../shared/api';
import type { MailHeaders } from './types';

/**
 * URL + RFC-8058 header builders for subscriber-facing mail. Single source of
 * truth for the pinned link formats (spec §4) so notify, the frontend router,
 * and the link-extraction tests all agree.
 *
 * Pinned formats (spec §4):
 *   Confirm link:      ${APP_BASE_URL}/?confirm=<token>
 *   Manage link:       ${APP_BASE_URL}/?token=<token>
 *   One-click unsub:   ${APP_BASE_URL}<oneClickUnsubscribe.path with :token filled>
 *
 * The unsubscribe path comes from the contract's API_ROUTES so it can never
 * drift from the backend route the mail provider POSTs to (RFC 8058).
 */

/** Strip a single trailing slash so we never produce `base//path`. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** `${APP_BASE_URL}/?confirm=<token>` — confirmation email. */
export function buildConfirmUrl(appBaseUrl: string, token: string): string {
  return `${normalizeBase(appBaseUrl)}/?confirm=${encodeURIComponent(token)}`;
}

/** `${APP_BASE_URL}/?token=<token>` — manage-link email + alert footer. */
export function buildManageUrl(appBaseUrl: string, token: string): string {
  return `${normalizeBase(appBaseUrl)}/?token=${encodeURIComponent(token)}`;
}

/**
 * Absolute one-click unsubscribe URL (RFC 8058 target). Built from the contract
 * route `POST /api/subscriptions/:token/unsubscribe` with `:token` substituted.
 */
export function buildUnsubscribeUrl(appBaseUrl: string, token: string): string {
  const path = API_ROUTES.oneClickUnsubscribe.path.replace(':token', encodeURIComponent(token));
  return `${normalizeBase(appBaseUrl)}${path}`;
}

/**
 * Build the List-Unsubscribe family of headers (RFC 8058 one-click) for one
 * subscriber-facing message. Both headers are required by spec §6 on every
 * alert / confirmation / manage-link message:
 *
 *   List-Unsubscribe:      <${unsubscribeUrl}>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The angle-bracketed URL form is what RFC 2369 / 8058 require.
 */
export function buildListUnsubscribeHeaders(appBaseUrl: string, token: string): MailHeaders {
  const unsubscribeUrl = buildUnsubscribeUrl(appBaseUrl, token);
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
