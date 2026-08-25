import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { deadLetterIncidents } from '../../src/db/schema';
import { getClassState, listPendingAlertDeliveries, upsertClassState } from '../../src/db';
import * as schema from '../../src/db/schema';
import type { ClassKey } from '../../src/shared/class-key';

function migrationPrefixThrough(index: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'seat-sniper-migration-prefix-'));
  const metadata = join(directory, 'meta');
  mkdirSync(metadata);
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= index);
  writeFileSync(join(metadata, '_journal.json'), JSON.stringify({ ...journal, entries }), 'utf8');
  for (const entry of entries) {
    cpSync(join(process.cwd(), 'drizzle', `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  return directory;
}

function expectedBackfillUuid(mailJobId: string): string {
  const digest = createHash('md5').update(mailJobId).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `3${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

describe('v0.4.2 migration backfill', () => {
  it('opens one unresolved incident with a deterministic RFC-shaped UUID for each legacy dead letter', async () => {
    const oldMigrations = migrationPrefixThrough(9);
    const client = new PGlite();
    const db = drizzlePglite(client, { schema });
    const mailJobId = 'legacy-dead-letter-mail-job';
    const terminalAt = new Date('2026-07-24T08:00:00.000Z');
    try {
      await migratePglite(db, { migrationsFolder: oldMigrations });
      await db.execute(sql`
          insert into mail_outbox (
            id,
            kind,
            status,
            attempts,
            terminal_at,
            terminal_reason,
            provider_idempotency_key,
            payload,
            created_at,
            updated_at
          )
          values (
            ${mailJobId},
            'operator',
            'dead_letter',
            5,
            ${terminalAt},
            'permanent-failure',
            ${`legacy/${mailJobId}`},
            '{}'::jsonb,
            ${new Date(terminalAt.getTime() - 60_000)},
            ${terminalAt}
          )
        `);

      await migratePglite(db, { migrationsFolder: './drizzle' });

      const incidents = await db.select().from(deadLetterIncidents);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        id: expectedBackfillUuid(mailJobId),
        mailJobId,
        state: 'unresolved',
        surfacedAt: null,
        acknowledgedAt: null,
        resolvedAt: null,
      });
      expect(incidents[0]!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(incidents[0]!.openedAt).toEqual(terminalAt);
    } finally {
      await client.close();
      rmSync(oldMigrations, { recursive: true, force: true });
    }
  }, 30_000);

  it('upgrades a 0011 class_state with null reserved seats and supports current repo reads/writes', async () => {
    const oldMigrations = migrationPrefixThrough(11);
    const client = new PGlite();
    const db = drizzlePglite(client, { schema });
    const classKey = '2026-fall-compsci-189-001-lec-001' as ClassKey;
    const subscriberId = 'legacy-reserved-alert-subscriber';
    const openedAt = new Date('2030-08-21T20:01:00.000Z');
    try {
      await migratePglite(db, { migrationsFolder: oldMigrations });
      await db.execute(sql`
        insert into class_state (
          class_key,
          last_status,
          last_open_seats,
          last_waitlist_open,
          display_name,
          updated_at
        )
        values (
          ${classKey},
          'open',
          41,
          false,
          'COMPSCI 189 001 - LEC 001',
          ${new Date('2026-08-21T20:00:00.000Z')}
        )
      `);
      await db.execute(sql`
        insert into subscribers (id, email, confirmed_at, created_at)
        values (
          ${subscriberId},
          'legacy-reserved-alert@berkeley.edu',
          ${new Date('2026-08-21T19:00:00.000Z')},
          ${new Date('2026-08-21T19:00:00.000Z')}
        )
      `);
      await db.execute(sql`
        insert into alert_deliveries (
          subscriber_id,
          class_key,
          opened_at,
          reason,
          open_seats,
          watch_activation_order,
          expires_at,
          provider_idempotency_key
        )
        values (
          ${subscriberId},
          ${classKey},
          ${openedAt},
          'seats-open',
          41,
          1,
          ${new Date(openedAt.getTime() + 60 * 60_000)},
          'legacy/reserved-alert'
        )
      `);

      await migratePglite(db, { migrationsFolder: './drizzle' });

      expect(await getClassState(db, classKey)).toMatchObject({
        classKey,
        lastOpenSeats: 41,
        lastOpenReserved: null,
      });
      expect(await listPendingAlertDeliveries(db)).toEqual([
        expect.objectContaining({
          subscriberId,
          classKey,
          openSeats: 41,
          openReserved: null,
        }),
      ]);

      await upsertClassState(db, {
        classKey,
        lastStatus: 'open',
        lastOpenSeats: 41,
        lastWaitlistOpen: false,
        displayName: 'COMPSCI 189 001 - LEC 001',
        lastEnrolled: 479,
        lastCapacity: 520,
        lastWaitlisted: 265,
        lastWaitlistMax: 300,
        lastOpenReserved: 41,
      });

      expect(await getClassState(db, classKey)).toMatchObject({
        classKey,
        lastOpenSeats: 41,
        lastOpenReserved: 41,
      });
    } finally {
      await client.close();
      rmSync(oldMigrations, { recursive: true, force: true });
    }
  }, 30_000);

  it('upgrades a populated 0012 mail_outbox to the FR-28 blind-window kind', async () => {
    // 0013 DROPs and re-ADDs two CHECK constraints that every existing row must
    // still satisfy. A populated table is the only way to catch a re-added
    // constraint that silently excludes rows already in production.
    const oldMigrations = migrationPrefixThrough(12);
    const client = new PGlite();
    const db = drizzlePglite(client, { schema });
    const classKey = '2026-fall-compsci-189-001-lec-001' as ClassKey;
    const subscriberId = 'legacy-outbox-subscriber';
    const openedAt = new Date('2030-08-21T20:01:00.000Z');
    try {
      await migratePglite(db, { migrationsFolder: oldMigrations });
      await db.execute(sql`
        insert into subscribers (id, email, confirmed_at, created_at)
        values (
          ${subscriberId},
          'legacy-outbox@berkeley.edu',
          ${new Date('2026-08-21T19:00:00.000Z')},
          ${new Date('2026-08-21T19:00:00.000Z')}
        )
      `);
      // One row of every kind that existed before FR-28.
      await db.execute(sql`
        insert into mail_outbox (
          id, kind, subscriber_id, class_key, opened_at, reason, expires_at,
          provider_idempotency_key, payload
        )
        values
          (
            'legacy-alert', 'alert', ${subscriberId}, ${classKey}, ${openedAt}, 'seats-open',
            ${new Date(openedAt.getTime() + 60 * 60_000)}, 'legacy/alert', '{}'::jsonb
          ),
          (
            'legacy-confirmation', 'confirmation', ${subscriberId}, null, null, null, null,
            'legacy/confirmation', '{}'::jsonb
          ),
          (
            'legacy-manage', 'manage-link', ${subscriberId}, null, null, null, null,
            'legacy/manage', '{}'::jsonb
          ),
          (
            'legacy-operator', 'operator', null, ${classKey}, null, null, null,
            'legacy/operator', '{"detail":"legacy"}'::jsonb
          )
      `);

      await migratePglite(db, { migrationsFolder: './drizzle' });

      // Every pre-existing row survived the constraint swap.
      const survivors = await db.select().from(schema.mailOutbox);
      expect(survivors.map((row) => row.kind).sort()).toEqual([
        'alert',
        'confirmation',
        'manage-link',
        'operator',
      ]);

      // The new kind is now accepted...
      await db.execute(sql`
        insert into mail_outbox (
          id, kind, subscriber_id, class_key, opened_at, provider_idempotency_key, payload
        )
        values (
          'upgraded-blind-window', 'blind-window', ${subscriberId}, ${classKey}, ${openedAt},
          'upgraded/blind-window', '{}'::jsonb
        )
      `);

      // ...and the once-per-window index exists and bites on the upgraded table.
      await expect(
        db.execute(sql`
          insert into mail_outbox (
            id, kind, subscriber_id, class_key, opened_at, provider_idempotency_key, payload
          )
          values (
            'upgraded-blind-window-dup', 'blind-window', ${subscriberId}, ${classKey}, ${openedAt},
            'upgraded/blind-window-dup', '{}'::jsonb
          )
        `),
      ).rejects.toThrow();

      // The Alert at the same (subscriber, class, moment) is untouched by it.
      expect(await db.select().from(schema.mailOutbox)).toHaveLength(5);
    } finally {
      await client.close();
      rmSync(oldMigrations, { recursive: true, force: true });
    }
  }, 30_000);
});
