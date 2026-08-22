-- CreateTable
CREATE TABLE "kyc_attempts" (
    "id" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "documentType" TEXT,
    "country" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "kyc_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_attempts_providerSessionId_key" ON "kyc_attempts"("providerSessionId");

-- CreateIndex
CREATE INDEX "kyc_attempts_sellerProfileId_idx" ON "kyc_attempts"("sellerProfileId");

-- AddForeignKey
ALTER TABLE "kyc_attempts" ADD CONSTRAINT "kyc_attempts_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
