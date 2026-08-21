import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CashfreeClient,
  CashfreeError,
  CashfreeUnavailableError,
} from '../cashfree/cashfree.client';
import { Prisma, TransactionStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentConfig } from '../config/payment.config';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';

export const PROVIDER = 'CASHFREE';

export type PaymentSessionResult = {
  created: boolean;
  session: {
    paymentReference: string;
    paymentSessionId: string;
    providerOrderId: string;
    checkoutUrl: string;
    cashfreeMode: 'production' | 'sandbox';
    status: TransactionStatus;
    sessionExpiresAt: string | null;
  };
};

/** Statuses whose session is still worth handing back to a customer. */
const REUSABLE: readonly TransactionStatus[] = [
  TransactionStatus.CREATED,
  TransactionStatus.PENDING,
];

/**
 * Creates and cancels Cashfree checkout sessions.
 *
 * Idempotency rests on two unique constraints rather than on a read-then-write
 * check: `paymentReference` here, and Cashfree's own uniqueness on `order_id`.
 * Both point the same way, so a retried request converges on the one order that
 * already exists instead of minting a second one.
 */
@Injectable()
export class PaymentSessionsService {
  private readonly logger = new Logger(PaymentSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly config: PaymentConfig,
  ) {}

  async createSession(
    dto: CreatePaymentSessionDto,
  ): Promise<PaymentSessionResult> {
    const amount = new Prisma.Decimal(dto.amount);
    const transaction = await this.loadOrCreateDraft(dto, amount);

    // Same reference, different money means a caller bug, not a retry. Creating a
    // second order for it would let two amounts share one identity.
    if (
      !amount.equals(transaction.amount) ||
      dto.currency !== transaction.currency
    ) {
      throw new ConflictException(
        `${dto.paymentReference} already exists with a different amount`,
      );
    }

    if (
      REUSABLE.includes(transaction.status) &&
      transaction.paymentSessionId &&
      transaction.checkoutUrl
    ) {
      return {
        created: false,
        session: {
          paymentReference: transaction.paymentReference,
          paymentSessionId: transaction.paymentSessionId,
          providerOrderId: transaction.providerOrderId!,
          checkoutUrl: transaction.checkoutUrl,
          cashfreeMode: this.config.cashfreeMode,
          status: transaction.status,
          sessionExpiresAt: transaction.sessionExpiresAt?.toISOString() ?? null,
        },
      };
    }

    if (!REUSABLE.includes(transaction.status)) {
      throw new ConflictException(
        `${dto.paymentReference} is already ${transaction.status}`,
      );
    }

    const order = await this.createProviderOrder(dto);

    if (!order.payment_session_id || !order.order_id) {
      throw new BadGatewayException(
        'Cashfree did not return a usable payment session',
      );
    }

    const checkoutUrl = this.cashfree.buildCheckoutUrl(
      order.payment_session_id,
    );
    const sessionExpiresAt = order.order_expiry_time
      ? new Date(order.order_expiry_time)
      : new Date(dto.expiresAt);

    const updated = await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.PENDING,
        providerOrderId: order.order_id,
        paymentSessionId: order.payment_session_id,
        checkoutUrl,
        sessionExpiresAt,
      },
    });

    return {
      created: true,
      session: {
        paymentReference: updated.paymentReference,
        paymentSessionId: order.payment_session_id,
        providerOrderId: order.order_id,
        checkoutUrl,
        cashfreeMode: this.config.cashfreeMode,
        status: updated.status,
        sessionExpiresAt: sessionExpiresAt.toISOString(),
      },
    };
  }

  /**
   * Ends a session the hotel can no longer honour.
   *
   * Idempotent, and deliberately forgiving: Cashfree will not terminate an order
   * whose transaction has just succeeded, and that outcome is correct — the success
   * webhook still arrives and the hotel resolves it as a late payment.
   */
  async cancelSession(paymentReference: string): Promise<{
    paymentReference: string;
    status: TransactionStatus;
  }> {
    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { paymentReference },
    });

    if (!transaction) {
      throw new NotFoundException(
        `Unknown payment reference ${paymentReference}`,
      );
    }

    if (!REUSABLE.includes(transaction.status)) {
      return {
        paymentReference,
        status: transaction.status,
      };
    }

    if (transaction.providerOrderId) {
      try {
        await this.cashfree.terminateOrder(transaction.providerOrderId);
      } catch (error) {
        this.logger.warn(
          `Cashfree would not terminate ${transaction.providerOrderId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    const updated = await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.EXPIRED,
        failureReason: 'CANCELLED_BY_HOTEL',
      },
    });

    return { paymentReference, status: updated.status };
  }

  /**
   * Inserts a CREATED row, or returns the row another request already inserted
   * for the same `paymentReference`. The unique index is the lock; catching
   * P2002 is what makes concurrent retries converge instead of 500ing.
   */
  private async loadOrCreateDraft(
    dto: CreatePaymentSessionDto,
    amount: Prisma.Decimal,
  ) {
    const existing = await this.prisma.paymentTransaction.findUnique({
      where: { paymentReference: dto.paymentReference },
    });
    if (existing) return existing;

    try {
      return await this.prisma.paymentTransaction.create({
        data: {
          paymentReference: dto.paymentReference,
          reservationReference: dto.reservationReference,
          provider: PROVIDER,
          amount,
          currency: dto.currency,
          status: TransactionStatus.CREATED,
          customerName: dto.customer.name,
          customerPhone: dto.customer.phone,
          customerEmail: dto.customer.email,
          returnUrl: dto.returnUrl,
        },
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.paymentTransaction.findUnique({
        where: { paymentReference: dto.paymentReference },
      });
      if (!raced) throw error;
      return raced;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async createProviderOrder(dto: CreatePaymentSessionDto) {
    try {
      return await this.cashfree.createOrder({
        orderId: dto.paymentReference,
        amount: dto.amount,
        currency: dto.currency,
        reservationReference: dto.reservationReference,
        customerName: dto.customer.name,
        customerPhone: dto.customer.phone,
        customerEmail: dto.customer.email,
        returnUrl: dto.returnUrl,
        expiresAt: new Date(dto.expiresAt),
      });
    } catch (error) {
      if (error instanceof CashfreeUnavailableError) {
        throw new ServiceUnavailableException(
          'Cashfree is not reachable; please retry',
        );
      }
      if (error instanceof CashfreeError) {
        // A duplicate order_id means our own earlier attempt got through and only
        // the response was lost. Read the order back instead of failing the retry.
        if (error.status === 409) {
          return this.cashfree.fetchOrder(dto.paymentReference);
        }
        throw new BadGatewayException(
          `Cashfree rejected the order: ${error.message}`,
        );
      }
      throw error;
    }
  }
}
