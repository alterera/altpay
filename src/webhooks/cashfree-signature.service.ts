import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentConfig } from '../config/payment.config';
import { CashfreeWebhookPayload } from '../cashfree/cashfree.types';

export type VerificationFailure =
  | 'MISSING_HEADERS'
  | 'MISSING_RAW_BODY'
  | 'STALE_TIMESTAMP'
  | 'SIGNATURE_MISMATCH';

export type VerificationResult =
  { verified: true } | { verified: false; reason: VerificationFailure };

@Injectable()
export class CashfreeSignatureService {
  constructor(private readonly config: PaymentConfig) {}

  /**
   * Verifies `base64(hmacSha256(timestamp + rawBody, clientSecret))` against
   * `x-webhook-signature`, per the frozen contract.
   *
   * `rawBody` must be the bytes as received. Cashfree signs its own serialisation,
   * so a parse-and-restringify round trip changes `170.00` into `170` and the
   * signature stops matching for reasons that look nothing like the real cause.
   */
  verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
  ): VerificationResult {
    if (!signature || !timestamp) {
      return { verified: false, reason: 'MISSING_HEADERS' };
    }
    if (!rawBody) {
      return { verified: false, reason: 'MISSING_RAW_BODY' };
    }
    if (!this.isFresh(timestamp)) {
      return { verified: false, reason: 'STALE_TIMESTAMP' };
    }

    const expected = createHmac('sha256', this.config.cashfreeClientSecret)
      .update(timestamp)
      .update(rawBody)
      .digest('base64');

    return this.matches(expected, signature)
      ? { verified: true }
      : { verified: false, reason: 'SIGNATURE_MISMATCH' };
  }

  /**
   * Cashfree's own idempotency key when it sends one; otherwise a deterministic
   * digest of the identifying fields, so a redelivery of the same event produces
   * the same id and collides on the unique index.
   */
  resolveEventId(
    payload: CashfreeWebhookPayload,
    idempotencyKey: string | undefined,
  ): string {
    if (idempotencyKey) return idempotencyKey;

    const parts = [
      payload.type ?? '',
      payload.data?.order?.order_id ?? '',
      String(payload.data?.payment?.cf_payment_id ?? ''),
      payload.data?.payment?.payment_status ?? '',
      payload.event_time ?? '',
    ];

    return createHash('sha256').update(parts.join('|')).digest('hex');
  }

  /** Cashfree sends epoch milliseconds. */
  private isFresh(timestamp: string): boolean {
    const sentAtMs = Number(timestamp);
    if (!Number.isFinite(sentAtMs)) return false;
    const skewSeconds = Math.abs(Date.now() - sentAtMs) / 1000;
    return skewSeconds <= this.config.webhookMaxSkewSeconds;
  }

  private matches(expected: string, received: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
