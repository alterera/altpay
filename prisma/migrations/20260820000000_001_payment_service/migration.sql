-- Migration 001: payment service core tables

CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'NEEDS_ATTENTION');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED_PERMANENT', 'NEEDS_ATTENTION');
CREATE TYPE "TaskType" AS ENUM ('REFUND_REQUIRED', 'NEEDS_ATTENTION', 'HOTEL_REJECTED');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "paymentReference" TEXT NOT NULL,
    "reservationReference" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "paymentSessionId" TEXT,
    "checkoutUrl" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "returnUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "failureReason" TEXT,
    "lastReconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- The correlation key shared with the hotel backend. Uniqueness here is what makes
-- session creation idempotent: one reference can only ever mean one provider order.
CREATE UNIQUE INDEX "payment_transactions_paymentReference_key"
    ON "payment_transactions"("paymentReference");

CREATE UNIQUE INDEX "payment_transactions_provider_providerOrderId_key"
    ON "payment_transactions"("provider", "providerOrderId");

CREATE UNIQUE INDEX "payment_transactions_provider_providerPaymentId_key"
    ON "payment_transactions"("provider", "providerPaymentId");

CREATE INDEX "payment_transactions_reservationReference_idx"
    ON "payment_transactions"("reservationReference");

CREATE INDEX "payment_transactions_status_createdAt_idx"
    ON "payment_transactions"("status", "createdAt");

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingStatus" TEXT NOT NULL DEFAULT 'PROCESSING',
    "processingError" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- Duplicate provider deliveries collide here instead of being processed twice.
CREATE UNIQUE INDEX "webhook_events_provider_providerEventId_key"
    ON "webhook_events"("provider", "providerEventId");

CREATE INDEX "webhook_events_processingStatus_receivedAt_idx"
    ON "webhook_events"("processingStatus", "receivedAt");

CREATE TABLE "hotel_notifications" (
    "id" UUID NOT NULL,
    "paymentTransactionId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lastResponseStatus" INTEGER,
    "lastResponseBody" JSONB,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hotel_notifications_eventId_key"
    ON "hotel_notifications"("eventId");

CREATE INDEX "hotel_notifications_status_nextAttemptAt_idx"
    ON "hotel_notifications"("status", "nextAttemptAt");

ALTER TABLE "hotel_notifications"
    ADD CONSTRAINT "hotel_notifications_paymentTransactionId_fkey"
    FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reconciliation_tasks" (
    "id" UUID NOT NULL,
    "paymentTransactionId" UUID NOT NULL,
    "taskType" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "hotelResponseStatus" INTEGER,
    "hotelResponseBody" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "reconciliation_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reconciliation_tasks_status_createdAt_idx"
    ON "reconciliation_tasks"("status", "createdAt");

CREATE INDEX "reconciliation_tasks_paymentTransactionId_idx"
    ON "reconciliation_tasks"("paymentTransactionId");

ALTER TABLE "reconciliation_tasks"
    ADD CONSTRAINT "reconciliation_tasks_paymentTransactionId_fkey"
    FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
