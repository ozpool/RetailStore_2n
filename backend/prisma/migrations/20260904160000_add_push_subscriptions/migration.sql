-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Unique on the endpoint, not on (userId, endpoint).
--
-- A push endpoint identifies one browser profile, and it can move between
-- accounts: somebody signs out and a colleague signs in on the same laptop. The
-- second subscribe must MOVE the row, not add a second one — otherwise the
-- first account keeps receiving notifications on a browser it no longer owns,
-- which is a privacy failure rather than a duplicate.
--
-- Scoping the constraint per user would allow exactly that.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
