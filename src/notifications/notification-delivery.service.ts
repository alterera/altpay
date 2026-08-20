import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentConfig } from '../config/payment.config';
import { NotificationStatus, Prisma, TaskType } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  HotelNotifierService,
  HotelResponse,
  HotelUnreachableError,
} from './hotel-notifier.service';
import { NotificationOutboxService } from './notification-outbox.service';

const BATCH_SIZE = 20;

/**
 * Drains the outbox.
 *
 * The hotel's status code is the whole retry contract, so the mapping is kept in
 * one place:
 *
 * | Status | Meaning                                    | Action                          |
 * |--------|--------------------------------------------|---------------------------------|
 * | 200    | processed                                  | delivered                       |
 * | 202    | captured but not confirmable               | delivered + refund task         |
 * | 409    | an earlier delivery is still in flight      | reschedule                      |
 * | 4xx    | permanently rejected                       | stop, open an operator task     |
 * | 5xx    | transient                                  | reschedule with backoff         |
 *
 * 202 counting as delivered is the subtle one: the hotel has made its final
 * decision, so retrying cannot change anything. What is left is a refund, which is
 * operator work rather than a delivery problem.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: HotelNotifierService,
    private readonly outbox: NotificationOutboxService,
    private readonly config: PaymentConfig,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async deliverDue(): Promise<number> {
    try {
      const claimed = await this.claimDue();

      let delivered = 0;
      for (const notification of claimed) {
        if (await this.deliverOne(notification.id)) delivered += 1;
      }
      return delivered;
    } catch (error) {
      this.logger.error(
        `Delivery tick failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }

  /**
   * Takes a lease on due rows with `FOR UPDATE SKIP LOCKED` so two workers cannot
   * deliver the same event. The lease is a 60-second bump of `nextAttemptAt`; if
   * this process dies after claiming, the row becomes eligible again.
   */
  async claimDue(): Promise<{ id: string }[]> {
    return this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "hotel_notifications" AS n
      SET
        "nextAttemptAt" = NOW() + INTERVAL '60 seconds',
        "lastAttemptAt" = NOW()
      FROM (
        SELECT id
        FROM "hotel_notifications"
        WHERE status = 'PENDING'::"NotificationStatus"
          AND "nextAttemptAt" <= NOW()
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) AS claimed
      WHERE n.id = claimed.id
      RETURNING n.id
    `;
  }

  /** @returns true when the notification reached a terminal delivered state */
  async deliverOne(notificationId: string): Promise<boolean> {
    const notification = await this.prisma.hotelNotification.findUnique({
      where: { id: notificationId },
    });
    if (!notification || notification.status !== NotificationStatus.PENDING) {
      return false;
    }

    const attempt = notification.attempts + 1;
    let response: HotelResponse;

    try {
      response = await this.notifier.send(
        notification.eventId,
        notification.payload,
      );
    } catch (error) {
      if (error instanceof HotelUnreachableError) {
        await this.reschedule(notificationId, attempt, error.message);
        return false;
      }
      throw error;
    }

    if (response.status === 200 || response.status === 202) {
      await this.markDelivered(notification.id, attempt, response);

      if (response.status === 202) {
        await this.openRefundTask(
          notification.paymentTransactionId,
          notification.eventId,
          response,
        );
      }
      return true;
    }

    if (response.status === 409) {
      // The hotel is still finishing an earlier delivery of this same event.
      await this.reschedule(
        notificationId,
        attempt,
        'Hotel reported the event still in flight',
      );
      return false;
    }

    if (response.status >= 400 && response.status < 500) {
      await this.markPermanentlyFailed(notification.id, attempt, response);
      await this.openTask(
        notification.paymentTransactionId,
        TaskType.HOTEL_REJECTED,
        `Hotel permanently rejected ${notification.eventId} with ${response.status}`,
        response,
      );
      return false;
    }

    await this.reschedule(
      notificationId,
      attempt,
      `Hotel returned ${response.status}`,
      response,
    );
    return false;
  }

  private async reschedule(
    notificationId: string,
    attempt: number,
    error: string,
    response?: HotelResponse,
  ): Promise<void> {
    if (attempt >= this.config.notificationMaxAttempts) {
      const notification = await this.prisma.hotelNotification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.NEEDS_ATTENTION,
          attempts: attempt,
          lastAttemptAt: new Date(),
          lastError: error,
          lastResponseStatus: response?.status,
          lastResponseBody: this.asJson(response?.body),
        },
      });

      this.logger.error(
        `Giving up on ${notification.eventId} after ${attempt} attempts: ${error}`,
      );
      await this.openTask(
        notification.paymentTransactionId,
        TaskType.NEEDS_ATTENTION,
        `Undeliverable after ${attempt} attempts: ${error}`,
        response,
      );
      return;
    }

    const delayMs = this.config.backoffSecondsForAttempt(attempt) * 1000;
    await this.prisma.hotelNotification.update({
      where: { id: notificationId },
      data: {
        attempts: attempt,
        lastAttemptAt: new Date(),
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: error,
        lastResponseStatus: response?.status,
        lastResponseBody: this.asJson(response?.body),
      },
    });
  }

  private async markDelivered(
    notificationId: string,
    attempt: number,
    response: HotelResponse,
  ): Promise<void> {
    await this.prisma.hotelNotification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.DELIVERED,
        attempts: attempt,
        lastAttemptAt: new Date(),
        deliveredAt: new Date(),
        lastError: null,
        lastResponseStatus: response.status,
        lastResponseBody: this.asJson(response.body),
      },
    });
  }

  private async markPermanentlyFailed(
    notificationId: string,
    attempt: number,
    response: HotelResponse,
  ): Promise<void> {
    await this.prisma.hotelNotification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.FAILED_PERMANENT,
        attempts: attempt,
        lastAttemptAt: new Date(),
        lastError: `Hotel returned ${response.status}`,
        lastResponseStatus: response.status,
        lastResponseBody: this.asJson(response.body),
      },
    });
  }

  private async openRefundTask(
    paymentTransactionId: string,
    eventId: string,
    response: HotelResponse,
  ): Promise<void> {
    const refundRequired =
      typeof response.body === 'object' &&
      response.body !== null &&
      (response.body as { refundRequired?: unknown }).refundRequired === true;

    await this.openTask(
      paymentTransactionId,
      refundRequired ? TaskType.REFUND_REQUIRED : TaskType.NEEDS_ATTENTION,
      `Hotel accepted ${eventId} but could not confirm the booking`,
      response,
    );
  }

  private async openTask(
    paymentTransactionId: string,
    taskType: TaskType,
    notes: string,
    response?: HotelResponse,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.openTask(
        tx,
        paymentTransactionId,
        taskType,
        notes,
        response ? { status: response.status, body: response.body } : undefined,
      );
    });
  }

  private asJson(body: unknown): Prisma.InputJsonValue | undefined {
    if (body === undefined || body === null) return undefined;
    return body;
  }
}
