import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { CashfreeClient } from '../../src/cashfree/cashfree.client';
import { WEBHOOK_SUCCESS } from '../../src/cashfree/cashfree.types';
import { HotelNotifierService } from '../../src/notifications/hotel-notifier.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';

export type CreatedSession = {
  paymentReference: string;
  paymentSessionId: string;
  providerOrderId: string;
  checkoutUrl: string;
  status: string;
  sessionExpiresAt: string | null;
};

export class StubCashfree {
  createCalls = 0;
  paidAmount = 8700;

  async createOrder(input: { orderId: string; amount: string }) {
    this.createCalls += 1;
    await Promise.resolve();
    return {
      order_id: input.orderId,
      payment_session_id: `session_${input.orderId}`,
      order_status: 'ACTIVE' as const,
      order_amount: Number(input.amount),
      order_currency: 'INR',
      order_expiry_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  async fetchOrder(orderId: string) {
    await Promise.resolve();
    return {
      order_id: orderId,
      order_status: 'PAID' as const,
      order_amount: this.paidAmount,
      order_currency: 'INR',
    };
  }

  async fetchOrderPayments(orderId: string) {
    await Promise.resolve();
    return [
      {
        cf_payment_id: `cf_${orderId}`,
        payment_status: 'SUCCESS' as const,
        payment_group: 'upi',
        payment_time: new Date().toISOString(),
      },
    ];
  }

  async terminateOrder(orderId: string) {
    await Promise.resolve();
    return { order_id: orderId, order_status: 'TERMINATED' as const };
  }

  buildCheckoutUrl(paymentSessionId: string) {
    return `https://payments-test.cashfree.com/order/#${paymentSessionId}`;
  }
}

export class StubHotel {
  readonly calls: { eventId: string; payload: unknown }[] = [];
  response: { status: number; body: unknown } = {
    status: 200,
    body: { duplicate: false },
  };
  failWith?: Error;

  async send(eventId: string, payload: unknown) {
    this.calls.push({ eventId, payload });
    await Promise.resolve();
    if (this.failWith) throw this.failWith;
    return this.response;
  }

  reset() {
    this.calls.length = 0;
    this.response = { status: 200, body: { duplicate: false } };
    this.failWith = undefined;
  }
}

export class PayFixture {
  app!: INestApplication<App>;
  prisma!: PrismaService;
  cashfree = new StubCashfree();
  hotel = new StubHotel();
  delivery!: NotificationDeliveryService;
  reconciliation!: ReconciliationService;
  /** False when DATABASE_URL is set but the instance cannot be reached. */
  dbUp = false;

  private readonly tag = randomUUID().slice(0, 8);
  private readonly createdReferences: string[] = [];
  private readonly webhookEventIds: string[] = [];

  async setup(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    this.app = moduleRef.createNestApplication({ rawBody: true });
    this.app.setGlobalPrefix('api/v1');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await this.app.init();

    this.prisma = this.app.get(PrismaService);
    this.delivery = this.app.get(NotificationDeliveryService);
    this.reconciliation = this.app.get(ReconciliationService);

    const cashfree = this.app.get(CashfreeClient);
    Object.assign(cashfree, {
      createOrder: (input: { orderId: string; amount: string }) =>
        this.cashfree.createOrder(input),
      fetchOrder: (orderId: string) => this.cashfree.fetchOrder(orderId),
      fetchOrderPayments: (orderId: string) =>
        this.cashfree.fetchOrderPayments(orderId),
      terminateOrder: (orderId: string) =>
        this.cashfree.terminateOrder(orderId),
      buildCheckoutUrl: (id: string) => this.cashfree.buildCheckoutUrl(id),
    });

    const notifier = this.app.get(HotelNotifierService);
    Object.assign(notifier, {
      send: (eventId: string, payload: unknown) =>
        this.hotel.send(eventId, payload),
    });

    // Cron jobs share the process's database pool. Stop them so a tick cannot
    // lock rows or time out the suite's own queries.
    const scheduler = this.app.get(SchedulerRegistry);
    for (const name of [...scheduler.getCronJobs().keys()]) {
      scheduler.deleteCronJob(name);
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.dbUp = true;
    } catch {
      this.dbUp = false;
    }
  }

  get token(): string {
    return process.env.HOTEL_SERVICE_TOKEN!;
  }

  get webhookSecret(): string {
    return process.env.CASHFREE_CLIENT_SECRET!;
  }

  newReference(): string {
    const reference = `PAY-E2E-${this.tag}-${randomUUID().slice(0, 8)}`;
    this.createdReferences.push(reference);
    return reference;
  }

  sessionBody(paymentReference: string) {
    return {
      paymentReference,
      reservationReference: `ALTSTAY-E2E-${this.tag}`,
      amount: '8700.00',
      currency: 'INR',
      customer: { name: 'Asif Khan', phone: '9876543210' },
      returnUrl: `https://alterstays.e2e.invalid/booking/payment-result?ref=ALTSTAY-E2E-${this.tag}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  postSession(body: Record<string, unknown>, token = this.token) {
    const req = request(this.app.getHttpServer()).post(
      '/api/v1/payment-sessions',
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  }

  postCancel(paymentReference: string) {
    return request(this.app.getHttpServer())
      .post(
        `/api/v1/payment-sessions/${encodeURIComponent(paymentReference)}/cancel`,
      )
      .set('Authorization', `Bearer ${this.token}`)
      .send();
  }

  postWebhook(
    payload: object,
    tamper: { secret?: string; timestamp?: string } = {},
  ) {
    const raw = JSON.stringify(payload);
    const timestamp = tamper.timestamp ?? String(Date.now());
    const signature = createHmac('sha256', tamper.secret ?? this.webhookSecret)
      .update(timestamp)
      .update(raw)
      .digest('base64');

    const body = payload as {
      type?: string;
      event_time?: string;
      data?: {
        order?: { order_id?: string };
        payment?: { cf_payment_id?: string; payment_status?: string };
      };
    };
    this.webhookEventIds.push(
      createHash('sha256')
        .update(
          [
            body.type ?? '',
            body.data?.order?.order_id ?? '',
            String(body.data?.payment?.cf_payment_id ?? ''),
            body.data?.payment?.payment_status ?? '',
            body.event_time ?? '',
          ].join('|'),
        )
        .digest('hex'),
    );

    return request(this.app.getHttpServer())
      .post('/api/v1/webhooks/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-version', '2025-01-01')
      .send(raw);
  }

  successPayload(orderId: string) {
    return {
      type: WEBHOOK_SUCCESS,
      event_time: new Date().toISOString(),
      data: {
        order: {
          order_id: orderId,
          order_amount: 8700.0,
          order_currency: 'INR',
        },
        payment: {
          cf_payment_id: `cf_${orderId}`,
          payment_status: 'SUCCESS',
          payment_amount: 8700.0,
          payment_currency: 'INR',
          payment_group: 'upi',
          payment_time: new Date().toISOString(),
        },
      },
    };
  }

  async teardown(): Promise<void> {
    if (this.prisma) {
      if (this.createdReferences.length) {
        await this.prisma.paymentTransaction.deleteMany({
          where: { paymentReference: { in: this.createdReferences } },
        });
      }
      if (this.webhookEventIds.length) {
        await this.prisma.webhookEvent.deleteMany({
          where: { providerEventId: { in: this.webhookEventIds } },
        });
      }
    }
    if (this.app) await this.app.close();
  }
}
