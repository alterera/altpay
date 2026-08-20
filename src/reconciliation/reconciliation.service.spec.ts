import { CashfreeClient } from '../cashfree/cashfree.client';
import { PaymentConfig } from '../config/payment.config';
import { Prisma, TransactionStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from './reconciliation.service';

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentReference: 'PAY-1',
    amount: new Prisma.Decimal('8700.00'),
    currency: 'INR',
    status: TransactionStatus.PENDING,
    ...overrides,
  };
}

describe('ReconciliationService', () => {
  let prisma: {
    paymentTransaction: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let cashfree: { fetchOrder: jest.Mock; fetchOrderPayments: jest.Mock };
  let outbox: { enqueue: jest.Mock; openTask: jest.Mock };
  let service: ReconciliationService;

  beforeEach(() => {
    prisma = {
      paymentTransaction: {
        update: jest.fn().mockResolvedValue({}),
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
      fetchOrder: jest.fn(),
      fetchOrderPayments: jest.fn().mockResolvedValue([
        {
          cf_payment_id: '1453',
          payment_status: 'SUCCESS',
          payment_group: 'upi',
          payment_time: '2026-08-20T12:20:29+05:30',
        },
      ]),
    };
    outbox = {
      enqueue: jest.fn().mockResolvedValue('evt_1'),
      openTask: jest.fn(),
    };
    service = new ReconciliationService(
      prisma as unknown as PrismaService,
      cashfree as unknown as CashfreeClient,
      outbox,
      { reconcileAfterMs: 10 * 60 * 1000 } as PaymentConfig,
    );
  });

  it('notifies the hotel when Cashfree says paid and no webhook arrived', async () => {
    cashfree.fetchOrder.mockResolvedValue({
      order_status: 'PAID',
      order_amount: 8700,
    });

    await expect(service.reconcileOne(transaction())).resolves.toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'PAYMENT_SUCCEEDED',
      expect.any(Object),
    );
  });

  it('marks an unpaid expired order without notifying the hotel', async () => {
    cashfree.fetchOrder.mockResolvedValue({ order_status: 'EXPIRED' });

    await expect(service.reconcileOne(transaction())).resolves.toBe(true);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    const [updateArg] = prisma.paymentTransaction.update.mock.calls.at(-1) as [
      { data: { status: TransactionStatus } },
    ];
    expect(updateArg.data.status).toBe(TransactionStatus.EXPIRED);
  });
});
