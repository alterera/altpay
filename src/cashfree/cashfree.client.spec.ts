import {
  CASHFREE_MAX_ORDER_TTL_MS,
  CASHFREE_MIN_ORDER_TTL_MS,
  resolveCashfreeOrderExpiry,
} from './cashfree.client';

describe('resolveCashfreeOrderExpiry', () => {
  const now = new Date('2026-08-21T08:00:00.000Z');

  it('keeps hold expiry when it is already beyond Cashfree minimum', () => {
    const holdExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    expect(resolveCashfreeOrderExpiry(holdExpiresAt, now)).toEqual(holdExpiresAt);
  });

  it('raises short hold expiry to the Cashfree minimum window', () => {
    const holdExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    expect(resolveCashfreeOrderExpiry(holdExpiresAt, now)).toEqual(
      new Date(now.getTime() + CASHFREE_MIN_ORDER_TTL_MS),
    );
  });

  it('caps expiry at Cashfree maximum window', () => {
    const holdExpiresAt = new Date(now.getTime() + CASHFREE_MAX_ORDER_TTL_MS + 60_000);
    expect(resolveCashfreeOrderExpiry(holdExpiresAt, now)).toEqual(
      new Date(now.getTime() + CASHFREE_MAX_ORDER_TTL_MS),
    );
  });
});
