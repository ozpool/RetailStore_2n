-- ---------------------------------------------------------------------------
-- DEFERRED: not sent yet, and not a failure.
--
-- Quiet hours previously recorded SUPPRESSED, which is terminal — so a refund
-- notice that arrived at 3am was dropped, and the only honest thing to tell
-- the recipient at 8am was that it had been. Plan 0001 §6 says quiet hours
-- defer rather than drop, and this is the column that makes that true.
--
-- The status and the timestamp are added together deliberately: a DEFERRED row
-- with no notBefore is a message nothing will ever pick up, which is a drop
-- wearing a different name.
-- ---------------------------------------------------------------------------

-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'DEFERRED';

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "notBefore" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- The sweeper's entire query is "DEFERRED and due", and this is what keeps it
-- off a table scan. Without it the cost grows with every message ever
-- deferred; with it, it grows with what is actually owed right now — which on
-- a healthy system is a handful of rows for a few minutes after each window
-- closes, and zero the rest of the day.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "notification_deliveries_status_notBefore_idx" ON "notification_deliveries"("status", "notBefore");
