-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Three columns, not one, because they answer three different questions:
-- what the number is, whether it has been proven, and whether the person
-- agreed to be texted on it.
--
-- Collapsing them into "phone TEXT" and treating non-null as permission is the
-- shortcut this schema will not take. A number can be present and unproven
-- (someone typed it and abandoned the code), or proven and withdrawn (they
-- verified, then turned SMS off). Both are ordinary, and only separate columns
-- can express them.
--
-- NOTHING BACKFILLS FROM addresses.phone. That column is a delivery contact
-- for a parcel — unverified, and frequently a third party's number. Copying it
-- here would launder an unverified number into a verified one, and would text
-- people who never consented and cannot unsubscribe.
-- See docs/adr/0027-notification-consent-and-preferences.md
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- The number being verified lives on THIS row, not on users, until the code
-- comes back. An unverified number sitting in users.phone would be one bug
-- away from being messaged, and the whole point of phoneVerifiedAt is that no
-- such bug can exist.
--
-- codeHash rather than the code, for the same reason every other token in this
-- schema is hashed: a code readable from a database dump is a code usable from
-- one. attempts caps guessing against a single six-digit code, which — unlike
-- a 32-byte token — is genuinely guessable in a few thousand tries.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "phone_verifications_userId_createdAt_idx" ON "phone_verifications"("userId", "createdAt");

-- ---------------------------------------------------------------------------
-- UNIQUE on users.phone, and it is a trade rather than an obvious win.
--
-- What it buys: one number cannot verify unlimited accounts. A verified phone
-- is only an identity signal if it is scarce, and without this it is not.
--
-- What it costs: a number held by a suspended account cannot be reused by its
-- owner on a new one. That is a support ticket, which is the cheaper of the
-- two failures. Postgres permits many NULLs in a unique index, so every
-- account without a number is unaffected.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- AddForeignKey
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
