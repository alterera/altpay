import { ConflictException } from '@nestjs/common';
import { CashfreeClient } from '../cashfree/cashfree.client';
import { PaymentConfig } from '../config/payment.config';
import { Prisma, TransactionStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { PaymentSessionsService } from './payment-sessions.service';

const dto: CreatePaymentSessionDto = {
  paymentReference: 'PAY-1',
  reservationReference: 'ALTSTAY-20260820-AAAAAA',
  amount: '8700.00',
  currency: 'INR',
  customer: { name: 'Asif Khan', phone: '9876543210' },
  returnUrl: 'https://alterstays.test/booking/payment-result?ref=X',
  expiresAt: '2026-08-20T07:10:00.000Z',
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentReference: 'PAY-1',
    reservationReference: dto.reservationReference,
    provider: 'CASHFREE',
    amount: new Prisma.Decimal('8700.00'),
    currency: 'INR',
    status: TransactionStatus.CREATED,
    paymentSessionId: null,
    checkoutUrl: null,
    providerOrderId: null,
    sessionExpiresAt: null,
    ...overrides,
  };
}

describe('PaymentSessionsService', () => {
  let prisma: {
    paymentTransaction: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let cashfree: {
    createOrder: jest.Mock;
    fetchOrder: jest.Mock;
    terminateOrder: jest.Mock;
    buildCheckoutUrl: jest.Mock;
  };
  let config: { cashfreeMode: 'sandbox' | 'production' };
  let service: PaymentSessionsService;

  beforeEach(() => {
    prisma = {
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(draft()),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve(
              draft({ ...data, status: TransactionStatus.PENDING }),
            ),
          ),
      },
    };
    cashfree = {
      createOrder: jest.fn().mockResolvedValue({
        order_id: 'PAY-1',
        payment_session_id: 'session_abc',
        order_expiry_time: dto.expiresAt,
      }),
      fetchOrder: jest.fn(),
      terminateOrder: jest
        .fn()
        .mockResolvedValue({ order_status: 'TERMINATED' }),
      buildCheckoutUrl: jest
        .fn()
        .mockReturnValue(
          'https://payments-test.cashfree.com/order/#session_abc',
        ),
    };
    config = { cashfreeMode: 'sandbox' };
    service = new PaymentSessionsService(
      prisma as unknown as PrismaService,
      cashfree as unknown as CashfreeClient,
      config as unknown as PaymentConfig,
    );
  });

  it('creates one Cashfree order and returns the checkout URL', async () => {
    const result = await service.createSession(dto);

    expect(result.created).toBe(true);
    expect(result.session.checkoutUrl).toContain('session_abc');
    expect(result.session.cashfreeMode).toBe('sandbox');
    expect(result.session.paymentSessionId).toBe('session_abc');
    expect(cashfree.createOrder).toHaveBeenCalledTimes(1);
    const [createArg] = cashfree.createOrder.mock.calls[0] as [
      { orderId: string; amount: string },
    ];
    expect(createArg).toMatchObject({
      orderId: 'PAY-1',
      amount: '8700.00',
    });
  });

  it('reuses a stored session without calling Cashfree again', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      draft({
        status: TransactionStatus.PENDING,
        paymentSessionId: 'session_abc',
        checkoutUrl: 'https://checkout/#session_abc',
        providerOrderId: 'PAY-1',
      }),
    );

    const result = await service.createSession(dto);

    expect(result.created).toBe(false);
    expect(cashfree.createOrder).not.toHaveBeenCalled();
  });

  it('rejects the same reference with a different amount', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      draft({ amount: new Prisma.Decimal('100.00') }),
    );

    await expect(service.createSession(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(cashfree.createOrder).not.toHaveBeenCalled();
  });

  it('is idempotent to cancel', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      draft({ status: TransactionStatus.EXPIRED, providerOrderId: 'PAY-1' }),
    );

    await expect(service.cancelSession('PAY-1')).resolves.toMatchObject({
      status: TransactionStatus.EXPIRED,
    });
    expect(cashfree.terminateOrder).not.toHaveBeenCalled();
  });
});
