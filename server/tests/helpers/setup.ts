/**
 * Per-file test environment.
 *
 * Loaded before any application module so `env()` sees a test configuration and
 * never touches the developer's real database or SMTP server.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://committeeflow:committeeflow@localhost:5433/committeeflow_test';
process.env['SESSION_SECRET'] = 'test-session-secret-that-is-long-enough';
process.env['COOKIE_SECURE'] = 'false';
process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
// The worker is driven explicitly in tests; a timer would make them flaky.
process.env['OUTBOX_WORKER_ENABLED'] = 'false';
process.env['SMTP_HOST'] = '';
process.env['APP_PUBLIC_URL'] = 'http://localhost:4000';
// Generous limits so functional suites do not trip the rate limiter; the
// limiter has its own dedicated test that sets its own values.
process.env['LOGIN_RATE_LIMIT_MAX_ATTEMPTS'] = '1000';
process.env['WRITE_RATE_LIMIT_MAX'] = '10000';
// Not serving a client build during tests.
process.env['CLIENT_DIST_PATH'] = '/nonexistent';
