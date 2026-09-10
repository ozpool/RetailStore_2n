-- ---------------------------------------------------------------------------
-- Paying sellers. Phase 1 of docs/plans/0002-seller-payouts.md.
--
-- NOTHING IN CHECKOUT CHANGES. The buyer's payment still goes to the platform
-- as a single PaymentIntent; these tables record money moving onward
-- afterwards. That is the whole reason separate transfers were chosen over
-- destination charges — see ADR 0029.
--
-- TWO GATE COLUMNS, NOT ONE. payoutsEnabled is this platform's own
-- verification decision; payoutsReady mirrors whether Stripe will actually
-- move money to the account. Both must be true before a transfer is attempted.
-- Collapsing them would either pay out to an account Stripe rejects, or let a
-- payments provider quietly reinstate a seller moderation had blocked.
-- See ADR 0030.
-- ---------------------------------------------------------------------------


-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "connectAccountId" TEXT,
ADD COLUMN     "connectOnboardedAt" TIMESTAMP(3),
ADD COLUMN     "payoutsReady" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "nettedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerTransferId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_items" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "providerReversalId" TEXT,

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_debts" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL,
    "orderItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "payout_debts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_providerTransferId_key" ON "payouts"("providerTransferId");

-- CreateIndex
CREATE INDEX "payouts_sellerId_createdAt_idx" ON "payouts"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_items_orderItemId_key" ON "payout_items"("orderItemId");

-- CreateIndex
CREATE INDEX "payout_items_payoutId_idx" ON "payout_items"("payoutId");

-- CreateIndex
CREATE INDEX "payout_debts_sellerId_settledAt_idx" ON "payout_debts"("sellerId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_connectAccountId_key" ON "seller_profiles"("connectAccountId");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_debts" ADD CONSTRAINT "payout_debts_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- payout_items.orderItemId IS UNIQUE, AND THAT CONSTRAINT IS THE FEATURE.
--
-- An order item can appear in at most one payout. A second run that tries to
-- include an already-paid line collides here rather than depending on the code
-- above it checking in the right order — the same discipline as the delivery
-- ledger's unique (eventId, channel) in ADR 0026, and for the same reason:
-- paying a seller twice is not recoverable by an apology.
--
-- It is deliberately NOT a foreign key to order_items. A payout statement has
-- to stay readable after a listing is deleted, which is why
-- order_items.listingId is already nullable.
-- ---------------------------------------------------------------------------
