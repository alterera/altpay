# Cashfree contract (frozen for Phase B)

Everything the payment service assumes about Cashfree, pinned in one place. Sourced from
Cashfree's published API reference in August 2026. Nothing outside this document may be
guessed at implementation time — if a field is needed and is not listed here, this document
gets updated and reviewed first.

## API version

`2025-01-01`, sent on every request as `x-api-version`.

Cashfree versions its payload shapes by this header, and the webhook echoes the version it
was generated with in `x-webhook-version`. Pinning it means a Cashfree-side release cannot
silently reshape our parsing.

## Base URLs

| Environment | Base URL |
| --- | --- |
| Sandbox | `https://sandbox.cashfree.com/pg` |
| Production | `https://api.cashfree.com/pg` |

Selected by `CASHFREE_ENV` (`SANDBOX` or `PRODUCTION`); `CASHFREE_BASE_URL` overrides it
when Cashfree moves a host.

## Authentication

Server-to-server calls carry three headers:

```
x-api-version: 2025-01-01
x-client-id: <CASHFREE_CLIENT_ID>
x-client-secret: <CASHFREE_CLIENT_SECRET>
```

`CASHFREE_CLIENT_SECRET` doubles as the webhook signing key, so it must never be logged
and never leaves the payment service.

## Create Order

`POST {base}/orders`

Request fields we send:

```json
{
  "order_id": "PAY-9f2c8d1e-...",
  "order_amount": 8700.00,
  "order_currency": "INR",
  "order_expiry_time": "2026-08-20T07:10:00+05:30",
  "order_note": "AlterStays booking ALTSTAY-20260820-K3M9QP",
  "customer_details": {
    "customer_id": "res_ALTSTAY-20260820-K3M9QP",
    "customer_name": "Asif Khan",
    "customer_phone": "9876543210",
    "customer_email": "asif@example.com"
  },
  "order_meta": {
    "return_url": "https://alterstays.com/booking/payment-result?ref=ALTSTAY-20260820-K3M9QP",
    "notify_url": "https://pay.alterera.net/api/v1/webhooks/cashfree"
  },
  "order_tags": {
    "reservationReference": "ALTSTAY-20260820-K3M9QP",
    "paymentReference": "PAY-9f2c8d1e-..."
  }
}
```

Notes that matter:

- `order_id` is our own `paymentReference`. Cashfree enforces uniqueness on it, which makes
  order creation naturally idempotent: a retry with the same reference cannot produce a
  second order.
- `order_amount` is a JSON number, not a string. We hold amounts as `Decimal(12,2)` and
  convert at the boundary only.
- `order_expiry_time` is the reservation's `holdExpiresAt`, so a Cashfree order can never
  outlive the inventory hold that backs it.
- `customer_phone` goes without the `+91` country prefix; Cashfree rejects some formats and
  accepts the bare 10-digit Indian number.
- `notify_url` per order means we do not depend on a dashboard-wide webhook setting.

Response fields we consume:

| Field | Use |
| --- | --- |
| `cf_order_id` | Cashfree's own order id, stored for support queries |
| `order_id` | echoed `paymentReference` |
| `payment_session_id` | the opaque, short-lived session the browser needs |
| `order_status` | `ACTIVE` on success |
| `order_expiry_time` | stored as `sessionExpiresAt` |

## Checkout URL

The payment service stays API-only. The browser is sent to Cashfree's hosted checkout,
built from `payment_session_id`:

| Environment | Template |
| --- | --- |
| Sandbox | `https://payments-test.cashfree.com/order/#{payment_session_id}` |
| Production | `https://payments.cashfree.com/order/#{payment_session_id}` |

This is the one item in this document that must be confirmed against the merchant dashboard
before going live, so it is **configuration, not code**: `CASHFREE_CHECKOUT_URL_TEMPLATE`
holds the template and `{payment_session_id}` is substituted. If the account is enabled for
the server-to-server `POST /orders/sessions` flow (`channel: "link"`, redirect to
`data.url`), only the env var changes.

We deliberately do not host a checkout page ourselves. `payment_session_id` is already
opaque, single-order, and short-lived, so proxying it through our own page would add
attack surface without adding a guarantee.

## Fetch Order (re-verification)

`GET {base}/orders/{order_id}`

Called after every webhook so the provider's own record, not the webhook body, decides the
outcome. `order_status` is authoritative:

| `order_status` | Meaning |
| --- | --- |
| `ACTIVE` | no successful transaction yet |
| `PAID` | exactly one successful transaction |
| `EXPIRED` | passed `order_expiry_time` unpaid; no further payment possible |
| `TERMINATED` | cancelled by us |
| `TERMINATION_REQUESTED` | cancellation in progress |

We treat only `PAID` as success. `order_amount` and `order_currency` from this response are
compared against our stored transaction before the hotel is notified.

## Fetch Payments for an Order

`GET {base}/orders/{order_id}/payments`

Used by reconciliation to recover `cf_payment_id`, `payment_status`, `payment_method`, and
`payment_time` when a webhook never arrived.

## Terminate Order (session cancel)

