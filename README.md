# pay.alterera.net

Alterera's payment service. It is the only process that holds Cashfree
credentials, talks to Cashfree, verifies webhooks, and retries hotel
notifications. It runs on its own database instance. The hotel backend must
never share this `DATABASE_URL`.

The hotel backend is the authority on reservations, prices, and inventory. This
service is the authority on whether Cashfree was paid.

## Layout

| Path | Role |
| --- | --- |
| `docs/cashfree-contract.md` | Frozen Cashfree API / webhook contract. Do not guess outside it. |
| `src/payments/` | `POST /api/v1/payment-sessions` and cancel |
| `src/webhooks/` | `POST /api/v1/webhooks/cashfree` |
| `src/notifications/` | Transactional outbox, HMAC notifier, delivery worker |
| `src/reconciliation/` | Polls Cashfree for stuck `PENDING` transactions |
| `src/auth/service-token.guard.ts` | Bearer token for hotel → pay |
| `prisma/` | Own schema: transactions, webhook events, outbox, reconciliation tasks |

There is **no public operator HTTP API**. Refund and attention work lives in
`reconciliation_tasks` and is read from the database / logs.

## Auth

- Hotel → this service: `Authorization: Bearer ${HOTEL_SERVICE_TOKEN}`
- Cashfree → this service: `x-webhook-signature` over `timestamp + rawBody`
- This service → hotel: HMAC-SHA256 of `${timestamp}.${body}` as
  `X-Alterera-Signature`, plus `X-Alterera-Timestamp` and `X-Alterera-Event-Id`

Nothing here is called from a browser. CORS is disabled.

## Local setup

```bash
npm install
cp .env.example .env
# fill DATABASE_URL (separate instance), CASHFREE_*, HOTEL_*
npx prisma migrate deploy
npm run start:dev
```

Default port is 3002. Health: `GET /api/v1/health`.

## Notification retry

Default schedule, in seconds after the previous attempt: 30, 120, 600, 1800,
7200, 21600. Then `NEEDS_ATTENTION`.

Hotel status handling:

| Status | Action |
| --- | --- |
| 200 | `DELIVERED` |
| 202 | `DELIVERED` + `reconciliation_tasks` row (`REFUND_REQUIRED`) |
| 409 | reschedule |
| 4xx | `FAILED_PERMANENT` + `HOTEL_REJECTED` task |
| 5xx / timeout | backoff; give up as `NEEDS_ATTENTION` |

## Tests

```bash
npm test
npm run test:e2e
```

E2E needs PostgreSQL (`TEST_DATABASE_URL` preferred). Cashfree and the hotel
backend are stubbed; uniqueness, the outbox, and webhook idempotency are not.
