import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { ServiceTokenGuard } from './auth/service-token.guard';
import { CashfreeClient } from './cashfree/cashfree.client';
import { PaymentConfig } from './config/payment.config';
import { HotelNotifierService } from './notifications/hotel-notifier.service';
import { NotificationDeliveryService } from './notifications/notification-delivery.service';
import { NotificationOutboxService } from './notifications/notification-outbox.service';
import { PaymentSessionsController } from './payments/payment-sessions.controller';
import { PaymentSessionsService } from './payments/payment-sessions.service';
import { PrismaModule } from './prisma/prisma.module';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { CashfreeSignatureService } from './webhooks/cashfree-signature.service';
import { CashfreeWebhookController } from './webhooks/cashfree-webhook.controller';
import { CashfreeWebhookService } from './webhooks/cashfree-webhook.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
  ],
  controllers: [
    AppController,
    PaymentSessionsController,
    CashfreeWebhookController,
  ],
  providers: [
    PaymentConfig,
    ServiceTokenGuard,
    CashfreeClient,
    CashfreeSignatureService,
    CashfreeWebhookService,
    PaymentSessionsService,
    NotificationOutboxService,
    HotelNotifierService,
    NotificationDeliveryService,
    ReconciliationService,
  ],
})
export class AppModule {}
