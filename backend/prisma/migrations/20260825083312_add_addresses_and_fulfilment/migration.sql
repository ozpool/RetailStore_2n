-- CreateEnum
CREATE TYPE "FulfilmentStatus" AS ENUM ('UNFULFILLED', 'SHIPPED', 'DELIVERED', 'UNFULFILLABLE');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "fulfilment" "FulfilmentStatus" NOT NULL DEFAULT 'UNFULFILLED',
ADD COLUMN     "fulfilmentNote" TEXT,
ADD COLUMN     "sellerId" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "trackingNumber" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "shipToCity" TEXT,
ADD COLUMN     "shipToCountry" TEXT,
ADD COLUMN     "shipToLine1" TEXT,
ADD COLUMN     "shipToLine2" TEXT,
ADD COLUMN     "shipToName" TEXT,
ADD COLUMN     "shipToPhone" TEXT,
ADD COLUMN     "shipToPostcode" TEXT,
ADD COLUMN     "shipToRegion" TEXT;

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "postcode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "addresses_userId_idx" ON "addresses"("userId");

-- CreateIndex
CREATE INDEX "order_items_sellerId_fulfilment_idx" ON "order_items"("sellerId", "fulfilment");

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
