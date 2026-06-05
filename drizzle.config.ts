import { defineConfig } from 'drizzle-kit';

// Migration generation config. The schema lives in the database-engineer's lane
// (src/db). Migrations are emitted to ./drizzle. Production points at a real
// Postgres via DATABASE_URL; tests use an in-process Postgres (PGlite) wired in
// src/db. Secrets come only from the environment (constitution).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/seatsniper',
  },
  strict: true,
  verbose: true,
});
