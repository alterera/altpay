import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentTransaction, Prisma, TaskType } from '../prisma/client';

export type HotelEventType = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';

/**
 * Transactional outbox writer.
 *
 * The point of the outbox is that recording a provider outcome and scheduling the
 * hotel notification are the same commit. There is no window where we know a
 * payment succeeded but have no plan to tell anyone.
 */
@Injectable()
export class NotificationOutboxService {
  /**
   * @param tx must be the transaction that is also writing the provider outcome
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    transaction: PaymentTransaction,
    eventType: HotelEventType,
    details: {
      providerPaymentId?: string | null;
      paymentMethod?: string | null;
      occurredAt: Date;
      failureReason?: string | null;
    },
  ): Promise<string> {
    const eventId = `evt_${randomUUID()}`;

    const payload = {
      eventId,
      eventType,
      paymentReference: transaction.paymentReference,
      reservationReference: transaction.reservationReference,
      provider: transaction.provider,
      providerOrderId: transaction.providerOrderId ?? undefined,
      providerPaymentId: details.providerPaymentId ?? undefined,
      // Decimal string, matching what the hotel stores and compares against.
      amount: transaction.amount.toFixed(2),
      currency: transaction.currency,
      paymentMethod: details.paymentMethod ?? undefined,
      occurredAt: details.occurredAt.toISOString(),
      failureReason: details.failureReason ?? null,
    };

    await tx.hotelNotification.create({
      data: {
        paymentTransactionId: transaction.id,
        eventId,
        eventType,
        payload: payload,
      },
    });

    return eventId;
  }

  /** Opens operator work. No HTTP surface in Phase B — these are read from the database. */
  async openTask(
    tx: Prisma.TransactionClient,
    paymentTransactionId: string,
    taskType: TaskType,
    notes: string,
    hotelResponse?: { status: number; body: unknown },
  ): Promise<void> {
    await tx.reconciliationTask.create({
      data: {
        paymentTransactionId,
        taskType,
        notes,
        hotelResponseStatus: hotelResponse?.status,
        hotelResponseBody: hotelResponse
          ? (hotelResponse.body as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }
}
