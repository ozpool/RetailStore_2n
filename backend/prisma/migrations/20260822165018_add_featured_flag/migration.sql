-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "featured" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "listings_featured_idx" ON "listings"("featured");
