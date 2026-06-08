import { defineConfig } from 'vitest/config';

// Unit + integration tests (Vitest). Default environment is `node` so API, db,
// scraper, and worker tests run against real Node globals. Component/client tests
// that need a DOM must declare it per file with a top-of-file directive:
//   // @vitest-environment jsdom
//
// JSX is transformed by esbuild's automatic runtime (no @vitejs/plugin-react here —
// Fast Refresh is irrelevant in tests, and importing it pulls in a second copy of
// vite's types that clashes with the top-level one).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e', 'drizzle'],
    clearMocks: true,
    restoreMocks: true,
  },
});
