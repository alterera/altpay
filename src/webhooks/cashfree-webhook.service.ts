import { Injectable, Logger } from '@nestjs/common';
import { CashfreeClient } from '../cashfree/cashfree.client';
import {
  CashfreeWebhookPayload,
  WEBHOOK_FAILED,
  WEBHOOK_SUCCESS,
  WEBHOOK_USER_DROPPED,
} from '../cashfree/cashfree.types';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import {
  PaymentTransaction,
  Prisma,
  TaskType,
  TransactionStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const PROVIDER = 'CASHFREE';

export type WebhookOutcome =
  'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'UNKNOWN_ORDER' | 'NEEDS_ATTENTION';

/**
 * Handles verified Cashfree webhooks.
 *
 * Two rules shape everything here. First, the payload is only a signal: the
 * outcome is re-read from Cashfree's own order API, so a replayed or crafted body
 * cannot confirm a booking on its own. Second, storage is the acknowledgement —
 * once the event row is committed we answer 200 so Cashfree stops redelivering,
 * and any further work happens on our schedule.
 */
@Injectable()
export class CashfreeWebhookService {
  private readonly logger = new Logger(CashfreeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly outbox: NotificationOutboxService,
  ) {}

  async handle(
    eventId: string,
    payload: CashfreeWebhookPayload,
  ): Promise<WebhookOutcome> {
    let eventRowId: string;
    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          provider: PROVIDER,
          providerEventId: eventId,
          eventType: payload.type,
          signatureVerified: true,
          payload: payload,
        },
        select: { id: true },
      });
      eventRowId = created.id;
    } catch (error) {
      if (this.isUniqueViolation(error)) return 'DUPLICATE';
      throw error;
    }

    const outcome = await this.process(payload);
    await this.prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: {
        processingStatus: outcome === 'PROCESSED' ? 'PROCESSED' : outcome,
        processedAt: new Date(),
      },
    });

    return outcome;
  }

  private async process(
    payload: CashfreeWebhookPayload,
  ): Promise<WebhookOutcome> {
    const orderId = payload.data?.order?.order_id;
    if (!orderId) return 'IGNORED';

    const eventType = payload.type;
    const isSuccess = eventType === WEBHOOK_SUCCESS;
    const isFailure =
      eventType === WEBHOOK_FAILED || eventType === WEBHOOK_USER_DROPPED;

    if (!isSuccess && !isFailure) {
      this.logger.log(`Ignoring Cashfree event type ${eventType ?? 'unknown'}`);
      return 'IGNORED';
    }

    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { paymentReference: orderId },
    });

    if (!transaction) {
      // Stored and acknowledged, but nothing to act on — an order created outside
      // this service, or a stale event after a database restore.
      this.logger.error(`Webhook for unknown payment reference ${orderId}`);
      return 'UNKNOWN_ORDER';
    }

    return isSuccess
      ? this.processSuccess(transaction, payload)
      : this.processFailure(transaction, payload);
  }

  private async processSuccess(
    transaction: PaymentTransaction,
    payload: CashfreeWebhookPayload,
  ): Promise<WebhookOutcome> {
    // The payload said success; Cashfree's order record has to agree.
    const order = await this.cashfree.fetchOrder(transaction.paymentReference);

    if (order.order_status !== 'PAID') {
      await this.flagForAttention(
        transaction,
        `Webhook reported success but Cashfree order is ${order.order_status ?? 'unknown'}`,
      );
      return 'NEEDS_ATTENTION';
    }

    const amountMatches =
      order.order_amount !== undefined &&
      new Prisma.Decimal(order.order_amount).equals(transaction.amount);
    const currencyMatches =
      order.order_currency === undefined ||
      order.order_currency === transaction.currency;

    if (!amountMatches || !currencyMatches) {
      await this.flagForAttention(
        transaction,
        `Provider amount ${order.order_amount ?? '?'} ${order.order_currency ?? '?'} ` +
          `does not match ${transaction.amount.toFixed(2)} ${transaction.currency}`,
      );
      return 'NEEDS_ATTENTION';
    }

    if (transaction.status === TransactionStatus.SUCCESS) {
      // A different event for a payment already settled. The outbox row from the
      // first one carries the truth; a second would double-notify.
      return 'DUPLICATE';
    }

    const payment = payload.data?.payment;
    const providerPaymentId = payment?.cf_payment_id
      ? String(payment.cf_payment_id)
      : null;
    const occurredAt = this.parseTime(
      payment?.payment_time ?? payload.event_time,
    );

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.SUCCESS,
          providerPaymentId,
          paymentMethod: payment?.payment_group ?? null,
          paidAt: occurredAt,
          failureReason: null,
        },
      });

      await this.outbox.enqueue(tx, updated, 'PAYMENT_SUCCEEDED', {
        providerPaymentId,
        paymentMethod: payment?.payment_group ?? null,
        occurredAt,
      });
    });

    return 'PROCESSED';
  }

  private async processFailure(
    transaction: PaymentTransaction,
    payload: CashfreeWebhookPayload,
  ): Promise<WebhookOutcome> {
    if (transaction.status === TransactionStatus.SUCCESS) {
      // Out-of-order delivery. A settled payment is not un-settled by a later
      // failure report for an earlier attempt on the same order.
      this.logger.warn(
        `Ignoring failure event for already-successful ${transaction.paymentReference}`,
      );
      return 'IGNORED';
    }
    if (transaction.status === TransactionStatus.FAILED) return 'DUPLICATE';

    const payment = payload.data?.payment;
    const providerPaymentId = payment?.cf_payment_id
      ? String(payment.cf_payment_id)
      : null;
    const occurredAt = this.parseTime(
      payment?.payment_time ?? payload.event_time,
    );
    const failureReason =
      payload.data?.error_details?.error_description ??
      payment?.payment_message ??
      payment?.payment_status ??
      'PROVIDER_REPORTED_FAILURE';

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.FAILED,
          providerPaymentId,
          paymentMethod: payment?.payment_group ?? null,
          failureReason,
        },
      });

      await this.outbox.enqueue(tx, updated, 'PAYMENT_FAILED', {
        providerPaymentId,
        paymentMethod: payment?.payment_group ?? null,
        occurredAt,
        failureReason,
      });
    });

    return 'PROCESSED';
  }

  /** Never notifies the hotel: a disagreement with the provider needs a human first. */
  private async flagForAttention(
    transaction: PaymentTransaction,
    notes: string,
  ): Promise<void> {
    this.logger.error(`${transaction.paymentReference}: ${notes}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.NEEDS_ATTENTION,
          failureReason: notes.slice(0, 500),
        },
      });
      await this.outbox.openTask(
        tx,
        transaction.id,
        TaskType.NEEDS_ATTENTION,
        notes,
      );
    });
  }

  private parseTime(value: string | undefined): Date {
    if (!value) return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
