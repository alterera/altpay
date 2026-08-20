import {
  NotificationStatus,
  TaskType,
  TransactionStatus,
} from '../src/prisma/client';
import { HotelUnreachableError } from '../src/notifications/hotel-notifier.service';
import { PayFixture } from './helpers/pay-fixture';

describe('Cashfree webhooks and hotel notifications (e2e)', () => {
  const fixture = new PayFixture();

  beforeAll(async () => {
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  beforeEach(() => {
    fixture.hotel.reset();
    fixture.cashfree.paidAmount = 8700;
    fixture.cashfree.createCalls = 0;
  });

  const itDb = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (!fixture.dbUp) return;
      await fn();
    });
  };

  async function openSession() {
    const reference = fixture.newReference();
    const created = await fixture.postSession(fixture.sessionBody(reference));
    expect(created.status).toBe(201);
    return reference;
  }

  itDb(
    'processes a signed success webhook once and enqueues a hotel notification',
    async () => {
      const reference = await openSession();
      const payload = fixture.successPayload(reference);

      const first = await fixture.postWebhook(payload);
      const second = await fixture.postWebhook(payload);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        received: true,
        outcome: 'PROCESSED',
      });
      expect(second.status).toBe(200);
      expect((second.body as { outcome: string }).outcome).toBe('DUPLICATE');

      const transaction = await fixture.prisma.paymentTransaction.findUnique({
        where: { paymentReference: reference },
        include: { notifications: true },
      });
      expect(transaction?.status).toBe(TransactionStatus.SUCCESS);
      expect(transaction?.notifications).toHaveLength(1);
    },
  );

  itDb('rejects a webhook with a bad signature', async () => {
    const res = await fixture.postWebhook(fixture.successPayload('PAY-nope'), {
      secret: 'not-the-secret',
    });
    expect(res.status).toBe(401);
  });

  itDb(
    'marks the outbox delivered and opens a refund task when the hotel returns 202',
    async () => {
      const reference = await openSession();
      await fixture.postWebhook(fixture.successPayload(reference));

      const queued = await fixture.prisma.hotelNotification.findFirst({
        where: { paymentTransaction: { paymentReference: reference } },
      });
      expect(queued).toBeTruthy();

      fixture.hotel.response = {
        status: 202,
        body: { refundRequired: true, reservationStatus: 'EXPIRED' },
      };

      await expect(fixture.delivery.deliverOne(queued!.id)).resolves.toBe(true);

      const after = await fixture.prisma.hotelNotification.findUnique({
        where: { id: queued!.id },
      });
      expect(after?.status).toBe(NotificationStatus.DELIVERED);

      const task = await fixture.prisma.reconciliationTask.findFirst({
        where: { paymentTransactionId: queued!.paymentTransactionId },
      });
      expect(task?.taskType).toBe(TaskType.REFUND_REQUIRED);
    },
  );

  itDb(
    'retries when the hotel is unreachable, then gives up as needs-attention',
    async () => {
      const reference = await openSession();
      await fixture.postWebhook(fixture.successPayload(reference));
      const queued = await fixture.prisma.hotelNotification.findFirst({
        where: { paymentTransaction: { paymentReference: reference } },
      });

      fixture.hotel.failWith = new HotelUnreachableError('connection reset');

      // Six failed attempts exhausts the default retry budget.
      for (let i = 0; i < 6; i += 1) {
        await fixture.delivery.deliverOne(queued!.id);
      }

      const after = await fixture.prisma.hotelNotification.findUnique({
        where: { id: queued!.id },
      });
      expect(after?.status).toBe(NotificationStatus.NEEDS_ATTENTION);
    },
  );

  itDb(
    'does not notify the hotel when Cashfree reports a different amount',
    async () => {
      const reference = await openSession();
      fixture.cashfree.paidAmount = 1;

      const res = await fixture.postWebhook(fixture.successPayload(reference));

      expect(res.status).toBe(200);
      expect((res.body as { outcome: string }).outcome).toBe('NEEDS_ATTENTION');

      const transaction = await fixture.prisma.paymentTransaction.findUnique({
        where: { paymentReference: reference },
        include: { notifications: true },
      });
      expect(transaction?.status).toBe(TransactionStatus.NEEDS_ATTENTION);
      expect(transaction?.notifications).toHaveLength(0);
    },
  );

  itDb('repairs a paid order that never received a webhook', async () => {
    const reference = await openSession();
    const transaction = await fixture.prisma.paymentTransaction.findUnique({
      where: { paymentReference: reference },
    });
    expect(transaction).toBeTruthy();

    await expect(
      fixture.reconciliation.reconcileOne(transaction!),
    ).resolves.toBe(true);

    const after = await fixture.prisma.paymentTransaction.findUnique({
      where: { paymentReference: reference },
      include: { notifications: true },
    });
    expect(after?.status).toBe(TransactionStatus.SUCCESS);
    expect(after?.notifications).toHaveLength(1);
    expect(after?.notifications[0].eventType).toBe('PAYMENT_SUCCEEDED');
  });
});
