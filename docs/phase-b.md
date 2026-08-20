# Phase B — Payment service behaviour

Companion to `docs/cashfree-contract.md` (provider surface) and
`backend/docs/phase-b-payments.md` (hotel surface).

## Session creation

`POST /api/v1/payment-sessions` is idempotent on `paymentReference`:

- Same reference, same amount → return the stored session (HTTP 200)
- Same reference, different amount → 409
- New reference → create a Cashfree order whose `order_id` is the reference,
  persist `payment_session_id`, return the hosted checkout URL (HTTP 201)

`POST /api/v1/payment-sessions/:paymentReference/cancel` is best-effort and
idempotent. Cashfree may refuse to terminate an order whose payment just
succeeded; that case is handled as a late payment by the hotel, not as a
failure of cancel.

## Webhooks

Verified on the raw body before parsing. Stored first, then processed. Always
200 once stored so Cashfree stops redelivering. The payload is a prompt to call
Fetch Order; only `order_status = PAID` with a matching amount notifies the
hotel. Amount mismatches mark the transaction `NEEDS_ATTENTION` and do not
notify.

## Outbox

The hotel notification is inserted in the same transaction that records
`SUCCESS` or `FAILED`. Delivery is a separate cron that claims due rows with
`FOR UPDATE SKIP LOCKED`.

## Reconciliation

Every 5 minutes, `PENDING` transactions older than
`RECONCILE_PENDING_AFTER_MINUTES` are re-read from Cashfree. A paid order with
no webhook is repaired and notified. An expired unpaid order is marked
`EXPIRED` without notifying — the hotel's hold expiry already covers it.

## What this service does not do

- Host a checkout page
- Confirm reservations or touch inventory
- Expose an operator HTTP API
- Execute refunds (it only records that one is owed)
