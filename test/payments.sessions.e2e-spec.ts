import { TransactionStatus } from '../src/prisma/client';
import { CreatedSession, PayFixture } from './helpers/pay-fixture';

describe('Payment sessions (e2e)', () => {
  const fixture = new PayFixture();

  beforeAll(async () => {
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  const itDb = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (!fixture.dbUp) return;
      await fn();
    });
  };

  itDb('creates a Cashfree order and returns a checkout URL', async () => {
    const reference = fixture.newReference();
    const res = await fixture.postSession(fixture.sessionBody(reference));

    expect(res.status).toBe(201);
    const session = res.body as CreatedSession;
    expect(session).toMatchObject({
      paymentReference: reference,
      status: TransactionStatus.PENDING,
    });
    expect(session.checkoutUrl).toContain('payments-test.cashfree.com');
    expect(fixture.cashfree.createCalls).toBe(1);
  });

  itDb(
    'reuses the same provider order for a retried paymentReference',
    async () => {
      const reference = fixture.newReference();
      const body = fixture.sessionBody(reference);
      fixture.cashfree.createCalls = 0;

      const first = await fixture.postSession(body);
      const second = await fixture.postSession(body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect((second.body as CreatedSession).paymentReference).toBe(
        (first.body as CreatedSession).paymentReference,
      );
      expect(fixture.cashfree.createCalls).toBe(1);
    },
  );

  itDb('rejects the same reference with a different amount', async () => {
    const reference = fixture.newReference();
    await fixture.postSession(fixture.sessionBody(reference));

    const res = await fixture.postSession({
      ...fixture.sessionBody(reference),
      amount: '1.00',
    });

    expect(res.status).toBe(409);
  });

  itDb('cancels an unused session idempotently', async () => {
    const reference = fixture.newReference();
    await fixture.postSession(fixture.sessionBody(reference));

    const first = await fixture.postCancel(reference);
    const second = await fixture.postCancel(reference);

    expect(first.status).toBe(200);
    expect((first.body as { status: string }).status).toBe(
      TransactionStatus.EXPIRED,
    );
    expect(second.status).toBe(200);
    expect((second.body as { status: string }).status).toBe(
      TransactionStatus.EXPIRED,
    );
  });

  itDb('rejects a missing bearer token', async () => {
    const res = await fixture.postSession(
      fixture.sessionBody(fixture.newReference()),
      '',
    );
    expect(res.status).toBe(401);
  });
});
