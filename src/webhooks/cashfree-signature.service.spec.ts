import { createHmac, createHash } from 'node:crypto';
import { PaymentConfig } from '../config/payment.config';
import { CashfreeSignatureService } from '../webhooks/cashfree-signature.service';
import { WEBHOOK_SUCCESS } from '../cashfree/cashfree.types';

const SECRET = 'webhook-secret';

function configStub(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    cashfreeClientSecret: SECRET,
    webhookMaxSkewSeconds: 300,
    ...overrides,
  } as PaymentConfig;
}

describe('CashfreeSignatureService', () => {
  const service = new CashfreeSignatureService(configStub());

  function sign(timestamp: string, body: string): string {
    return createHmac('sha256', SECRET)
      .update(timestamp)
      .update(body)
      .digest('base64');
  }

  it('accepts a fresh signature over the raw body', () => {
    const body = '{"order_amount":170.00}';
    const timestamp = String(Date.now());
    expect(
      service.verify(Buffer.from(body), sign(timestamp, body), timestamp),
    ).toEqual({ verified: true });
  });

  it('rejects a re-serialised body whose amounts lost trailing zeros', () => {
    const original = '{"order_amount":170.00}';
    const timestamp = String(Date.now());
    const signature = sign(timestamp, original);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(original)));

    expect(service.verify(reserialised, signature, timestamp)).toEqual({
      verified: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('rejects a stale timestamp', () => {
    const body = '{}';
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    expect(
      service.verify(Buffer.from(body), sign(timestamp, body), timestamp),
    ).toEqual({ verified: false, reason: 'STALE_TIMESTAMP' });
  });

  it('rejects missing headers', () => {
    expect(service.verify(Buffer.from('{}'), undefined, undefined)).toEqual({
      verified: false,
      reason: 'MISSING_HEADERS',
    });
  });

  it("uses Cashfree's idempotency key when present", () => {
    expect(service.resolveEventId({ type: WEBHOOK_SUCCESS }, 'cf-idem-1')).toBe(
      'cf-idem-1',
    );
  });

  it('falls back to a deterministic hash so redeliveries collide', () => {
    const payload = {
      type: WEBHOOK_SUCCESS,
      event_time: '2026-08-20T11:16:10+05:30',
      data: {
        order: { order_id: 'PAY-1' },
        payment: { cf_payment_id: '123', payment_status: 'SUCCESS' as const },
      },
    };
    const expected = createHash('sha256')
      .update(
        'PAYMENT_SUCCESS_WEBHOOK|PAY-1|123|SUCCESS|2026-08-20T11:16:10+05:30',
      )
      .digest('hex');

    expect(service.resolveEventId(payload, undefined)).toBe(expected);
    expect(service.resolveEventId(payload, undefined)).toBe(expected);
  });
});
