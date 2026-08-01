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
import * as schema from '../../src/db/schema';

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
});
