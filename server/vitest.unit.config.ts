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
    /*
     * Placeholders, not configuration.
     *
     * A few modules reach the logger on import, and the logger parses the
     * environment eagerly — so importing the mailer to test its formatting used
     * to fail on a missing DATABASE_URL. Nothing here connects to anything; the
     * values exist only so the schema is satisfied.
     */
    env: {
      DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit-tests-never-connect',
      SESSION_SECRET: 'unit-tests-never-start-a-session-with-this-value',
    },
    include: ['tests/unit/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
