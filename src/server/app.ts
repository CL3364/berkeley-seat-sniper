/**
 * Hono application — subscription/manage/unsubscribe endpoints (spec §4, §8 task 3).
 *
 * Exported as `createApp(repo)` (no port binding) so tests can mount it with a
 * mock repo without a live server or DB. `src/server/index.ts` serves it via
 * @hono/node-server and passes the real repo from `../db`.
 *
 * All five routes are implemented exactly as `API_ROUTES` in `src/shared/api.ts`.
 * Every error response uses the `{ error: ApiError }` envelope via the shared
 * `apiError(...)` helper with `API_ERROR_STATUS` codes.
 *
 * Structured logs carry opaque ids and counts only — never the subscriber email
 * or the full watch list (spec §6 / AC-8).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  CreateSubscriptionRequestSchema,
  AddWatchRequestSchema,
  RemoveWatchParamsSchema,
  TokenParamsSchema,
} from '../shared/api';
import { apiError, API_ERROR_STATUS } from '../shared/errors';
import type { ClassKey } from '../shared/class-key';
import { mintToken, verifyToken } from './token';
import { isConflictError, isNotFoundError } from './db-errors';

// ---------------------------------------------------------------------------
// Repo interface — implemented by `src/db` and injected via createApp(repo).
// The db teammate owns the concrete implementation; we depend only on this shape.
// ---------------------------------------------------------------------------

export interface SubscriberRecord {
  id: string;
  email: string;
  watches: ClassKey[];
}

export interface SubscriptionRepo {
  /**
   * Atomically create a subscriber + their initial watches. Throws
   * DuplicateSubscriberError on duplicate email (team-lead decision: no upsert —
   * duplicate email → 409 conflict to prevent account-takeover by email
   * enumeration). Returns the new subscriber's opaque id and canonical watches.
   */
  createSubscriber(
    email: string,
    classKeys: ClassKey[],
  ): Promise<{ id: string; watches: ClassKey[] }>;

  /**
   * Look up a subscriber by opaque id. Returns null when not found (never
   * throws for the missing case).
   */
  getSubscriberById(id: string): Promise<SubscriberRecord | null>;

  /**
   * Add one watch for `subscriberId`. Returns the full updated watch list.
   * Throws ConflictError on `(subscriber_id, class_key)` unique violation.
   */
  addWatch(subscriberId: string, classKey: ClassKey): Promise<{ watches: ClassKey[] }>;

  /**
   * Remove a watch. Idempotent — does not throw when the watch is not found.
   * Subscriber existence is confirmed by the caller before this is invoked.
   */
  removeWatch(subscriberId: string, classKey: ClassKey): Promise<void>;

  /**
   * Delete a subscriber and all their watches. Idempotent — no error if already
   * gone. Subscriber existence is confirmed by the caller before this is invoked.
   */
  deleteSubscriber(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON error response as a native Response (avoids Hono's narrow
 * StatusCode union on dynamic status values from mapRepoError).
 */
function errRes(body: ReturnType<typeof apiError>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify and decode a raw token from the path. Returns the subscriberId on
 * success or a ready-to-return 401 Response on failure.
 */
function resolveToken(
  raw: string,
): { ok: true; subscriberId: string } | { ok: false; res: Response } {
  if (!raw || raw.length > 512) {
    return {
      ok: false,
      res: errRes(apiError('token_invalid', 'invalid or expired token'), 401),
    };
  }

  const result = verifyToken(raw);
  if (!result.ok) {
    return {
      ok: false,
      res: errRes(apiError('token_invalid', 'invalid or expired token'), 401),
    };
  }

  return { ok: true, subscriberId: result.subscriberId };
}

/**
 * Map a Zod parse failure to the `validation_error` response body with the
 * `fields` map for inline form errors (AC-2).
 */
function zodToApiError(err: z.ZodError): ReturnType<typeof apiError> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_root';
    // First message wins per field.
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return apiError('validation_error', 'request validation failed', fields);
}

/**
 * Classify an unknown thrown value from a repo call and return a ready-to-return
 * Response. Unknown errors are logged server-side (opaque only) — internals never
 * reach the client.
 */
function mapRepoError(e: unknown): Response {
  if (isConflictError(e)) {
    // Use a generic message — do not echo e.message which may reveal whether
    // the email already exists (account enumeration risk).
    return errRes(
      apiError('conflict', 'subscription or watch already exists'),
      API_ERROR_STATUS.conflict,
    );
  }
  if (isNotFoundError(e)) {
    return errRes(apiError('not_found', 'subscriber not found'), API_ERROR_STATUS.not_found);
  }
  // Unknown — log only the error CLASS, never `e.message`: a wrapped DB error's
  // message embeds the SQL query + params, which can contain subscriber PII (AC-8).
  // The client gets a generic message; the real cause stays out of the logs.
  console.error({
    event: 'internal_error',
    errorName: e instanceof Error ? e.constructor.name : 'unknown',
  });
  return errRes(
    apiError('internal_error', 'an unexpected error occurred'),
    API_ERROR_STATUS.internal_error,
  );
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(repo: SubscriptionRepo): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // POST /api/subscriptions  →  201 { subscriberId, token, watches }
  // -------------------------------------------------------------------------
  app.post('/api/subscriptions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errRes(apiError('validation_error', 'request body must be JSON'), 400);
    }

    const parsed = CreateSubscriptionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errRes(zodToApiError(parsed.error), 400);
    }

    const { email, classKeys } = parsed.data;

    let result: { id: string; watches: ClassKey[] };
    try {
      result = await repo.createSubscriber(email, classKeys);
    } catch (e) {
      return mapRepoError(e);
    }

    const token = mintToken(result.id);

    // Log opaque id + watch count only — never the email (AC-8).
    console.log({
      event: 'subscriber_created',
      subscriberId: result.id,
      watchCount: result.watches.length,
    });

    return c.json({ subscriberId: result.id, token, watches: result.watches }, 201);
  });

  // -------------------------------------------------------------------------
  // GET /api/subscriptions/:token  →  200 { email, watches }
  // -------------------------------------------------------------------------
  app.get('/api/subscriptions/:token', async (c) => {
    const rawToken = c.req.param('token');
    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (e) {
      return mapRepoError(e);
    }

    if (!subscriber) {
      return errRes(apiError('not_found', 'subscriber not found'), 404);
    }

    // Log opaque id + watch count only (AC-8).
    console.log({
      event: 'subscription_fetched',
      subscriberId: subscriber.id,
      watchCount: subscriber.watches.length,
    });

    return c.json({ email: subscriber.email, watches: subscriber.watches }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /api/subscriptions/:token/watches  →  200 { watches }
  // -------------------------------------------------------------------------
  app.post('/api/subscriptions/:token/watches', async (c) => {
    const rawToken = c.req.param('token');
    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errRes(apiError('validation_error', 'request body must be JSON'), 400);
    }

    const parsed = AddWatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errRes(zodToApiError(parsed.error), 400);
    }

    const { classKey } = parsed.data;

    // Confirm the subscriber exists (valid token for missing subscriber → 404).
    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (e) {
      return mapRepoError(e);
    }

    if (!subscriber) {
      return errRes(apiError('not_found', 'subscriber not found'), 404);
    }

    let result: { watches: ClassKey[] };
    try {
      result = await repo.addWatch(resolved.subscriberId, classKey);
    } catch (e) {
      return mapRepoError(e);
    }

    // Log opaque id + new watch count only (AC-8).
    console.log({
      event: 'watch_added',
      subscriberId: resolved.subscriberId,
      watchCount: result.watches.length,
    });

    return c.json({ watches: result.watches }, 200);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/subscriptions/:token/watches/:classKey  →  204
  // -------------------------------------------------------------------------
  app.delete('/api/subscriptions/:token/watches/:classKey', async (c) => {
    const rawToken = c.req.param('token');
    const rawClassKey = c.req.param('classKey');

    // Validate both path params together. RemoveWatchParamsSchema uses the strict
    // ClassKeySchema for :classKey — an unrecognized key is a 400 validation_error,
    // not a 401.
    const paramsParsed = RemoveWatchParamsSchema.safeParse({
      token: rawToken,
      classKey: rawClassKey,
    });
    if (!paramsParsed.success) {
      const hasTokenIssue = paramsParsed.error.issues.some((i) => i.path[0] === 'token');
      if (hasTokenIssue) {
        return errRes(apiError('token_invalid', 'invalid or expired token'), 401);
      }
      return errRes(zodToApiError(paramsParsed.error), 400);
    }

    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    const { classKey } = paramsParsed.data;

    // Confirm subscriber exists.
    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (e) {
      return mapRepoError(e);
    }

    if (!subscriber) {
      return errRes(apiError('not_found', 'subscriber not found'), 404);
    }

    try {
      await repo.removeWatch(resolved.subscriberId, classKey);
    } catch (e) {
      return mapRepoError(e);
    }

    // Log opaque id only (AC-8).
    console.log({ event: 'watch_removed', subscriberId: resolved.subscriberId });

    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/subscriptions/:token  →  204
  // -------------------------------------------------------------------------
  app.delete('/api/subscriptions/:token', async (c) => {
    const rawToken = c.req.param('token');

    const paramsParsed = TokenParamsSchema.safeParse({ token: rawToken });
    if (!paramsParsed.success) {
      return errRes(apiError('token_invalid', 'invalid or expired token'), 401);
    }

    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    // Confirm subscriber exists before deleting (valid token, missing row → 404).
    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (e) {
      return mapRepoError(e);
    }

    if (!subscriber) {
      return errRes(apiError('not_found', 'subscriber not found'), 404);
    }

    try {
      await repo.deleteSubscriber(resolved.subscriberId);
    } catch (e) {
      return mapRepoError(e);
    }

    // Log opaque id only (AC-8).
    console.log({ event: 'subscriber_deleted', subscriberId: resolved.subscriberId });

    return new Response(null, { status: 204 });
  });

  return app;
}
