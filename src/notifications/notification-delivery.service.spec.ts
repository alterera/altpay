import { PaymentConfig } from '../config/payment.config';
import { NotificationStatus, TaskType } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  HotelNotifierService,
  HotelUnreachableError,
} from './hotel-notifier.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import type { NotificationOutboxService } from './notification-outbox.service';

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    paymentTransactionId: 'tx-1',
    eventId: 'evt_1',
    eventType: 'PAYMENT_SUCCEEDED',
    payload: { eventId: 'evt_1' },
    status: NotificationStatus.PENDING,
    attempts: 0,
    ...overrides,
  };
}

type UpdateArg = { data: Record<string, unknown> };

describe('NotificationDeliveryService', () => {
  let prisma: {
    hotelNotification: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifier: { send: jest.Mock };
  let outbox: { openTask: jest.Mock };
  let config: PaymentConfig;
  let service: NotificationDeliveryService;

  beforeEach(() => {
    prisma = {
      hotelNotification: {
        findUnique: jest.fn().mockResolvedValue(notification()),
        update: jest.fn().mockResolvedValue(notification()),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({}),
      ),
    };
    notifier = { send: jest.fn() };
    outbox = { openTask: jest.fn().mockResolvedValue(undefined) };
    config = {
      notificationMaxAttempts: 6,
      backoffSecondsForAttempt: () => 30,
    } as unknown as PaymentConfig;
    service = new NotificationDeliveryService(
      prisma as unknown as PrismaService,
      notifier as unknown as HotelNotifierService,
      outbox as unknown as NotificationOutboxService,
      config,
    );
  });

  function lastUpdate(): UpdateArg {
    const [arg] = prisma.hotelNotification.update.mock.calls.at(-1) as [
      UpdateArg,
    ];
    return arg;
  }

  function lastTaskType(): TaskType {
    const call = outbox.openTask.mock.calls.at(-1) as unknown as unknown[];
    return call[2] as TaskType;
  }

  it('marks a 200 as delivered', async () => {
    notifier.send.mockResolvedValue({ status: 200, body: { ok: true } });

    await expect(service.deliverOne('n-1')).resolves.toBe(true);
    expect(lastUpdate().data.status).toBe(NotificationStatus.DELIVERED);
    expect(outbox.openTask).not.toHaveBeenCalled();
  });

  it('treats 202 as delivered and opens a refund task', async () => {
    notifier.send.mockResolvedValue({
      status: 202,
      body: { refundRequired: true },
    });

    await expect(service.deliverOne('n-1')).resolves.toBe(true);
    expect(lastUpdate().data.status).toBe(NotificationStatus.DELIVERED);
    expect(lastTaskType()).toBe(TaskType.REFUND_REQUIRED);
  });

  it('reschedules a 409 without marking it delivered', async () => {
    notifier.send.mockResolvedValue({ status: 409, body: {} });

    await expect(service.deliverOne('n-1')).resolves.toBe(false);
    expect(lastUpdate().data.lastError).toBe(
      'Hotel reported the event still in flight',
    );
  });

  it('stops on a 422 and opens a hotel-rejected task', async () => {
    notifier.send.mockResolvedValue({
      status: 422,
      body: { message: 'amount mismatch' },
    });

    await expect(service.deliverOne('n-1')).resolves.toBe(false);
    expect(lastUpdate().data.status).toBe(NotificationStatus.FAILED_PERMANENT);
    expect(lastTaskType()).toBe(TaskType.HOTEL_REJECTED);
  });

  it('gives up after the configured attempts and opens a needs-attention task', async () => {
    prisma.hotelNotification.findUnique.mockResolvedValue(
      notification({ attempts: 5 }),
    );
    notifier.send.mockRejectedValue(new HotelUnreachableError('timeout'));

    await expect(service.deliverOne('n-1')).resolves.toBe(false);
    expect(lastUpdate().data.status).toBe(NotificationStatus.NEEDS_ATTENTION);
  });
});
