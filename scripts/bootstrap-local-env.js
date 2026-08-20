/*
 * Writes a local .env for the payment service.
 *
 * In production this service gets its own database instance. Locally there is only
 * one PostgreSQL to hand, so this points at the same server but a dedicated
 * `pay_service` schema — enough isolation to develop and test against without
 * pretending it is the deployed topology.
 *
 * The connection string is copied between files and never printed.
 *
 *   node scripts/bootstrap-local-env.js
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SCHEMA = 'pay_service';
const target = join(__dirname, '..', '.env');
const source = join(__dirname, '..', '..', 'backend', '.env');

if (existsSync(target)) {
  console.log('.env already exists; leaving it alone.');
  process.exit(0);
}

if (!existsSync(source)) {
  console.error(
    'No backend/.env to derive from. Copy .env.example to .env and fill in DATABASE_URL manually.',
  );
  process.exit(1);
}

const match = readFileSync(source, 'utf8').match(/^DATABASE_URL=(.*)$/m);
if (!match) {
  console.error('backend/.env has no DATABASE_URL.');
  process.exit(1);
}

const url = match[1].trim().replace(/^["']|["']$/g, '');
const withSchema = /[?&]schema=/.test(url)
  ? url.replace(/([?&])schema=[^&]*/, `$1schema=${SCHEMA}`)
  : `${url}${url.includes('?') ? '&' : '?'}schema=${SCHEMA}`;

const template = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
const body = template
  .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="${withSchema}"`)
  .replace(/^CASHFREE_CLIENT_ID=.*$/m, 'CASHFREE_CLIENT_ID=local-client-id')
  .replace(
    /^CASHFREE_CLIENT_SECRET=.*$/m,
    'CASHFREE_CLIENT_SECRET=local-client-secret',
  )
  .replace(/^HOTEL_SERVICE_TOKEN=.*$/m, 'HOTEL_SERVICE_TOKEN=local-service-token')
  .replace(/^HOTEL_BASE_URL=.*$/m, 'HOTEL_BASE_URL=http://localhost:3001')
  .replace(
    /^HOTEL_NOTIFICATION_SIGNING_SECRET=.*$/m,
    'HOTEL_NOTIFICATION_SIGNING_SECRET=local-notification-secret',
  );

writeFileSync(target, body, 'utf8');
console.log(`Wrote .env using the "${SCHEMA}" schema. Cashfree values are placeholders.`);
