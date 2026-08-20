import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

// `.env.test` first so it wins over `.env` for anything it defines.
const testEnv = join(process.cwd(), '.env.test');
if (existsSync(testEnv)) {
  config({ path: testEnv });
}
config({ path: join(process.cwd(), '.env') });

/**
 * The payment service suites need a real PostgreSQL: their central guarantees are
 * unique-constraint idempotency and transactional outbox writes, neither of which
 * an in-memory substitute reproduces.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Payment service e2e tests need TEST_DATABASE_URL (preferred) or DATABASE_URL to be set',
  );
}

// Cashfree is always stubbed in tests, so these only have to be present.
process.env.CASHFREE_ENV ??= 'SANDBOX';
process.env.CASHFREE_CLIENT_ID ??= 'e2e-client-id';
process.env.CASHFREE_CLIENT_SECRET ??= 'e2e-client-secret';
process.env.CASHFREE_NOTIFY_URL ??=
  'https://pay.e2e.invalid/api/v1/webhooks/cashfree';

process.env.HOTEL_SERVICE_TOKEN ??= 'e2e-service-token';
process.env.HOTEL_BASE_URL ??= 'https://api.e2e.invalid';
process.env.HOTEL_NOTIFICATION_SIGNING_SECRET ??= 'e2e-notification-secret';
