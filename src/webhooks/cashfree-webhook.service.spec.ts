import { CashfreeClient } from '../cashfree/cashfree.client';
import { WEBHOOK_SUCCESS } from '../cashfree/cashfree.types';
import { Prisma, TransactionStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashfreeWebhookService } from './cashfree-webhook.service';

const payload = {
  type: WEBHOOK_SUCCESS,
  event_time: '2026-08-20T11:16:10+05:30',
  data: {
    order: { order_id: 'PAY-1', order_amount: 8700, order_currency: 'INR' },
    payment: {
      cf_payment_id: '1453',
      payment_status: 'SUCCESS' as const,
      payment_group: 'upi',
      payment_time: '2026-08-20T12:20:29+05:30',
    },
  },
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentReference: 'PAY-1',
    reservationReference: 'ALTSTAY-1',
    provider: 'CASHFREE',
    amount: new Prisma.Decimal('8700.00'),
    currency: 'INR',
    status: TransactionStatus.PENDING,
    ...overrides,
  };
}

describe('CashfreeWebhookService', () => {
  let prisma: {
    webhookEvent: { create: jest.Mock; update: jest.Mock };
    paymentTransaction: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let cashfree: { fetchOrder: jest.Mock };
  let outbox: { enqueue: jest.Mock; openTask: jest.Mock };
  let service: CashfreeWebhookService;

  beforeEach(() => {
    prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-row' }),
        update: jest.fn().mockResolvedValue({}),
      },
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue(transaction()),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          paymentTransaction: {
            update: jest
              .fn()
              .mockResolvedValue(
                transaction({ status: TransactionStatus.SUCCESS }),
              ),
          },
        }),
      ),
    };
    cashfree = {
      fetchOrder: jest.fn().mockResolvedValue({
        order_status: 'PAID',
        order_amount: 8700,
        order_currency: 'INR',
      }),
    };
    outbox = {
      enqueue: jest.fn().mockResolvedValue('evt_1'),
      openTask: jest.fn(),
    };
    service = new CashfreeWebhookService(
      prisma as unknown as PrismaService,
      cashfree as unknown as CashfreeClient,
      outbox,
    );
  });

  it('stores the event, re-verifies with Cashfree, and enqueues one notification', async () => {
    await expect(service.handle('evt_1', payload)).resolves.toBe('PROCESSED');
    expect(cashfree.fetchOrder).toHaveBeenCalledWith('PAY-1');
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueCall = outbox.enqueue.mock.calls[0] as unknown as unknown[];
    expect(enqueueCall[2]).toBe('PAYMENT_SUCCEEDED');
  });

  it('treats a unique event-id collision as a duplicate and does not notify again', async () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.webhookEvent.create.mockRejectedValue(prismaError);

    await expect(service.handle('evt_1', payload)).resolves.toBe('DUPLICATE');
    expect(cashfree.fetchOrder).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does not notify the hotel when the provider amount disagrees', async () => {
    cashfree.fetchOrder.mockResolvedValue({
      order_status: 'PAID',
      order_amount: 1,
      order_currency: 'INR',
    });

    await expect(service.handle('evt_1', payload)).resolves.toBe(
      'NEEDS_ATTENTION',
    );
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(outbox.openTask).toHaveBeenCalled();
  });
});
