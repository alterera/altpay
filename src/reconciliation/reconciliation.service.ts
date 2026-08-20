import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CashfreeClient } from '../cashfree/cashfree.client';
import { PaymentConfig } from '../config/payment.config';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import {
  PaymentTransaction,
  Prisma,
  TaskType,
  TransactionStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 25;

/**
 * Repairs transactions that a webhook never resolved.
 *
 * Webhooks are best-effort by nature: Cashfree can drop one, we can be down when
 * it fires, or a network can swallow it. Without this job a customer's money would
 * sit paid at the provider while their booking silently expired, and nobody would
 * find out until they complained. Polling makes the provider the source of truth
 * on our own schedule rather than the provider's.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly outbox: NotificationOutboxService,
    private readonly config: PaymentConfig,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileStuck(): Promise<number> {
    try {
      return await this.reconcileStuckUnsafe();
    } catch (error) {
      this.logger.error(
        `Reconciliation tick failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }

  private async reconcileStuckUnsafe(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.reconcileAfterMs);

    const stuck = await this.prisma.paymentTransaction.findMany({
      where: {
        status: TransactionStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    let repaired = 0;
    for (const transaction of stuck) {
      try {
        if (await this.reconcileOne(transaction)) repaired += 1;
      } catch (error) {
        // One unreachable order must not stop the batch.
        this.logger.warn(
          `Could not reconcile ${transaction.paymentReference}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    return repaired;
  }

  /** @returns true when the provider's record moved this transaction on */
  async reconcileOne(transaction: PaymentTransaction): Promise<boolean> {
    const order = await this.cashfree.fetchOrder(transaction.paymentReference);

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: { lastReconciledAt: new Date() },
    });

    if (order.order_status === 'PAID') {
      return this.repairMissedSuccess(transaction, order.order_amount);
    }

    if (
      order.order_status === 'EXPIRED' ||
      order.order_status === 'TERMINATED'
    ) {
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.EXPIRED,
          failureReason: `PROVIDER_${order.order_status}`,
        },
      });
      // No notification: the hotel's own hold expiry already covers an unpaid order.
      return true;
    }

    return false;
  }

  private async repairMissedSuccess(
    transaction: PaymentTransaction,
    orderAmount: number | undefined,
  ): Promise<boolean> {
    if (
      orderAmount === undefined ||
      !new Prisma.Decimal(orderAmount).equals(transaction.amount)
    ) {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentTransaction.update({
          where: { id: transaction.id },
          data: {
            status: TransactionStatus.NEEDS_ATTENTION,
            failureReason: `Reconciled amount ${orderAmount ?? '?'} does not match ${transaction.amount.toFixed(2)}`,
          },
        });
        await this.outbox.openTask(
          tx,
          transaction.id,
          TaskType.NEEDS_ATTENTION,
          'Reconciliation found a paid order with a mismatched amount',
        );
      });
      return true;
    }

    const payments = await this.cashfree.fetchOrderPayments(
      transaction.paymentReference,
    );
    const successful = payments.find(
      (payment) => payment.payment_status === 'SUCCESS',
    );

    const providerPaymentId = successful?.cf_payment_id
      ? String(successful.cf_payment_id)
      : null;
    const paidAt = successful?.payment_time
      ? new Date(successful.payment_time)
      : new Date();

    this.logger.warn(
      `Reconciliation found ${transaction.paymentReference} paid with no webhook; notifying the hotel`,
    );

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.SUCCESS,
          providerPaymentId,
          paymentMethod: successful?.payment_group ?? null,
          paidAt,
        },
      });

      await this.outbox.enqueue(tx, updated, 'PAYMENT_SUCCEEDED', {
        providerPaymentId,
        paymentMethod: successful?.payment_group ?? null,
        occurredAt: paidAt,
      });
    });

    return true;
  }
}
