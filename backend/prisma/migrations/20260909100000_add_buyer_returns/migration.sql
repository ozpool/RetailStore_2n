-- Buyer-initiated returns. See docs/adr/0031-buyer-initiated-returns.md
--
-- A return is a REQUEST that may be answered no, so it is its own table rather
-- than a status on `refunds`. Approving one inserts an ordinary refund row with
-- the new BUYER_RETURN trigger, which is why nothing about the existing refund
-- machinery — the over-refund guard, the provider call, the payout reversal —
-- has to change.

-- The third way money can go back.
ALTER TYPE "RefundTrigger" ADD VALUE 'BUYER_RETURN';

CREATE TYPE "ReturnStatus" AS ENUM (
  'OPEN', 'APPROVED', 'REFUSED', 'ESCALATED', 'REJECTED', 'WITHDRAWN'
);

CREATE TABLE "return_requests" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "notAsDescribed" BOOLEAN NOT NULL DEFAULT false,
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "refundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- THE LOAD-BEARING INDEX.
--
-- One request per line, enforced here rather than by a read-then-write check.
-- Two taps on "Start a return" race; the second collides with this constraint
-- and rolls back instead of opening a rival request against the same item.
-- Identical reasoning to payout_items.orderItemId (ADR 0030), and deliberately
-- NOT a foreign key for the same reason: a return statement has to stay
-- readable after a listing is gone, and order_items.listingId is already
-- nullable to allow exactly that.
CREATE UNIQUE INDEX "return_requests_orderItemId_key" ON "return_requests"("orderItemId");

-- One refund per request, so an approval cannot credit twice.
CREATE UNIQUE INDEX "return_requests_refundId_key" ON "return_requests"("refundId");

-- The buyer's own list, newest first.
CREATE INDEX "return_requests_buyerId_createdAt_idx" ON "return_requests"("buyerId", "createdAt");

-- The seller and moderator queues: everything still awaiting an answer.
CREATE INDEX "return_requests_status_createdAt_idx" ON "return_requests"("status", "createdAt");

CREATE INDEX "return_requests_orderId_idx" ON "return_requests"("orderId");

ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