`PATCH {base}/orders/{order_id}` with body:

```json
{ "order_status": "TERMINATED" }
```

Best-effort. The response may come back `TERMINATION_REQUESTED` rather than `TERMINATED`,
and Cashfree explicitly will not terminate an order whose in-flight transaction has just
succeeded. So termination is never treated as a guarantee: a success webhook may still
arrive afterwards, and it is handled through the normal late-payment path.

## Webhooks

`POST /api/v1/webhooks/cashfree` on the payment service.

Headers Cashfree sends:

| Header | Use |
| --- | --- |
| `x-webhook-signature` | base64 HMAC-SHA256, the only authentication |
| `x-webhook-timestamp` | epoch milliseconds, part of the signed string |
| `x-webhook-version` | payload version, expected `2025-01-01` |
| `x-webhook-attempt` | delivery attempt counter, logged only |
| `x-idempotency-key` | Cashfree's own dedupe key, used as the event id when present |

### Signature verification

```
signatureData = x-webhook-timestamp + rawRequestBody
expected      = base64(hmacSha256(signatureData, CASHFREE_CLIENT_SECRET))
```

Compared against `x-webhook-signature` with a constant-time comparison.

The body must be the **untouched raw bytes**. Cashfree computes the signature over the
exact string it sent, so re-serialising the JSON breaks verification — most visibly on
amounts, where `170.00` would come back out as `170`. This is why the payment service
bootstraps with `{ rawBody: true }` and why the webhook route is exempt from the global
validation pipe.

Timestamps outside `CASHFREE_WEBHOOK_MAX_SKEW_SECONDS` (default 300) are rejected, which
bounds how long a captured request stays replayable.

### Event types

| `type` | Handling |
| --- | --- |
| `PAYMENT_SUCCESS_WEBHOOK` | re-verify with Fetch Order, then notify the hotel of success |
| `PAYMENT_FAILED_WEBHOOK` | record failure, notify the hotel of failure |
| `PAYMENT_USER_DROPPED_WEBHOOK` | record failure, notify the hotel of failure |
| anything else | stored, acknowledged, not acted on |

### Payload shape

```json
{
  "data": {
    "order": {
      "order_id": "PAY-9f2c8d1e-...",
      "order_amount": 8700.00,
      "order_currency": "INR",
      "order_tags": null
    },
    "payment": {
      "cf_payment_id": "1453002795",
      "payment_status": "SUCCESS",
      "payment_amount": 8700.00,
      "payment_currency": "INR",
      "payment_message": "00::Transaction success",
      "payment_time": "2026-08-20T12:20:29+05:30",
      "bank_reference": "234928698581",
      "payment_group": "upi",
      "payment_method": { "upi": { "channel": "collect", "upi_id": "x@ybl" } }
    },
    "customer_details": { "customer_id": "...", "customer_phone": "..." },
    "error_details": {
      "error_code": "GATEWAY_ERROR",
      "error_description": "...",
      "error_reason": "...",
      "error_source": "..."
    }
  },
  "event_time": "2026-08-20T11:16:10+05:30",
  "type": "PAYMENT_SUCCESS_WEBHOOK"
}
```

`payment_status` values seen on these events: `SUCCESS`, `FAILED`, `USER_DROPPED`.
`error_details` is present only on failures.

Only these fields are read: `type`, `event_time`, `data.order.order_id`,
`data.order.order_amount`, `data.order.order_currency`, `data.payment.cf_payment_id`,
`data.payment.payment_status`, `data.payment.payment_amount`,
`data.payment.payment_currency`, `data.payment.payment_group`,
`data.payment.payment_time`, and `data.error_details.*`. The full body is persisted as
JSON for audit, but nothing else is parsed, so extra Cashfree fields cannot break us.

### Event id

`x-idempotency-key` when Cashfree sends it. Older payloads omit it, so the fallback is a
SHA-256 of `type | order_id | cf_payment_id | payment_status | event_time` — deterministic,
so a redelivery of the same event collides on the unique index and is recognised as a
duplicate.

Card numbers, UPI IDs, and other instrument details are never copied out of the payload
into our own columns. They stay inside the archived JSON only.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CASHFREE_ENV` | `SANDBOX` or `PRODUCTION`; picks the base URL and checkout template |
| `CASHFREE_BASE_URL` | explicit override for the API base |
| `CASHFREE_API_VERSION` | defaults to `2025-01-01` |
| `CASHFREE_CLIENT_ID` | `x-client-id` |
| `CASHFREE_CLIENT_SECRET` | `x-client-secret`, and the webhook signing key |
| `CASHFREE_CHECKOUT_URL_TEMPLATE` | checkout URL with a `{payment_session_id}` placeholder |
| `CASHFREE_WEBHOOK_MAX_SKEW_SECONDS` | webhook timestamp tolerance, default 300 |
| `CASHFREE_TIMEOUT_MS` | per-request timeout against Cashfree, default 10000 |

## Open item

The checkout URL template is the only unverified value here. It is env-configured
specifically so confirming it against the live merchant dashboard is a deployment change
and not a code change.
