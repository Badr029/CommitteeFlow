import { defineConfig } from 'vitest/config';

/**
 * The tests that need nothing but the code.
 *
 * `vitest.config.ts` starts by connecting to PostgreSQL, because most of this
 * suite is integration tests and mocking the database would test the mocks. The
 * unit tests have no such need — date arithmetic, value validation, import
 * parsing, bidirectional text ordering — and refusing to run them because a
 * container is not up costs a fast feedback loop for no reason.
 *
 *   npm run test:unit --workspace server
 *
 * `npm test` still runs everything, and remains what CI runs.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
