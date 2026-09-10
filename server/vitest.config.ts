import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real PostgreSQL instance.
 *
 * The database is where most of CommitteeFlow's correctness lives — constraints,
 * transactions, advisory locks, the version check in a WHERE clause. Mocking it
 * would test the mocks (spec §71 asks for database tests explicitly).
 *
 * Start it with `npm run db:up`; the suite migrates and truncates it itself.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    setupFiles: ['./tests/helpers/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Suites share one database, so they must not run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 40_000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/seed.ts', 'src/**/*.d.ts'],
    },
  },
});
