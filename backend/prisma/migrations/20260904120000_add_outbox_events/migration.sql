-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- ---------------------------------------------------------------------------
-- ADDED BY HAND. Prisma cannot express a partial index, the same way it cannot
-- express the `WHERE status = 'HELD'` constraint on reservations.
--
-- The relay reads exactly one query, forever:
--
--   SELECT ... FROM outbox_events
--   WHERE "publishedAt" IS NULL ORDER BY "createdAt"
--   LIMIT n FOR UPDATE SKIP LOCKED
--
-- The composite index above degrades badly for it. Within weeks the published
-- rows outnumber the pending ones by orders of magnitude, and the planner is
-- scanning an index almost entirely composed of rows the query excludes.
--
-- This one contains ONLY the unpublished rows. It stays roughly the size of the
-- backlog rather than the size of the table, and rows drop out of it as they are
-- published rather than accumulating. On a healthy system it holds single digits.
-- ---------------------------------------------------------------------------
CREATE INDEX "outbox_events_unpublished_idx"
    ON "outbox_events"("createdAt")
    WHERE "publishedAt" IS NULL;
