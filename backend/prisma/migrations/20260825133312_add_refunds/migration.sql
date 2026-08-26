-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundTrigger" AS ENUM ('SELLER_UNFULFILLABLE', 'ADMIN');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_ISSUED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "RefundTrigger" NOT NULL,
    "reason" TEXT NOT NULL,
    "initiatedById" TEXT,
    "provider" TEXT,
    "providerRefundId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");

-- CreateIndex
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- CreateIndex
CREATE INDEX "refunds_orderItemId_idx" ON "refunds"("orderItemId");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
