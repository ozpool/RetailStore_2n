-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'PUSH', 'SMS');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "userId" TEXT NOT NULL,
    "notificationId" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "suppressReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- THE IDEMPOTENCY GUARD.
--
-- This is not an optimisation. The outbox relay and Kafka both deliver at least
-- once by design, so a redelivery is ordinary traffic — and the consumer inserts
-- this row BEFORE calling the provider, so a duplicate collides here and stops
-- instead of sending a second email.
--
-- Losing this index means duplicate messages on every relay restart and every
-- rolling deploy. See docs/adr/0026-delivery-idempotency.md
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "notification_deliveries_eventId_channel_key" ON "notification_deliveries"("eventId", "channel");

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_createdAt_idx" ON "notification_deliveries"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_createdAt_idx" ON "notification_deliveries"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_type_channel_key" ON "notification_preferences"("userId", "type", "channel");

-- CreateIndex
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- NO FOREIGN KEY ON notification_deliveries.userId, DELIBERATELY.
--
-- A delivery record is evidence that a message was sent to somebody, and it has
-- to survive the account being deleted for exactly the same reason a Report
-- survives the listing it reported: the question it answers ("did we email
-- them, and when?") is asked most often after something has gone wrong.
--
-- eventId is likewise not a foreign key. outbox_events rows are pruned once
-- published; the delivery record outlives them.
-- ---------------------------------------------------------------------------
