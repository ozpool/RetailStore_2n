-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totpConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "totpSecret" TEXT;
